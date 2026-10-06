// Stations: free-placed rail stations (on the ground, elevated on a viaduct, or underground) with platform edges,
// bus / tram stops on road edges, catchment areas per mode, road access and entrances, transfer complexes
// (stations merged into one, or linked for walking transfers), station names, and rebuilding / relocating.
import type { Game } from './game';
import { RAIL, ROAD_TYPES, WATER_Y, TRACK_TYPES, trackTypeOf } from './constants';
import { bezLine, bezPoint } from './geom';
import { NEdge, Section } from './network';
import { applyEarthworks, repairFormations, EARTHWORKS, LOCK, DRY_MIN } from './terraform';
import { distToRect, Building } from './world';
import { rectsOverlap, Town, FLOOR_H } from './towns';
import { hash2 } from './rng';
import { planEdge, commitProposal, Snap, Proposal } from './construction';
import { growThroat, throatFree, holdThroat, releaseHold, WORKS_HOLD } from './trackops';
import { autoSignalLine } from './signals';
import { STATION_STYLES, styleOf, CONCOURSE_PAVILION, stationCrossings } from './station-styles';
import type { StationBuildingStyle, StylePlacement } from './station-styles';
import { simNow, transferWalkTime, fareGroupKey, railHistory, changeClass } from './fares';
import { cargoGroups } from './vehicle';
import { WALK_DETOUR, walkingCatchment, readWalkingCatchment, prepareWalkingCatchment, fullWalkingCatchments, refreshWalkBuildings, walkRoadsChanged, pedestrianRoad, walkableStreetNear, walkWeight, coverOf, walkClaimShares, type WalkingCatchment } from './catchment';
import { addMail, trimMail, rerouteMail, absorbMail, settleMail, newJourney, type StationMail, type MailJourney } from './mail';
import { demolitionCost, demolitionTotal } from './demolition';
import { depotVolume } from './build-ops';
import { stationPose, stationLocal, stationStripRects } from './station-geometry';
import type { RailStationAlignment, RailTrackGroup, RailTrackStep, StationGeometry } from './station-geometry';
export type { RailTrackGroup, RailTrackStep } from './station-geometry';

/**
 * Passengers waiting for `line` to `alight` on their way to `dest`. `t`: sim time (s) they started waiting
 * (weighted mean; fares.ts simNow), `transfers`: the changes of vehicle they made on this journey so far, in all
 * (transfers / count each; each change takes 10% off the leg ending in it and every later leg, fares.ts
 * TRANSFER_FARE_FACTOR). A group's passengers share their fare history and change class (fares.ts fareGroupKey).
 */
export interface WaitGroup {
  line: number; alight: number; dest: number; count: number; t?: number; transfers?: number;
  /** the distance fares (per passenger) of the journey's rail legs so far: the rail minimum is paid once per journey */
  rail?: number;
}

export interface Rect { x: number; z: number; angle: number; w: number; d: number }

/** Occupied platform box, used for prospective and existing underground stations alike. */
function undergroundStationVolume(rect: Rect, y: number) { return { ...rect, y0: y - 0.4, y1: y + 1.1 }; }

export type StationLevel = 'ground' | 'elevated' | 'underground';
/** Platform upkeep by level, independent of station style and overhead wire. */
export const STATION_UPKEEP_FACTOR = { ground: 1, elevated: 2, underground: 4 };
/**
 * Construction style of a rail station, independent of overhead wire: main line, metro
 * (subway style: underground with entrances, screen doors) or light rail (close-spaced halts). Only construction
 * defaults follow it (level, platforms, building, spacing); every rail station is one transport mode, 'rail'.
 */
export type RailMode = 'mainline' | 'metro' | 'lightrail';
/** Construction style of a station: its rail style, else 'tram' (a stop on tram tracks) or 'bus'. */
export type StationMode = RailMode | 'tram' | 'bus';
/** Walking catchment modes: every rail station (any track type), tram stops, bus stops. */
export type CatchMode = 'rail' | 'tram' | 'bus';
/** Side platforms (outside the tracks, which keep the plain double-track spacing) or island platforms between them. */
export type PlatformStyle = 'island' | 'side';

/**
 * Nominal walking limit per mode (units, 1 = 10 m): half of release 2.9's limits. Rail is one mode:
 * main-line, metro and light-rail stations walk alike. catchment.ts applies the
 * street-grid allowance (and building bonuses) and measures paths along streets from forecourts, entrances and stops.
 */
export const CATCHMENT_RADIUS: Record<CatchMode, number> = { rail: 11.76, tram: 10.78, bus: 7.84 };
/**
 * In-city metro and light-rail stations walk half as far: a station of metro or light-rail style (railPartMode)
 * standing in a town (Station.city) gets this share of the rail walking limit (and of its building's bonus), at its
 * forecourts, entrances and the rail access of its stops: a quarter of the area. Walks stay physical: every station
 * shares buildings and covers them by one curve of the walk (catchment.ts walkWeight / coverOf: full coverage within
 * FULL_COVER_WALK, then tapering), so the smaller in-city reach is wholly fully covered and simply
 * cuts off the taper beyond; trips per building never depend on a station's type. Main-line-style stations, and
 * metro or light-rail stops out in the country, keep the full reach.
 */
export const CITY_WALK_SCALE = 0.5;
/** Intermediate interchange walks use half the standard endpoint street budget, without changing catchment coverage. */
export function transferWalkLimit(g: Game, a: Station, b: Station): number {
  return 0.5 * WALK_DETOUR * Math.min(g.stations.catchmentRadius(a), g.stations.catchmentRadius(b));
}
/**
 * When a station stands in a town (Stations.cityAt): its town has at least `pop` residents and the station's centre
 * lies within `core` x the town's compact core radius (Towns.maxRadius); once in town, a station keeps that until its
 * town falls below `leavePop` or it lies beyond `leaveCore` x the radius. Decided when the station is built and at
 * every month end, saved with the station: buildings coming and going never make it flicker between the two reaches.
 */
export const CITY_STATION = { pop: 3000, core: 1, leavePop: 2600, leaveCore: 1.15 };
/**
 * Walking scale of a station's rail part (1, or CITY_WALK_SCALE for an in-city metro / light-rail station). The rail
 * access points of the station (forecourts, entrances, its stops' way to the platforms) all walk at this scale; its
 * bus and tram stops keep their own reach.
 */
export function railWalkScale(st: { rail: RailPart | null; city?: boolean }): number {
  // (the part's style decides, railPartMode: never the track type itself)
  return st.rail && st.city && railPartMode(st.rail) !== 'mainline' ? CITY_WALK_SCALE : 1;
}
/** Walking scale of a planned rail station (StationPlan.city: an in-city metro / light-rail station walks half as far). */
export function planWalkScale(plan: { mode: RailMode; city?: boolean }): number {
  return plan.city && plan.mode !== 'mainline' ? CITY_WALK_SCALE : 1;
}
/** Legacy reach metadata for site scoring; passenger coverage uses catchment.ts. */
export interface CatchShape { x: number; z: number; r: number; mode: CatchMode; active: boolean }
/** Default platform length of a new rail station (units; 80 m: a loco and two or three coaches). */
export const DEFAULT_PLATFORM_LENGTH = 8;
/** Default platform length per rail mode (units): main line, metro (a 6-car EMU), light rail (two coupled LRVs). */
export const PLATFORM_LENGTH: Record<RailMode, number> = { mainline: DEFAULT_PLATFORM_LENGTH, metro: 12, lightrail: 7 };
/** Legacy track style (also accepts a station mode); unknown ids mean main line. */
export function railModeOf(trackType?: string): RailMode {
  return trackType === 'metro' || trackType === 'lightrail' ? trackType : 'mainline';
}
/** Default platform length for a station on track of this type. */
export function defaultPlatformLength(trackType?: string): number { return PLATFORM_LENGTH[railModeOf(trackType)]; }
/** Station types in messages (railPartMode). */
const STYLE_WORD: Record<RailMode, string> = { mainline: 'main-line', metro: 'metro', lightrail: 'light-rail' };
/** Walking range between the platforms / stops of two stations of a transfer complex (merge or link). */
export const TRANSFER_RANGE = 14;
/**
 * Walking range of a link between two stations in one town's core, one of them an in-city metro / light-rail station
 * (citycatch, Stations.linkRange): near city stations become one interchange, its passage under the street a little
 * longer than an ordinary transfer walk. They stay two stations of one complex; the walk costs its length.
 */
export const CITY_TRANSFER_RANGE = 24;
/** Days of service history a station keeps (Station.callDays): its service frequency is the share of them with a call (Stations.callShare). */
export const CALL_DAYS = 30;
const CALL_MASK = 2 ** CALL_DAYS - 1;
/** Older saves (no history): a station a vehicle has called at starts from three calls in the last 30 days. */
const OLD_SAVE_CALLS = 1 | (1 << 10) | (1 << 20);
/**
 * Station rating: lowered by up to this much when every passenger gives up waiting (in proportion to lostShare). The
 * rating scales a station's passenger generation (as OpenTTD's does): where queues overflow, fewer set out.
 */
export const RATING_LOST = 0.6;
/** Share of a station's passengers who gave up waiting rather than board (this and last month), 0..1. */
export function lostShare(st: Station): number {
  const lost = (st.lostMonth || 0) + (st.lostLast || 0);
  return lost > 0 ? lost / (lost + st.pickupMonth + st.pickupLast) : 0;
}
/**
 * Automatic walking links when a station is built, by construction style: close-spaced urban-style stations (metro
 * / light-rail track) link to stations of the same style only when (nearly) touching (dense lines: neighbouring
 * stops are no interchange), to other styles within `urban` (hubs: a subway-style station under a main-line
 * station, a bus stop at the entrance); others within TRANSFER_RANGE. Consecutive stops of a line are never linked
 * automatically.
 */
export const AUTO_LINK_RANGE = { sameUrban: 4, urban: 10 };
/** Auto-link range between stations of two modes (see AUTO_LINK_RANGE). */
export function autoLinkRange(a: StationMode, b: StationMode): number {
  const urban = (m: StationMode) => m === 'metro' || m === 'lightrail';
  if (urban(a) && a === b) return AUTO_LINK_RANGE.sameUrban;
  if (urban(a) || urban(b)) return AUTO_LINK_RANGE.urban;
  return TRANSFER_RANGE;
}
/** A new bus / tram stop this close to an own rail station's structures becomes part of that station. */
export const STOP_JOIN = 8;
/** Rail parts merge into one when their axes differ by at most this (radians, ~8 degrees); up to ~1.5 degrees they are united as they lie. */
const MERGE_TILT = (8 * Math.PI) / 180, MERGE_TILT_ADOPT = (1.5 * Math.PI) / 180;
/** Pseudo line id of a walking transfer between linked stations in routing hops (never a waiting group's line). */
export const WALK_LINE = -1;
/** Street-level entrance footprints: underground entrance pavilions and elevated stair / lift towers. */
export const ENTRANCE_SIZE = { underground: { w: 0.7, d: 1.1 }, elevated: { w: 0.8, d: 0.8 } };
export const ENTRANCE_COST = { underground: 90_000, elevated: 60_000 };
/** Entrances lie within this distance of the platform area. */
export const ENTRANCE_REACH = 25;

/**
 * Kinds of station entrance (Entrance.kind). Stations below or above the street: an entrance 'pavilion'
 * (underground) or a stair / lift 'tower' (elevated) beside a road. Ground stations, beside the track area: a
 * side entrance 'hall' (a small booking hall, an underpass to every platform), a 'footbridge' or an 'underpass'
 * across the tracks (stairs to every platform and down to the street on each side where there is room), or a
 * 'gate' at a platform end (a ramp, ticket machine and gate; an underpass where tracks lie in between).
 */
export type EntranceKind = 'pavilion' | 'tower' | 'hall' | 'footbridge' | 'underpass' | 'gate';
/** The kinds of entrance a ground station can add. */
export const GROUND_ENTRANCES: readonly EntranceKind[] = ['hall', 'footbridge', 'underpass', 'gate'];
export interface EntranceType {
  name: string; desc: string;
  /** street-level structure (each landing): width along its street side, depth towards the street */
  w: number; d: number;
  /** price: a fixed part plus one per unit of the track area's width (ground stations: the way across) */
  cost: number; perWidth: number;
  /** yearly upkeep */
  upkeep: number;
  /** ground stations: how far the ground at the entrance may lie above or below the platforms */
  rise: number;
  /** footbridge / underpass: stairs down to the street on both sides of the tracks */
  twoSided: boolean;
}
export const ENTRANCE_TYPES: Record<EntranceKind, EntranceType> = {
  pavilion: { name: 'Entrance pavilion', desc: 'Roadside pavilion; stairs down to platforms', w: 0.7, d: 1.1, cost: 90_000, perWidth: 0, upkeep: 4_000, rise: 0, twoSided: false },
  tower: { name: 'Stair tower', desc: 'Roadside hall; stairs and lift to platforms', w: 0.8, d: 0.8, cost: 60_000, perWidth: 0, upkeep: 3_000, rise: 0, twoSided: false },
  hall: { name: 'Side entrance', desc: 'Side booking hall; underpass to all platforms', w: 1.1, d: 0.7, cost: 55_000, perWidth: 6_000, upkeep: 3_000, rise: 0.8, twoSided: false },
  footbridge: { name: 'Footbridge', desc: 'Covered bridge; stairs to all platforms and both streets', w: 0.55, d: 0.55, cost: 30_000, perWidth: 12_000, upkeep: 2_500, rise: 1.5, twoSided: true },
  underpass: { name: 'Underpass', desc: 'Underpass; stairs to all platforms and both streets', w: 0.6, d: 0.8, cost: 40_000, perWidth: 16_000, upkeep: 2_000, rise: 1.0, twoSided: true },
  gate: { name: 'Platform-end gate', desc: 'Platform-end ramp, gate and ticket machine', w: 0.8, d: 0.5, cost: 18_000, perWidth: 4_000, upkeep: 1_000, rise: 0.6, twoSided: false },
};
/** Ground entrances: the gap between the track area and an entrance, and the least room between two of them along the platforms. */
const ENTRANCE_GAP = 0.15, ENTRANCE_SPACING = 1.0;
/**
 * Along the platforms, how far a crossing's structures reach either side of where its stairs meet them: an added
 * footbridge's deck and the stair enclosures beside it, other entrances' stair wells; the station's own footbridge
 * (deck and stair blocks, from `own.footbridge` - 0.15 to + 0.45) and underpass stairs; and the least gap between two.
 */
const CROSSING_HALF = { footbridge: 0.75, stairs: 0.3, ownStairs: 0.25 }, CROSSING_GAP = 0.1;
/** A ground entrance's stairs keep this far inside the platform ends; a gate's stairs lie this far in from its end. */
const ENTRANCE_END = 0.7, GATE_STAIRS = 0.75;
/** An access street ends this far in front of an entrance's street side (within the landing's road reach)... */
const ENTRANCE_DOOR = 0.75;
/** ...and leads to a road within this distance on the entrance's side of the tracks. */
const ENTRANCE_STREET = 16;
/** Underground platforms this far below the lowest ground above them (default), elevated decks this high. */
export const STATION_DEPTH = { min: 1.5, max: 4, def: 2.6, metro: 2.2 };
export const STATION_HEIGHT = { min: 1.2, max: 3, def: 1.5 };
/** The forecourt (where the access street ends) lies this far out from the station building's street side. */
const FORECOURT = 0.85;
/** An access street is planned to roads within this distance of a ground station's forecourt. */
const ACCESS_REACH = 40;
/** Price of a station building of cost factor 1 (a 'classic' building; styles scale it). */
const BUILDING_BASE = 60000;
/** Style 'none': the ramp pad beside a platform end, and how far a road may be from its foot. */
const NO_BUILDING_PAD = { w: 0.8, d: 0.5 };
const NO_BUILDING_REACH = 1.6;
/** Height of a style's ground structures above the platforms (for clearance checks). */
const styleHeight = (s: StationBuildingStyle) => (s.placement === 'none' ? 0.4 : s.id === 'shelter' ? 0.9 : s.placement === 'end' ? 1.8 : 1.4);
/** A site for a station's passenger building while planning: the building, its forecourt(s), what it demolishes. */
interface BuildingCand { b: Rect; fc: { x: number; z: number }; fc2?: { x: number; z: number }; dem: Set<number>; score: number; road: number; end?: number }
/** Cost of a walking transfer: base + per unit walked (the line graph adds its transfer penalty on top). */
const WALK_BASE = 6, WALK_PER_UNIT = 2;

/**
 * A street-level entrance (underground pavilion / elevated stair tower, or a ground station's side hall, footbridge,
 * underpass or platform-end gate beside the track area); forward (sin a, cos a) faces the street.
 */
export interface Entrance {
  x: number; z: number; angle: number;
  /** what it is (missing: the level's own kind, as built with the station) */
  kind?: EntranceKind;
  /** footbridge / underpass: its stairs on the other side of the tracks (missing: one side only) */
  far?: { x: number; z: number; angle: number };
  /** what it cost (entrances added to a built station: they carry upkeep and asset value) */
  cost?: number;
}

/** The kind of an entrance (older or planned ones: their level's own). */
export function entranceKind(level: StationLevel, e: Entrance): EntranceKind {
  if (e.kind && ENTRANCE_TYPES[e.kind]) return e.kind;
  return level === 'elevated' ? 'tower' : level === 'underground' ? 'pavilion' : 'hall';
}
/** Street-level structures of an entrance: itself and, for a two-sided crossing, its stairs across the tracks. */
export function entranceLandings(e: Entrance): { x: number; z: number; angle: number }[] { return e.far ? [e, e.far] : [e]; }
/** A landing's rectangle. */
export function landingRect(kind: EntranceKind, p: { x: number; z: number; angle: number }): Rect {
  const T = ENTRANCE_TYPES[kind];
  return { x: p.x, z: p.z, angle: p.angle, w: T.w, d: T.d };
}
/** A road this close to a landing's centre gives it access (as for underground entrance pavilions). */
export function landingReach(kind: EntranceKind): number { return ENTRANCE_TYPES[kind].d / 2 + 0.9; }
/** Where an access street to a landing ends: in front of its street side. */
export function landingDoor(kind: EntranceKind, p: { x: number; z: number; angle: number }): { x: number; z: number } {
  const k = ENTRANCE_TYPES[kind].d / 2 + ENTRANCE_DOOR;
  return { x: p.x + Math.sin(p.angle) * k, z: p.z + Math.cos(p.angle) * k };
}
/** Price of an entrance of a kind at a station (ground stations: by the width of the track area it crosses). */
export function entranceCost(kind: EntranceKind, r: RailPart | null): number {
  const T = ENTRANCE_TYPES[kind];
  return Math.round((T.cost + T.perWidth * (r && (r.level ?? 'ground') === 'ground' ? railWidth(r) : 0)) / 1000) * 1000;
}
/** Yearly upkeep of a station's added entrances (those built with the station are part of its own upkeep). */
export function entranceUpkeep(r: RailPart | null): number {
  let c = 0;
  for (const e of r?.entrances ?? []) if (e.kind && ENTRANCE_TYPES[e.kind]) c += ENTRANCE_TYPES[e.kind].upkeep;
  return c;
}
/** Ground stations: where an entrance's stairs meet the platforms, along the axis from the centre. */
export function entranceAlong(r: RailPart, e: Entrance): number {
  const a = stationLocal(r, e.x, e.z).along;
  if (entranceKind(r.level ?? 'ground', e) !== 'gate') return a;
  return (a >= 0 ? 1 : -1) * Math.max(0, r.length / 2 - GATE_STAIRS);
}
/** Ground stations: the side of the tracks an entrance stands on (+1 right of the axis, -1 left). */
export function entranceSide(r: RailPart, e: { x: number; z: number }): 1 | -1 {
  return stationLocal(r, e.x, e.z).off >= 0 ? 1 : -1;
}
/** Where a station's entrances stand (cache keys). */
function entranceKey(r: RailPart): string {
  let k = '';
  for (const e of r.entrances ?? []) k += `${e.x},${e.z},${e.angle},${e.kind ?? ''},${e.far ? `${e.far.x},${e.far.z}` : ''};`;
  return k;
}

/**
 * What rebuilding a ground station in place (or merging two) does to one of its added entrances: 'stays' where it
 * stood, 'moves' along the platforms, 'street' moves and gets a new access street, or goes: 'room' (no room beside
 * the new track area) or 'cut' (no street reaches it there, and a new one would not be cheap).
 */
export type EntranceFate = 'stays' | 'moves' | 'street' | 'room' | 'cut';
/** A rebuild's effect on a ground station's added entrances (Stations.refitEntrances, previewed by planUpgrade). */
export interface EntranceRefit {
  /** per entrance, in order: its kind, its fate, and whether a crossing loses its stairs across the tracks or the
   * street there (its own side's keeps its street, or it goes) */
  fates: { kind: EntranceKind; fate: EntranceFate; lostFar?: boolean; farCut?: boolean }[];
  /** price of the new access streets */
  streets: number;
}
/** An entrance a rebuilt station's walkers no longer reach gets a new access street up to this share of its price. */
const ENTRANCE_RECONNECT = 0.5;
/** Places tried along the platforms when a rebuilt station's entrance no longer fits where it stood. */
const REFIT_SHIFTS = [0, 0.25, -0.25, 0.5, -0.5, 0.75, -0.75, 1, -1, 1.25, -1.25, 1.5, -1.5];

/**
 * Warning for a station's added entrances that a rebuild, move or re-level takes down: "Its added footbridge goes
 * (why)", "Its 2 added entrances go (why)" (null: none). Their price leaves the station's value, their upkeep stops.
 */
export function entrancesGo(level: StationLevel, entrances: Entrance[], why: string): string | null {
  const added = entrances.filter((e) => e.kind);
  if (!added.length) return null;
  const what = added.length === 1 ? `added ${ENTRANCE_TYPES[entranceKind(level, added[0])].name.toLowerCase()} goes` : `${added.length} added entrances go`;
  return `Its ${what} (${why})`;
}
/** Warnings for what a rebuild in place does to a ground station's added entrances (see EntranceRefit). */
export function refitWarnings(f: EntranceRefit | null | undefined): string[] {
  const out: string[] = [];
  for (const x of f?.fates ?? []) {
    const n = `Its added ${ENTRANCE_TYPES[x.kind].name.toLowerCase()}`;
    if (x.fate === 'room') out.push(`${n} removed: no room beside new platforms`);
    else if (x.fate === 'cut') out.push(`${n} removed: no street beside new platforms`);
    else if (x.fate === 'street') out.push(`${n} moves along platforms; new access street`);
    if (x.fate === 'room' || x.fate === 'cut') continue;
    if (x.lostFar) out.push(`${n} loses stairs across tracks`);
    else if (x.farCut) out.push(`${n} loses street across tracks`);
  }
  return out;
}

export interface RailPart {
  x: number; z: number; y: number;
  /** axis direction (radians): tracks run along (sin a, cos a) */
  angle: number;
  length: number;
  tracks: number;
  /** lateral offsets of tracks and platforms (right of axis = positive, right = (cos a, -sin a)) */
  trackOffsets: number[];
  /** platforms: lateral offset and width; `from` / `to` along the axis from the centre when not the full length (merged stations) */
  platforms: { off: number; w: number; from?: number; to?: number }[];
  /** platform track edges (station === this station's id) */
  edges: number[];
  /** through tracks (no platform): how many, their lateral offsets, and their edges (ordinary rail edges, station === -1) */
  through: number;
  throughOffsets: number[];
  throughEdges: number[];
  /** Mounted on retained rail: exact geometry and stable physical platform/through groups. */
  alignment?: RailStationAlignment;
  groups?: RailTrackGroup[];
  /** Removing the facility leaves the inherited running rail in place. */
  native?: boolean;
  /** width of the track area (platform and through tracks) */
  width: number;
  /** where the through tracks lie */
  throughMode?: ThroughMode;
  /** Platform wire state (standard / electric). */
  trackType: string;
  /** Station construction style; older saves fall back to their legacy track type. */
  mode?: RailMode;
  /** side platforms (outside the tracks) instead of islands between them */
  platformStyle?: PlatformStyle;
  /** platform screen doors (metro stations by default) */
  psd?: boolean;
  /**
   * building style (station-styles.ts STATION_STYLES id; missing / unknown: 'classic'). Where `building` lies
   * follows the style's placement: 'side' beside the platforms (as before), 'over' a concourse across the tracks
   * (w along the tracks, d across them and both entrance pavilions), 'end' across the buffer ends (w across,
   * d along the axis), 'none' a small ramp pad beside a platform end.
   */
  style?: string;
  /** ground, style 'over': the forecourt on the other side of the tracks (either gives road access) */
  forecourt2?: { x: number; z: number };
  /** ground: the station building; elevated / underground: the first entrance (kept for older code) */
  building: Rect;
  /** 'ground', 'elevated' (viaduct: platform edges carry a full-length bridge section) or 'underground' (tunnel section) */
  level: StationLevel;
  underground: boolean;
  /** underground: platform level below the lowest ground above the station (else 0) */
  depth: number;
  /** elevated: deck level above the highest ground beneath (else 0) */
  height: number;
  /** underground entrance pavilions / elevated stair towers at street level */
  entrances: Entrance[];
  /** elevated: viaduct columns */
  piers: { x: number; z: number }[];
  /** ground: the street side of the station building, where the access road ends */
  forecourt?: { x: number; z: number };
  /** what the station cost to build (asset value) */
  cost?: number;
}

export interface BusStop { edge: number; s: number; x: number; z: number }

/** Platform use of a station (stationCapacity): what it handles, and how it should grow when the gameplay needs it. */
export interface StationCapacity {
  station: number;
  platforms: number; through: number; length: number;
  /** rolling share of the platform tracks occupied or reserved by trains (0..1, about a month) */
  occupancy: number;
  /** trains waiting now for a way into the station (held at signals before it) */
  waitingTrains: number;
  /** lines stopping here (all companies) */
  lines: number;
  /** trains calling (rolling; per game day and per game hour) */
  trainsPerDay: number; trainsPerHour: number;
  /** trains passing on the platform tracks without stopping (rolling, per day) */
  passingPerDay: number;
  /** longest train of the lines stopping here (units) */
  longestTrain: number;
  /** a terminus (no track beyond one end) */
  terminus: boolean;
  /** what to grow to, or null when it is big enough; why */
  recommended: { tracks: number; through: number; length: number } | null;
  reason: string;
}

/** A station track a train can pass the station on without stopping (Stations.passTracks). */
export interface PassTrack {
  /** a representative edge of the track, and all its edges (a track split by a signal has several) */
  edge: number; edges: number[];
  /** end nodes in travel order */
  entry: number; exit: number;
  /** a through track (no platform) */
  through: boolean;
  /** no train on it now */
  free: boolean;
}

export interface Station {
  id: number;
  name: string;
  owner: number;
  townId: number;
  x: number; z: number;
  rail: RailPart | null;
  stops: BusStop[];
  waiting: Map<string, WaitGroup>;
  waitingTotal: number;
  rating: number;
  lastPickup: number;
  lastSpeed: number;
  catchPop: number;
  genAccum: number;
  genMonth: number; genLast: number;
  pickupMonth: number; pickupLast: number;
  arrivedMonth: number; arrivedLast: number;
  /** passengers who gave up waiting (the queue outgrew the station: trimWaiting), this and last month */
  lostMonth: number; lostLast: number;
  /** day a vehicle last called (stopped) at the station; -1 before the first call (unlike lastPickup, not the day it was built) */
  lastCall: number;
  /** days of the last CALL_DAYS on which a vehicle called, bit k: k + 1 days ago (updateRatings; Stations.callShare) */
  callDays: number;
  built: number;
  /** stations linked for walking transfers (a transfer complex), both ways */
  links: number[];
  /** can passengers reach the station? (rail: a road at the forecourt / an entrance, or a stop of the station) */
  roadAccess: boolean;
  /** rolling platform figures (Stations.daily): share of platform tracks occupied, trains calling / passing per day, trains on the platforms */
  occ?: number; tpd?: number; ppd?: number; onPlat?: number[];
  /** mail: queues, rating and monthly figures (mail.ts), from the station's first mail or mail vehicle on */
  mail?: StationMail;
  /**
   * a metro / light-rail style station standing in a town (CITY_STATION; decided when built and at month ends, kept
   * through rebuilds): it walks CITY_WALK_SCALE as far (railWalkScale). Unset for main-line stations and stops.
   */
  city?: boolean;
}

/** Collision rectangle of a station structure with its vertical extent (y0..y1), what it is and (entrances) which one. */
export interface Footprint extends Rect { y0?: number; y1?: number; part?: 'platforms' | 'building' | 'entrance' | 'deck' | 'pier'; entrance?: number }
/** A station structure's volume (for clearance checks). */
interface Volume extends Rect { y0: number; y1: number; part: 'platforms' | 'building' | 'entrance' | 'deck' | 'pier'; entrance?: number }

/** Station names after places in town, by where the station is: core, inner streets, edge, waterside, hill. */
const PLACE_NAMES: Record<'core' | 'inner' | 'edge' | 'water' | 'hill', string[]> = {
  core: ['Market', 'Town Hall', 'Cathedral', 'High Street', 'Exchange', 'Arcade', 'Museum', 'Library', 'Old Town', "Queen's Square",
    "King's Road", 'Guildhall', 'Theatre', 'Clock Tower', 'Corn Exchange', 'Castle', 'Abbey', 'Minster', 'Royal Square', 'Opera House',
    'City Hall', 'Cloth Hall', 'Assembly Rooms', 'Market Cross', 'Old Bank', 'Corn Market', 'Butter Cross', 'Moot Hall'],
  inner: ['Church Road', 'Station Road', 'Mill Lane', 'Hospital', 'University', 'College', 'Brewery', 'Gasworks', 'Barracks', 'Stadium',
    'Foundry', 'Victoria Road', 'Albert Street', 'Chapel Street', 'Infirmary', 'School Lane', 'Post Office', 'Bank Street', 'Tannery',
    'Ropewalk', 'Mint', 'Courthouse', 'Arsenal', 'Cattle Market', 'Hay Market', 'Baths', 'Workhouse', 'Almshouses', 'Printworks',
    'Waterworks', 'Ironworks', 'Malthouse', 'Drill Hall', 'Tram Depot', 'Fire Station'],
  edge: ['Park', 'Gardens', 'Fields', 'Common', 'Green', 'Meadows', 'Orchard', 'Woodside', 'Gate', 'Grange', 'Manor', 'Cemetery',
    'Allotments', 'Brook', 'Lane End', 'Farm', 'Heath', 'Moor', 'Wood', 'Pastures', 'Parkway', 'Mill', 'Racecourse', 'Showground',
    'Golf Links', 'Copse', 'Spinney', 'Windmill', 'Toll Gate', 'Turnpike', 'Hollow', 'Paddocks', 'Leas', 'Warren'],
  water: ['Harbour', 'Riverside', 'Quay', 'Wharf', 'Docks', 'Waterfront', 'Embankment', 'Ferry', 'Lock', 'Marina', 'Strand', 'Pier',
    'Boatyard', 'Weir', 'Bridge', 'Lighthouse', 'Basin', 'Landing', 'Promenade', 'Esplanade', 'Seafront', 'Mill Race', 'Ford'],
  hill: ['Heights', 'Hill', 'Upper Town', 'Ridge', 'Terrace', 'Summit', 'Mount', 'Belvedere', 'Highfield', 'Crest', 'Brow', 'Top',
    'Hillside', 'Prospect', 'Overlook', 'Beacon', 'Tor'],
};
/** Further landmarks, and street names built from two parts (hundreds of names before numbers are needed). */
const LANDMARKS = ['Junction', 'Cross', 'Square', 'Parade', 'Circus', 'Crescent', 'Walk', 'Court', 'Yard', 'Halt', 'Arches',
  'Viaduct', 'Interchange', 'Corner', 'Triangle', 'Precinct', 'Mews', 'Close', 'Plaza', 'Quarter', 'Village', 'Town', 'Exchange Place'];
const STREET_A = ['Elm', 'Oak', 'Ash', 'Beech', 'Birch', 'Cedar', 'Chestnut', 'Holly', 'Maple', 'Willow', 'Hawthorn', 'Linden', 'Victoria',
  'Albert', 'George', 'Princes', 'Queen', 'King', 'Duke', 'York', 'Clarence', 'Bridge', 'Church', 'Chapel', 'Market', 'Castle', 'Abbey',
  'Priory', 'Grove', 'Spring', 'Well', 'Bell', 'Crown', 'Rose', 'Lark', 'Swan', 'Fox', 'Hart', 'Garden', 'Meadow', 'Canal', 'Forge',
  'Kiln', 'Granary', 'Union', 'Waterloo', 'Trafalgar', 'Nelson', 'Wellington', 'Regent', 'Stone', 'Silver', 'Copper', 'North', 'South',
  'East', 'West', 'New', 'Old', 'Long'];
const STREET_B = ['Road', 'Street', 'Lane', 'Avenue', 'Way', 'Place', 'Hill', 'Row'];

export interface StationLayout {
  /** lateral offsets of the platform tracks (right of the axis = positive), left to right */
  trackOffsets: number[];
  /** lateral offsets of the through tracks (no platform), left to right */
  throughOffsets: number[];
  platforms: { off: number; w: number }[];
  /** width of the track area (platforms and through tracks) */
  width: number;
}

/** Where through tracks go: between the platform tracks ('middle': side platforms outside, e.g. p t T T t p) or outside the platform group ('outer', e.g. T t p t T). */
export type ThroughMode = 'middle' | 'outer';

/**
 * Station layout across the tracks (compact but realistic widths). Without through tracks: island platforms
 * between pairs of platform tracks (t p t, t p t t p t ...; one track: t p), or with `style` 'side' side
 * platforms outside the tracks (p t t p: the two tracks keep the plain double-track spacing, so a double-track
 * line runs straight in; metro and light-rail stops). With 1-2 through tracks: 'middle' puts them between the
 * platform tracks, which get side platforms (p t T T t p; p t T for one platform track), 'outer' keeps the island
 * layout and adds them outside (T t p t T).
 */
export function stationLayout(tracks: number, through = 0, mode: ThroughMode = 'middle', style: PlatformStyle = 'island'): StationLayout {
  const PW = 0.56, CL = 0.21; // platform width, platform edge to track centre
  type It = { kind: 't' | 'p' | 'T'; w: number };
  const islands = (n: number): It[] => {
    const out: It[] = [];
    for (let i = 0; i < n; i++) { out.push({ kind: 't', w: 0 }); if (i % 2 === 0) out.push({ kind: 'p', w: PW }); }
    return out;
  };
  /** platform tracks on one side of middle through tracks, outside in: a side platform when odd, then islands */
  const side = (k: number): It[] => {
    const out: It[] = [];
    if (k % 2) out.push({ kind: 'p', w: PW }, { kind: 't', w: 0 });
    for (let i = 0; i < Math.floor(k / 2); i++) out.push({ kind: 't', w: 0 }, { kind: 'p', w: PW }, { kind: 't', w: 0 });
    return out;
  };
  const T = Math.max(0, Math.min(2, Math.round(through)));
  const thr: It[] = Array.from({ length: T }, () => ({ kind: 'T' as const, w: 0 }));
  let items: It[];
  const sidePl = !T && style === 'side';
  if (sidePl) items = [...side(Math.ceil(tracks / 2)), ...side(Math.floor(tracks / 2)).reverse()];
  else if (!T) items = islands(tracks);
  else if (mode === 'outer') items = T === 2 ? [thr[0], ...islands(tracks), thr[1]] : [...islands(tracks), thr[0]];
  else items = [...side(Math.ceil(tracks / 2)), ...thr, ...side(Math.floor(tracks / 2)).reverse()];
  const pos: number[] = [];
  let x = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      if (prev.kind !== 'p' && it.kind !== 'p') x += sidePl ? RAIL.spacing : RAIL.spacing + 0.1;
      else if (it.kind === 'p') x += CL + it.w / 2;
      else x += prev.w / 2 + CL;
    }
    pos.push(x);
  }
  const mid = (pos[0] + pos[pos.length - 1]) / 2;
  const out: StationLayout = { trackOffsets: [], throughOffsets: [], platforms: [], width: pos[pos.length - 1] - pos[0] + 0.6 };
  items.forEach((it, i) => {
    if (it.kind === 't') out.trackOffsets.push(pos[i] - mid);
    else if (it.kind === 'T') out.throughOffsets.push(pos[i] - mid);
    else out.platforms.push({ off: pos[i] - mid, w: it.w });
  });
  return out;
}

/** Compact station building scaled to the platform length and number of tracks (w along the tracks, d across). */
export function stationBuildingSize(length: number, tracks: number): { w: number; d: number } {
  return { w: Math.min(3.6, Math.max(1.6, 1.2 + length * 0.12 + tracks * 0.2)), d: Math.min(1.3, 0.8 + tracks * 0.08) };
}

/** Width of a station's track area (older saves lack the stored width). */
export function railWidth(r: RailPart): number { return r.width || stationLayout(r.tracks, r.through ?? 0, r.throughMode, r.platformStyle).width; }

/** The layout of a built station (as stored: track, through-track and platform offsets, width). */
export function railLayout(r: RailPart): StationLayout {
  return { trackOffsets: r.trackOffsets, throughOffsets: r.throughOffsets ?? [], platforms: r.platforms, width: railWidth(r) };
}

/** Rail mode of a built station part. */
export const railPartMode = (r: RailPart): RailMode => r.mode === 'mainline' || r.mode === 'metro' || r.mode === 'lightrail' ? r.mode : railModeOf(r.trackType);

/**
 * Catchment circles of rail platforms: along the axis (both ends and between), so the area is measured from the
 * platforms; the radius is the rail walking limit (every rail station alike) with the building's bonus.
 */
export function railCatchShapes(x: number, z: number, angle: number, length: number, active = true, mode: CatchMode = 'rail', bonus = 0, scale = 1): CatchShape[] {
  const R = CATCHMENT_RADIUS[mode] * (1 + bonus) * scale, fx = Math.sin(angle), fz = Math.cos(angle);
  const n = length < 2 ? 1 : Math.max(3, Math.ceil(length / (R * 0.5)) + 1);
  const out: CatchShape[] = [];
  for (let i = 0; i < n; i++) {
    const a = n === 1 ? 0 : -length / 2 + (length * i) / (n - 1);
    out.push({ x: x + fx * a, z: z + fz * a, r: R, mode, active });
  }
  return out;
}

/** Catchment circle of a bus or tram stop. */
export function stopCatchShape(x: number, z: number, tram: boolean): CatchShape {
  return { x, z, r: tram ? CATCHMENT_RADIUS.tram : CATCHMENT_RADIUS.bus, mode: tram ? 'tram' : 'bus', active: true };
}

/** Distance between two oriented rectangles (0 if they overlap). */
function rectGap(a: Rect, b: Rect): number {
  if (rectsOverlap(a, b, 0)) return 0;
  let d = Infinity;
  for (const [p, q] of [[a, b], [b, a]] as [Rect, Rect][]) {
    const fx = Math.sin(p.angle), fz = Math.cos(p.angle), rx = fz, rz = -fx;
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = p.x + rx * (p.w / 2) * sa + fx * (p.d / 2) * sb, cz = p.z + rz * (p.w / 2) * sa + fz * (p.d / 2) * sb;
      d = Math.min(d, distToRect(cx, cz, q.x, q.z, q.angle, q.w / 2, q.d / 2));
    }
  }
  return d;
}

const angleOf = (fx: number, fz: number) => Math.atan2(fx, fz);

export interface StationOpts {
  /** AI survey only: memoize native straight entrance searches and return early after a site fails. */
  aiSurvey?: boolean;
  /** Internal existing-track adapter: retain the real formation instead of laying a free station. */
  alignment?: RailStationAlignment;
  layout?: StationLayout;
  /** 'ground' (default), 'elevated' (viaduct) or 'underground' */
  level?: StationLevel;
  /** alias of level 'underground' */
  underground?: boolean;
  /** elevated: deck height above the highest ground beneath (STATION_HEIGHT) */
  height?: number;
  /** underground: platform level below the lowest ground above (STATION_DEPTH) */
  depth?: number;
  /** ground: put the building on this side of the tracks (+1 right, -1 left; default: the better side) */
  buildingSide?: 1 | -1;
  /** plan ignoring this station's own structures (rebuilding / relocating it) */
  ignoreStation?: number;
  /** plan ignoring these edges (approach track that becomes platform when rebuilding) */
  ignoreEdges?: Set<number>;
  /** through tracks without platforms (0-2) for trains that do not stop, and where they go */
  through?: number;
  throughMode?: ThroughMode;
  /** platform level fixed (a station inserted into an existing line at the track's height) */
  fixedY?: number;
  /**
   * Platform wire state (default standard). Legacy metro / lightrail ids also supply a style when mode is absent.
   */
  trackType?: string;
  /** Station construction style: metro defaults to underground with screen doors, light rail to side platforms. */
  mode?: RailMode;
  /** side or island platforms (default: side for metro / light rail without through tracks, else island) */
  platformStyle?: PlatformStyle;
  /** platform screen doors (default: metro) */
  psd?: boolean;
  /** building style (STATION_STYLES id, default 'classic'; see defaultStationStyle) */
  style?: string;
  /** style 'end': at which end the head building goes (+1 front, -1 back; default: the better one) */
  buildingEnd?: 1 | -1;
  /** ends that carry track beyond the platforms (no head building there) */
  blockedEnds?: (1 | -1)[];
  /** rebuilding in place: the station's own added entrances, which a new building site avoids where it can */
  avoid?: Rect[];
  /** below / above the street: how many street entrances to place (2-4; default by platform length) */
  entrances?: number;
}

export interface StationPlan {
  ok: boolean;
  error?: string;
  /** e.g. no road within reach (the station would have no road access, hence no passengers) */
  warnings: string[];
  x: number; z: number; y: number; angle: number;
  length: number; tracks: number;
  /** through tracks (no platform) and where they lie */
  through: number; throughMode: ThroughMode;
  /** platform wire state, independent station mode, platform style and screen doors */
  trackType: string; mode: RailMode; platformStyle: PlatformStyle; psd: boolean;
  /** building style id (STATION_STYLES) */
  style: string;
  level: StationLevel;
  underground: boolean;
  /** underground depth / elevated height (0 on the ground) */
  depth: number; height: number;
  layout: StationLayout;
  alignment?: RailStationAlignment;
  footprint: Rect;
  building: Rect;
  /** underground / elevated: street-level entrances (with road access or not) */
  entrances: (Entrance & { access: boolean })[];
  piers: { x: number; z: number }[];
  demolish: number[];
  cost: number;
  /** an own bus / tram stop station this station joins (one station), or null */
  join: Station | null;
  /** own stations within walking range that get linked for transfers */
  links: Station[];
  /** ground: the access street to build (its cost is part of `cost`), null if none is needed or possible */
  access: Proposal | null;
  /** will passengers reach the station (road at the forecourt / an entrance, or a joined stop)? */
  roadAccess: boolean;
  forecourt: { x: number; z: number } | null;
  /** style 'over': the forecourt on the other side of the tracks */
  forecourt2?: { x: number; z: number } | null;
  /** a metro / light-rail style station in a town (Station.city once built): it walks half as far (planWalkScale) */
  city?: boolean;
}

/** A planned extra entrance (Stations.planEntrance). */
export interface EntrancePlan {
  ok: boolean; error?: string;
  /** e.g. no room for a crossing's stairs on the other side, or no road beside them */
  warnings: string[];
  kind: EntranceKind;
  /** the entrance as it would be built (also on some failures: no road beside it, for the AI's estimates) */
  entrance?: Entrance;
  /** what it costs, its access street included */
  cost: number;
  /** ground: the access street to a road within reach (its cost is part of `cost`), or null */
  access: Proposal | null;
  /** its street-level structures and whether a road reaches each (now, or through the access street) */
  landings: { x: number; z: number; angle: number; road: boolean }[];
  /** no road at any landing: where an access street would start (on the planned side) */
  door?: { x: number; z: number };
}

export interface BusStopPlan {
  ok: boolean; error?: string; edge?: NEdge; s?: number; px?: number; pz?: number; cost: number;
  /** own station the stop becomes part of (a rail station within walking range, or a stop across the street) */
  join: Station | null;
  /** own stations within walking range that get linked for transfers */
  links: Station[];
  mode: 'bus' | 'tram';
  /** sharing (planBusStop { share }): the existing stop station used instead of a new stop (nothing is built) */
  reuse?: number;
}

export interface UpgradeOpts {
  length?: number; tracks?: number; through?: number; level?: StationLevel; height?: number; depth?: number;
  /** restyle: another building style (cost: the new building minus salvage) */
  style?: string;
  /** where added platform tracks go: 'right' (positive track offsets, (cos a, -sin a)), 'left', or 'auto' (the side with room, away from the building) */
  side?: 'left' | 'right' | 'auto';
}

/** Planned rebuild of a rail station with longer platforms / more tracks (planStationUpgrade). */
export interface UpgradePlan {
  ok: boolean; error?: string; warnings: string[];
  station: number;
  cost: number;
  length: number; tracks: number; through: number;
  /** the new station part (null when the upgrade is not possible) */
  plan: StationPlan | null;
  /** how far each end moves out (+) or in (-): [front, back] */
  delta: [number, number];
  /** new layout key ('<i>' platform track i, 'T<i>' through track i) of every old track, in lateral order */
  keep: string[];
  /**
   * Connected ends that move out: per old track (lateral rank) the approach edges replaced by platform and the
   * edge split where the new platform end goes (or `at`, the node already there).
   */
  cuts: { end: 0 | 1; rank: number; node: number; remove: number[]; edge: number; s: number; fromA: boolean; at: number }[];
  /** whole rebuild through relocation (level change of an unconnected station) */
  rebuild: boolean;
  /** only the building changes: existing track stays, ground entrances are refitted where needed */
  restyleOnly?: boolean;
  /** a ground station rebuilt in place: what becomes of its added entrances (new access streets are in `cost`) */
  entrances?: EntranceRefit;
}


type PlannedEntrance = Entrance & { access: boolean; demolish: number[] };
interface EntranceRoadSample { x: number; z: number; angle: number; dem?: number[] | null }
interface EntranceMemo {
  world: Game['world']; net: Game['world']['net']; stations: Stations['map']; depots: Game['depots']['map']; epoch: string;
  memo: Map<string, number[] | null>; roads: Map<string, EntranceRoadSample[]>; roadCount: number;
  sites: Map<string, PlannedEntrance[]>; siteHits: number; siteMisses: number; hits: number; misses: number;
}
// Instance-keyed derived data: preview/refit Object.create instances cannot inherit a live cache.
const entranceRevisions = new WeakMap<Stations, number>();
const entranceMemos = new WeakMap<Stations, EntranceMemo>();

interface PlatformGeometryMemo { inputs: unknown[]; areas: Rect[] }
interface PlatformGapMemo { a: PlatformGeometryMemo; b: PlatformGeometryMemo; distance: number }
interface StationGeometryMemo {
  net: Game['world']['net']; version: number; walk: number;
  areas: WeakMap<Station, PlatformGeometryMemo>;
  gaps: WeakMap<Station, WeakMap<Station, PlatformGapMemo>>;
}
// Geometry queries never publish simulation state; temporary forecast stations are keyed by object, not reused IDs.
const stationGeometryMemos = new WeakMap<Stations, StationGeometryMemo>();

export class Stations {
  map = new Map<number, Station>();
  nextId = 1;
  /** network version the stations' road access was last computed at */
  private accessVersion = -1;
  /** Structural/access edits consumed by the walking portal index. */
  walkVersion = 0;
  private warming = false;
  private warmedTick = -1;
  private warmCursor = 0;
  private warmStations: Station[] = [];
  private warmVersion = -1;
  private warmCount = -1;

  /** Prepare at most two station inputs per fixed tick; live shares retain their original update timing. */
  prepareCatchmentTick() {
    if (this.warming || this.warmedTick === this.game.tick) return;
    this.warmedTick = this.game.tick;
    if (!this.sharesReady || !this.catchmentInputsChanged()) return;
    if (this.warmVersion !== this.walkVersion || this.warmCount !== this.map.size) {
      this.warmVersion = this.walkVersion; this.warmCount = this.map.size; this.warmStations = this.all();
    }
    this.warming = true;
    try {
      for (let i = 0; i < 2 && this.warmStations.length; i++) {
        const st = this.warmStations[this.warmCursor++ % this.warmStations.length];
        if (this.map.get(st.id) === st) prepareWalkingCatchment(this.game, st);
      }
    } finally { this.warming = false; }
  }
  constructor(private game: Game) {
    const net = game.world.net;
    net.onSplit.push((old, e1, e2, s) => {
      for (const h of this.holds.values()) {
        const i = h.edges.indexOf(old.id);
        if (i >= 0) {
          h.edges.splice(i, 1, e1.id, e2.id);
          if (game.vehicles.getRes(old.id) === WORKS_HOLD) {
            game.vehicles.setRes(e1.id, WORKS_HOLD); game.vehicles.setRes(e2.id, WORKS_HOLD);
            game.vehicles.releaseRes(old.id, WORKS_HOLD);
          }
        }
      }
      for (const st of this.map.values()) {
        for (const stop of st.stops) {
          if (stop.edge !== old.id) continue;
          if (stop.s < s) stop.edge = e1.id; else { stop.edge = e2.id; stop.s -= s; }
        }
        if (st.rail) {
          for (const group of st.rail.groups ?? []) {
            const k = group.steps.findIndex((q) => q.edge === old.id);
            if (k < 0) continue;
            const dir = group.steps[k].dir;
            group.steps.splice(k, 1, ...(dir > 0
              ? [{ edge: e1.id, dir: 1 as const }, { edge: e2.id, dir: 1 as const }]
              : [{ edge: e2.id, dir: -1 as const }, { edge: e1.id, dir: -1 as const }]));
            group.length += e1.len + e2.len - old.len;
          }
          const i = st.rail.edges.indexOf(old.id);
          if (i >= 0) st.rail.edges.splice(i, 1, e1.id, e2.id);
          const j = st.rail.throughEdges.indexOf(old.id);
          if (j >= 0) st.rail.throughEdges.splice(j, 1, e1.id, e2.id);
        }
      }
    });
    net.onRemove.push((e) => {
      for (const [sid, h] of this.holds) {
        if (h.edges.includes(e.id)) game.vehicles.releaseRes(e.id, WORKS_HOLD);
        h.edges = h.edges.filter((id) => id !== e.id);
        if (!h.edges.length) this.holds.delete(sid);
      }
      for (const st of [...this.map.values()]) {
        const before = st.stops.length;
        st.stops = st.stops.filter((p) => p.edge !== e.id);
        if (st.rail) {
          st.rail.edges = st.rail.edges.filter((x) => x !== e.id); st.rail.throughEdges = st.rail.throughEdges.filter((x) => x !== e.id);
          for (const group of st.rail.groups ?? []) {
            group.steps = group.steps.filter((q) => q.edge !== e.id);
            group.length = group.steps.reduce((s, q) => s + (net.edges.get(q.edge)?.len ?? 0), 0);
          }
        }
        if (st.stops.length !== before && !st.stops.length && !st.rail) this.deleteStation(st.id);
      }
    });
  }

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  private create(x: number, z: number, owner: number): Station {
    const g = this.game;
    const town = g.towns.nearest(x, z);
    const st: Station = {
      id: this.nextId++, name: this.stationName(x, z, town), owner, townId: town ? town.id : -1, x, z, rail: null, stops: [],
      waiting: new Map(), waitingTotal: 0, rating: 0.65, lastPickup: g.day, lastSpeed: 0,
      catchPop: 0, genAccum: 0, genMonth: 0, genLast: 0, pickupMonth: 0, pickupLast: 0, arrivedMonth: 0, arrivedLast: 0,
      lostMonth: 0, lostLast: 0, lastCall: -1, callDays: 0, built: g.day,
      links: [], roadAccess: true,
    };
    this.map.set(st.id, st);
    return st;
  }

  // ---------------------------------------------------------------- names
  /** A unique name for a new station at (x, z): the town's name, then "<Town> <place>" by position, numbers last. */
  stationName(x: number, z: number, town: Town | null = this.game.towns.nearest(x, z)): string {
    const used = new Set<string>();
    for (const s of this.map.values()) used.add(s.name);
    const base = town ? town.name : 'Station';
    if (!used.has(base)) return base;
    for (const s of this.placeNames(x, z, town)) if (!used.has(`${base} ${s}`)) return `${base} ${s}`;
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  /**
   * Name suffixes for a station at (x, z), most fitting first: by the water (harbour, quay...), on a hill
   * (heights...), in the core (market, town hall...), the inner streets (church road, hospital...) or at
   * the edge (park, fields...), then the compass point, then all other places, landmarks and street names.
   */
  private placeNames(x: number, z: number, town: Town | null): string[] {
    const w = this.game.world;
    const kinds: (keyof typeof PLACE_NAMES)[] = [];
    let water = false;
    for (let k = 0; k < 12 && !water; k++) {
      const a = (k / 12) * Math.PI * 2, r = k % 2 ? 9 : 5;
      if (w.heightAt(x + Math.sin(a) * r, z + Math.cos(a) * r) < WATER_Y) water = true;
    }
    if (water) kinds.push('water');
    const dir: string[] = [];
    if (town) {
      const dx = x - town.x, dz = z - town.z, d = Math.hypot(dx, dz);
      if (w.heightAt(x, z) - w.heightAt(town.x, town.z) > 1.2) kinds.push('hill');
      if (d < 8) dir.push('Central');
      kinds.push(d < Math.max(7, town.radius * 0.3) ? 'core' : d < town.radius * 0.7 ? 'inner' : 'edge');
      const ns = dz > 0 ? 'South' : 'North', ew = dx > 0 ? 'East' : 'West';
      dir.push(Math.abs(dx) > Math.abs(dz) ? ew : ns, `${ns} ${ew}`.replace(/^(North|South) (East|West)$/, (_, a, b) => a + b.toLowerCase()));
    } else kinds.push('edge');
    for (const k of ['core', 'inner', 'edge', 'hill', 'water'] as const) if (!kinds.includes(k)) kinds.push(k);
    const seed = (n: number) => Math.floor(hash2(Math.round(x * 4), Math.round(z * 4), n) * n);
    const out: string[] = [];
    kinds.forEach((k, i) => {
      const list = PLACE_NAMES[k], s0 = seed(list.length);
      for (let j = 0; j < list.length; j++) out.push(list[(s0 + j) % list.length]);
      if (i === 0) out.push(...dir);
    });
    const l0 = seed(LANDMARKS.length);
    for (let j = 0; j < LANDMARKS.length; j++) out.push(LANDMARKS[(l0 + j) % LANDMARKS.length]);
    const a0 = seed(STREET_A.length), b0 = seed(STREET_B.length + 3);
    for (let j = 0; j < STREET_A.length * STREET_B.length; j++) {
      const a = STREET_A[(a0 + j) % STREET_A.length], b = STREET_B[(b0 + Math.floor(j / STREET_A.length) + j) % STREET_B.length];
      out.push(`${a} ${b}`);
    }
    return out;
  }

  deleteStation(id: number) {
    const st = this.map.get(id);
    if (!st) return;
    for (const o of st.links) { const os = this.map.get(o); if (os) os.links = os.links.filter((x) => x !== id); }
    st.links = [];
    this.map.delete(id);
    this.accessVersion = -1;
    this.walkVersion++;
    this.game.lines.onStationRemoved(id);
    this.markStation(st);
  }

  /** Mark the object chunks of a station's structures (platforms, building, entrances, piers) for re-rendering. */
  private markStation(st: Station) {
    entranceRevisions.set(this, (entranceRevisions.get(this) ?? 0) + 1);
    const w = this.game.world;
    w.markObjArea(st.x - 20, st.z - 20, st.x + 20, st.z + 20);
    const r = st.rail;
    if (!r) return;
    w.markObjArea(r.x - r.length / 2 - 3, r.z - r.length / 2 - 3, r.x + r.length / 2 + 3, r.z + r.length / 2 + 3);
    for (const e of [...r.entrances.flatMap(entranceLandings), r.building, ...r.piers]) w.markObjArea(e.x - 2.5, e.z - 2.5, e.x + 2.5, e.z + 2.5);
    if (r.forecourt) w.markObjArea(r.forecourt.x - 2, r.forecourt.z - 2, r.forecourt.x + 2, r.forecourt.z + 2);
  }

  hasRail(st: Station) { return !!st.rail; }
  hasRoad(st: Station) { return st.stops.length > 0; }
  levelOf(st: Station): StationLevel { return st.rail?.level ?? 'ground'; }

  /** Collision rectangles of station structures at street level (underground: only the entrances). */
  footprints(st: Station): Footprint[] { return this.structures(st); }

  /** Cached station structure volumes (planning queries hit these per sample point). */
  private structCache = new WeakMap<RailPart, { key: string; v: Volume[] }>();

  private structures(st: Station): Volume[] { return st.rail ? this.structuresOf(st.rail) : []; }

  /** Structure volumes of a rail part (a station's, or a planned one when previewing a rebuild). */
  private structuresOf(r: RailPart): Volume[] {
    const b = r.building;
    const key = `${this.game.world.heightsVersion}|${r.x}|${r.z}|${r.y}|${r.angle}|${r.length}|${r.tracks}|${r.through ?? 0}|${r.width ?? 0}|${r.level}|${b.x}|${b.z}|${b.w}|${b.d}|${entranceKey(r)}|${(r.piers ?? []).length}|${r.style ?? ''}`;
    const c = this.structCache.get(r);
    if (c && c.key === key) return c.v;
    const v = this.buildStructures(r);
    this.structCache.set(r, { key, v });
    return v;
  }

  private buildStructures(r: RailPart): Volume[] {
    const w = this.game.world;
    const lv = r.level ?? 'ground';
    // Platforms stop 50 cm inside each end node; buffers also sit inside it. Keep the throat outside this
    // rectangle free for connecting track and short depot stubs (earthwork skirts are not structures).
    const fp = { x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: Math.max(0, r.length - 0.1) };
    const areas = r.alignment ? stationStripRects(r, 0, railWidth(r), -r.length / 2 + 0.05, r.length / 2 - 0.05) : [fp];
    if (lv === 'ground') {
      const sty = styleOf(r.style), out: Volume[] = areas.map((f) => ({ ...f, y0: r.y - 0.3 - (r.alignment ? 0.15 : 0), y1: r.y + 1.0 + (r.alignment ? 0.15 : 0), part: 'platforms' }));
      if (sty.placement === 'over') {
        // the concourse over the tracks, a pavilion on each side
        const b = r.building, local = stationLocal(r, b.x, b.z), pose = stationPose(r, 0, local.along), rx = pose.fz, rz = -pose.fx, off = railWidth(r) / 2 + CONCOURSE_PAVILION / 2;
        out.push({ ...b, y0: r.y + 1.1, y1: r.y + 1.9, part: 'deck' });
        for (const sd of [1, -1]) out.push({ x: b.x + rx * off * sd, z: b.z + rz * off * sd, angle: pose.angle - (Math.PI / 2) * sd, w: b.w, d: CONCOURSE_PAVILION, y0: r.y - 0.2, y1: r.y + 1.9, part: 'building' });
      } else out.push({ ...r.building, y0: r.y - 0.2, y1: r.y + styleHeight(sty), part: 'building' });
      // added entrances beside the track area: their halls, stair towers, stair pavilions and gates (a footbridge's
      // deck crosses within the platforms' volume, an underpass beneath it)
      (r.entrances ?? []).forEach((e, i) => {
        const k = entranceKind('ground', e);
        for (const p of entranceLandings(e)) {
          const h = w.heightAt(p.x, p.z);
          out.push({ ...landingRect(k, p), y0: h - 0.2, y1: k === 'footbridge' ? Math.max(h + 0.5, r.y + 1.0) : h + (k === 'hall' ? 0.55 : k === 'underpass' ? 0.45 : 0.35), part: 'entrance', entrance: i });
        }
      });
      return out;
    }
    const out: Volume[] = [];
    const sz = ENTRANCE_SIZE[lv];
    if (lv === 'elevated') {
      out.push(...areas.map((f): Volume => ({ ...f, y0: r.y - 0.4 - (r.alignment ? 0.15 : 0), y1: r.y + 1.0 + (r.alignment ? 0.15 : 0), part: 'deck' })));
      for (const p of r.piers ?? []) { const h = w.heightAt(p.x, p.z); out.push({ x: p.x, z: p.z, angle: r.angle, w: 0.4, d: 0.4, y0: h - 0.3, y1: r.y, part: 'pier' }); }
    }
    (r.entrances ?? []).forEach((e, i) => { const h = w.heightAt(e.x, e.z); out.push({ x: e.x, z: e.z, angle: e.angle, w: sz.w, d: sz.d, y0: h - 0.2, y1: lv === 'elevated' ? r.y + 1.0 : h + 0.6, part: 'entrance', entrance: i }); });
    // a station building at street level (style other than none)
    const sty = styleOf(r.style);
    if (sty.placement !== 'none' && r.forecourt) { const h = w.heightAt(r.building.x, r.building.z); out.push({ ...r.building, y0: h - 0.2, y1: h + styleHeight(sty), part: 'building' }); }
    return out;
  }

  /** Underground station box (platforms and tracks below ground), for 3D clearance checks. */
  private volumes(st: Station): Volume[] {
    const r = st.rail;
    if (!r) return [];
    const out = this.structures(st).slice();
    if ((r.level ?? 'ground') === 'underground') out.push(...this.undergroundBoxes(st).map((f): Volume => ({ ...f, part: 'platforms' })));
    return out;
  }

  /** The actual station box, used by every underground planner and drawn once per view rebuild. */
  undergroundBox(st: Station) {
    const r = st.rail;
    if (!r || r.level !== 'underground') return null;
    return { ...undergroundStationVolume({ x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: r.length }, r.y), station: st.id };
  }

  /** Actual swept underground boxes; legacy straight stations still have their original one box. */
  undergroundBoxes(st: Station) {
    const r = st.rail;
    if (!r || r.level !== 'underground') return [];
    return stationStripRects(r, 0, railWidth(r)).map((f) => ({ ...undergroundStationVolume(f, r.y), station: st.id }));
  }

  /**
   * Underground station boxes (platforms and tracks below ground, as `volumes`) within r of (x, z): tunnels and
   * underground depots keep clear of them (construction.ts, build-ops.ts).
   */
  undergroundNear(x: number, z: number, r: number): { x: number; z: number; angle: number; w: number; d: number; y0: number; y1: number; station: number }[] {
    const out: { x: number; z: number; angle: number; w: number; d: number; y0: number; y1: number; station: number }[] = [];
    for (const st of this.map.values()) {
      const rl = st.rail;
      if (!rl || (rl.level ?? 'ground') !== 'underground') continue;
      const wd = railWidth(rl);
      if (Math.hypot(rl.x - x, rl.z - z) > Math.hypot(rl.length, wd) / 2 + r) continue;
      out.push(...this.undergroundBoxes(st));
    }
    return out;
  }

  footprintsNear(x: number, z: number, r: number): Station[] {
    const out: Station[] = [];
    for (const st of this.map.values()) {
      if (!st.rail) continue;
      if (Math.hypot(st.rail.x - x, st.rail.z - z) > st.rail.length / 2 + ENTRANCE_REACH + 6 + r) continue;
      for (const f of this.footprints(st)) if (distToRect(x, z, f.x, f.z, f.angle, f.w / 2, f.d / 2) <= r) { out.push(st); break; }
    }
    return out;
  }

  // ---------------------------------------------------------------- obstacles
  /**
   * Conflicts of a rectangle spanning heights y0..y1: buildings (collected in `demolish`, or a conflict without
   * it), network edges (`groundEdges`: any edge on the ground conflicts, as for a levelled site), stations and
   * depots. Returns the reason or null.
   */
  private rectConflict(rect: Rect, y0: number, y1: number, demolish: Set<number> | null, o: { groundEdges?: boolean; ignoreStation?: number; ignoreEdges?: Set<number>; skipRoad?: number } = {}): string | null {
    // edges: rail [y - 0.1, y + 0.5], road [y - 0.1, y + 0.45] (the planner's 0.62 clearance between running surfaces)
    const g = this.game, w = g.world, net = w.net;
    const R = Math.hypot(rect.w, rect.d) / 2 + 1;
    for (const id of w.bgrid.query(rect.x - R, rect.z - R, rect.x + R, rect.z + R)) {
      const b = w.buildings.get(id);
      if (!b || !rectsOverlap(rect, b, 0.05)) continue;
      if (b.y + b.floors * FLOOR_H + 0.45 < y0 || b.y - 0.2 > y1) continue;
      if (!demolish) return 'Building in the way';
      demolish.add(id);
    }
    for (const e of net.edgesNear(rect.x - R, rect.z - R, rect.x + R, rect.z + R)) {
      if (o.ignoreEdges?.has(e.id) || e.id === o.skipRoad) continue;
      if (o.ignoreStation !== undefined && e.station === o.ignoreStation) continue;
      const geo = net.geo(e), hw = net.halfWidth(e);
      for (let i = 0; i < geo.n; i++) {
        if (distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2) >= hw - 0.05) continue;
        const ey = geo.pts[i * 3 + 1];
        const sec = net.sectionAt(e, geo.cum[i]);
        if ((o.groundEdges && sec === 'ground') || (ey + (e.kind === 'rail' ? 0.5 : 0.45) > y0 && ey - 0.1 < y1)) return e.kind === 'rail' ? (sec === 'tunnel' ? 'Tunnel in the way' : 'Track in the way') : 'Road in the way';
      }
    }
    for (const st of this.footprintsNear(rect.x, rect.z, R + 2)) {
      if (st.id === o.ignoreStation) continue;
      for (const f of this.volumes(st)) if (f.y1 > y0 && f.y0 < y1 && rectsOverlap(rect, f, 0)) return 'Station in the way';
    }
    for (const st of this.map.values()) {
      if (!st.rail || st.id === o.ignoreStation || st.rail.level !== 'underground') continue;
      if (Math.hypot(st.rail.x - rect.x, st.rail.z - rect.z) > st.rail.length / 2 + R + 3) continue;
      for (const f of this.volumes(st)) if (f.y1 > y0 && f.y0 < y1 && rectsOverlap(rect, f, 0)) return 'Station in the way';
    }
    for (const d of g.depots.near(rect.x, rect.z, R)) {
      const v = depotVolume(d);
      if (v.y1 > y0 && v.y0 < y1 && rectsOverlap(rect, v, 0)) return 'Depot in the way';
    }
    return null;
  }

  // ---------------------------------------------------------------- rail stations
  /**
   * Plan a rail station centred at (x, z) with tracks along `angle`. Ground stations level their site, demolish
   * what is in the way and get a building with an access street to the nearest road; elevated stations sit on
   * a viaduct (only pier and stair tower sites are cleared), underground ones below the surface with entrance
   * pavilions beside streets.
   */
  planRail(x: number, z: number, angle: number, length: number, tracks: number, owner: number, opts: StationOpts = {}): StationPlan {
    const g = this.game, w = g.world;
    const self = opts.ignoreStation !== undefined ? this.map.get(opts.ignoreStation) : undefined;
    // Rebuilds supply the saved wire id; it no longer identifies the station's construction mode.
    const rmode = opts.mode ?? (self?.rail && (opts.trackType === undefined || trackTypeOf(opts.trackType) === opts.trackType)
      ? railPartMode(self.rail) : railModeOf(opts.trackType));
    const trackType = trackTypeOf(opts.trackType);
    const level: StationLevel = opts.level ?? (opts.underground || rmode === 'metro' ? 'underground' : 'ground');
    const through = Math.max(0, Math.min(2, Math.round(opts.through ?? 0))), throughMode = opts.throughMode ?? 'middle';
    const platformStyle: PlatformStyle = opts.platformStyle ?? (rmode !== 'mainline' && !through ? 'side' : 'island');
    const psd = opts.psd ?? rmode === 'metro';
    const layout = opts.layout ?? stationLayout(tracks, through, throughMode, platformStyle);
    const fx = Math.sin(angle), fz = Math.cos(angle);
    const footprint: Rect = { x, z, angle, w: layout.width, d: length };
    const shape = { x, z, y: opts.fixedY ?? 0, angle, length, alignment: opts.alignment };
    const pose = (off: number, along: number) => stationPose(shape, off, along);
    const areas = stationStripRects(shape, 0, layout.width);
    // the building: optional at every level (none: street entrances / platform ramps); a light-rail stop a halt
    let sty: StationBuildingStyle = styleOf(opts.style ?? (level !== 'ground' ? 'none' : rmode === 'lightrail' ? 'shelter' : 'classic'));
    const plan: StationPlan = {
      ok: true, warnings: [], x, z, y: 0, angle, length, tracks, through, throughMode, trackType, mode: rmode, platformStyle, psd, style: sty.id,
      level, underground: level === 'underground', depth: 0, height: 0, layout, footprint, ...(opts.alignment ? { alignment: opts.alignment } : {}),
      building: { x, z, angle, w: 0, d: 0 }, entrances: [], piers: [], demolish: [], cost: 0, join: null, links: [], access: null, roadAccess: false, forecourt: null,
    };
    // a metro / light-rail station in town walks half as far (CITY_STATION; rebuilding or moving a station keeps its
    // standing until its town no longer holds it, as the month-end decision does)
    if (rmode !== 'mainline') {
      if (this.cityAt(x, z, self ? g.towns.list[self.townId] : g.towns.nearest(x, z), self?.city)) plan.city = true;
    }
    const failp = (e: string) => { if (plan.ok) { plan.ok = false; plan.error = e; } };
    if (!(length >= 3) || !(tracks >= 1 && tracks <= 8)) failp('Invalid station size');
    if (opts.style && !STATION_STYLES[opts.style]) plan.warnings.push(`Unknown style ‘${opts.style}’: using station building`);
    if (!sty.levels.includes(level)) { sty = STATION_STYLES.classic; plan.style = sty.id; }
    if (tracks < sty.minTracks || tracks > sty.maxTracks) failp(`${sty.name}: for ${sty.minTracks === sty.maxTracks ? sty.minTracks : `${sty.minTracks}-${sty.maxTracks}`} platform tracks`);
    // terrain over the site
    const rx = fz, rz = -fx;
    let sum = 0, cnt = 0, mn = Infinity, mx = -Infinity, wet = false;
    for (let a = -0.5; a <= 0.5; a += 0.125) for (let b = -0.5; b <= 0.5; b += 0.25) {
      const pt = pose(layout.width * b, length * a), px = pt.x, pz = pt.z;
      if (!w.inside(px, pz, 2)) failp('Too close to the map edge');
      const h = w.heightAt(px, pz);
      if (h < 0.1) wet = true;
      sum += h; cnt++; mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    const demolish = new Set<number>();
    // Platforms, tracks and access. Buildings and screen doors are fit-out, not extra excavation
    // or viaduct structure, so their prices stay outside the civil multiplier.
    const physical = opts.alignment?.tracks;
    const platformLength = physical ? physical.filter((t) => layout.trackOffsets.includes(t.offset)).reduce((n, t) => n + t.length, 0) : tracks * length;
    const throughLength = physical ? physical.filter((t) => layout.throughOffsets.includes(t.offset)).reduce((n, t) => n + t.length, 0) : through * length;
    // Retained running rail (including its existing civil structure) is not the facility payer's asset.
    const base = (platformLength + throughLength * 0.7) * (physical ? 1500 : 9000) + 120000;
    const doors = psd ? platformLength * 2500 : 0;
    const civil = base - BUILDING_BASE;
    const fixed = opts.fixedY;
    const ign = opts.ignoreStation;
    /** The passenger building's site by its style's placement, its base at height y0 (see the comments within). */
    const placeBuilding = (y0: number, pl: StylePlacement) => {
      // the passenger building by its style's placement: beside the platforms (either side, centred or towards an
      // end) where its forecourt is closest to a road on its own side of the tracks (or beyond the platform ends'
      // lead corridors); a ramp pad at a platform end ('none'); a concourse over the tracks with a pavilion and a
      // forecourt on each side ('over'); a head building across a free end ('end'); nothing in the way but houses
      const bs = pl === 'none' ? NO_BUILDING_PAD : sty.size(length, tracks + through, layout.width);
      const cands: BuildingCand[] = [];
      const roadPts: { x: number; z: number; lat: number; lon: number }[] = [];
      {
        const R = length / 2 + ACCESS_REACH, p = { x: 0, y: 0, z: 0 };
        for (const e of w.net.edgesNear(x - R, z - R, x + R, z + R)) {
          if (e.kind !== 'road' || e.depot >= 0) continue;
          for (let sv = 0; sv <= e.len; sv += 1) {
            w.net.pointAt(e, Math.min(sv, e.len), p);
            const dx = p.x - x, dz = p.z - z;
            if (dx * dx + dz * dz > R * R) continue;
            const local = stationLocal(shape, p.x, p.z);
            roadPts.push({ x: p.x, z: p.z, lat: local.off, lon: local.along });
          }
        }
      }
      const roadDist = (fc: { x: number; z: number }, side: number) => {
        let d = Infinity;
        for (const q of roadPts) {
          if (q.lat * side < layout.width / 2 + 0.3 && Math.abs(q.lon) < length / 2 + 26) continue;
          d = Math.min(d, Math.hypot(q.x - fc.x, q.z - fc.z));
        }
        return d;
      };
      const roadDistEnd = (fc: { x: number; z: number }, end: number) => {
        let d = Infinity;
        for (const q of roadPts) if (q.lon * end > length / 2 + bs.d) d = Math.min(d, Math.hypot(q.x - fc.x, q.z - fc.z));
        return d;
      };
      // (below / above the street: never over the entrances planned beside it)
      const keep = level === 'ground' ? [] : plan.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle, w: ENTRANCE_SIZE[level].w, d: ENTRANCE_SIZE[level].d }));
      const conflict = (r: Rect, h: number, dem: Set<number>) => keep.some((q) => rectsOverlap(r, q, 0.1)) ? 'Entrance in the way'
        : this.rectConflict(r, y0 - 0.2, y0 + h, dem, { groundEdges: true, ignoreStation: ign, ignoreEdges: opts.ignoreEdges });
      /** a site over one of the station's own entrances (rebuilding in place) only when nothing else fits */
      const over = (r: Rect) => (opts.avoid?.some((q) => rectsOverlap(r, q, 0.1)) ? 1000 : 0);
      const popOf = (dem: Set<number>) => { let p = 0; for (const id of dem) p += w.buildings.get(id)?.pop ?? 0; return p; };
      const reach = pl === 'none' ? NO_BUILDING_REACH : 0.9;
      if (pl === 'side' || pl === 'none') {
        const slide = Math.max(0, length / 2 - bs.w / 2 - 0.2);
        for (const side of opts.buildingSide ? [opts.buildingSide] : [-1, 1] as const) for (const k of pl === 'none' ? [1, -1] : [0, 1, -1, 0.5, -0.5]) {
          const off = layout.width / 2 + bs.d / 2 + 0.15, along = slide * k;
          const pt = pose(off * side, along), bx = pt.x, bz = pt.z;
          const b: Rect = { x: bx, z: bz, angle: pt.angle - (Math.PI / 2) * side, w: bs.w, d: bs.d };
          const fc = { x: bx + pt.fz * (bs.d / 2 + FORECOURT) * side, z: bz - pt.fx * (bs.d / 2 + FORECOURT) * side };
          const dem = new Set<number>();
          if (conflict(b, styleHeight(sty), dem)) continue;
          const road = Math.max(0, roadDist(fc, side) - reach);
          cands.push({ b, fc, dem, road, score: popOf(dem) + dem.size * 3 + Math.min(road, ACCESS_REACH * 1.5) * 3 + Math.abs(k) * (pl === 'none' ? 0 : 4) + (side === -1 ? 0 : 0.3) + over(b) });
        }
      } else if (pl === 'over') {
        const slide = Math.max(0, length / 2 - bs.w / 2 - 0.2);
        for (const k of [0, 0.5, -0.5, 1, -1]) {
          const along = slide * k, pt = pose(0, along), cx = pt.x, cz = pt.z, prx = pt.fz, prz = -pt.fx;
          const b: Rect = { x: cx, z: cz, angle: pt.angle - Math.PI / 2, w: bs.w, d: bs.d };
          const dem = new Set<number>();
          let blocked = false;
          for (const sd of [1, -1]) {
            const off = layout.width / 2 + CONCOURSE_PAVILION / 2;
            if (conflict({ x: cx + prx * off * sd, z: cz + prz * off * sd, angle: pt.angle - (Math.PI / 2) * sd, w: bs.w, d: CONCOURSE_PAVILION }, styleHeight(sty), dem)) blocked = true;
          }
          if (blocked) continue;
          const fR = { x: cx + prx * (bs.d / 2 + FORECOURT), z: cz + prz * (bs.d / 2 + FORECOURT) }, fL = { x: cx - prx * (bs.d / 2 + FORECOURT), z: cz - prz * (bs.d / 2 + FORECOURT) };
          const dR = roadDist(fR, 1), dL = roadDist(fL, -1);
          const road = Math.max(0, Math.min(dR, dL) - reach);
          const pav = [1, -1].map((sd) => { const off = layout.width / 2 + CONCOURSE_PAVILION / 2; return { x: cx + prx * off * sd, z: cz + prz * off * sd, angle: pt.angle - (Math.PI / 2) * sd, w: bs.w, d: CONCOURSE_PAVILION }; });
          cands.push({ b, fc: dR <= dL ? fR : fL, fc2: dR <= dL ? fL : fR, dem, road, score: popOf(dem) + dem.size * 3 + Math.min(road, ACCESS_REACH * 1.5) * 3 + Math.abs(k) * 4 + over(pav[0]) + over(pav[1]) + over({ ...b, w: b.w + 1.2 }) });
        }
      } else {
        for (const end of opts.buildingEnd ? [opts.buildingEnd] : [-1, 1] as const) {
          if (opts.blockedEnds?.includes(end)) continue;
          const off = length / 2 + bs.d / 2 + 0.15, cx = x + fx * off * end, cz = z + fz * off * end;
          const b: Rect = { x: cx, z: cz, angle: end > 0 ? angle : angle + Math.PI, w: bs.w, d: bs.d };
          const dem = new Set<number>();
          if (conflict(b, styleHeight(sty), dem)) continue;
          const fc = { x: cx + fx * (bs.d / 2 + FORECOURT) * end, z: cz + fz * (bs.d / 2 + FORECOURT) * end };
          const road = Math.max(0, roadDistEnd(fc, end) - reach);
          cands.push({ b, fc, dem, road, end, score: popOf(dem) + dem.size * 3 + Math.min(road, ACCESS_REACH * 1.5) * 3 + (end === -1 ? 0 : 0.3) + over(b) });
        }
      }
      cands.sort((p, q) => p.score - q.score);
      const pick = (c: BuildingCand) => { plan.building = c.b; plan.forecourt = c.fc; plan.forecourt2 = c.fc2 ?? null; for (const id of c.dem) demolish.add(id); };
      if (!cands.length) {
        failp(pl === 'end' ? (opts.blockedEnds?.length ?? 0) >= 2 || opts.buildingEnd && opts.blockedEnds?.includes(opts.buildingEnd) ? 'Terminal needs a platform end with no onward track' : 'No room for terminal across platform ends' : pl === 'over' ? 'No room for concourse entrances on both sides' : pl === 'none' ? 'No room for platform-end ramps' : 'No room for the station building');
        plan.building = { x: x - rx * (layout.width / 2 + 0.6), z: z - rz * (layout.width / 2 + 0.6), angle: angle + Math.PI / 2, w: bs.w, d: bs.d };
      } else pick(cands[0]);
      (plan as StationPlan & { buildingCands?: typeof cands }).buildingCands = cands;
    };
    if (level === 'ground') {
      if (wet) failp('Cannot build on water');
      plan.y = fixed ?? Math.max(0.3, sum / cnt);
      if (plan.y - 0.1 < DRY_MIN - 0.005) failp('Below water line: raise or go underground');
      if (fixed === undefined ? mx - mn > 3 : Math.max(mx - fixed, fixed - mn) > 3.5) failp('Ground is too uneven');
      const err = areas.map((f) => this.rectConflict(f, plan.y - 0.3 - (opts.alignment ? 0.15 : 0), plan.y + 1.0 + (opts.alignment ? 0.15 : 0), demolish, { groundEdges: true, ignoreStation: ign, ignoreEdges: opts.ignoreEdges })).find(Boolean);
      if (err) failp(err);
      // the building beside the platforms (either side, centred or towards an end) where its forecourt is
      // closest to a road on its own side of the tracks (or beyond the platform ends' lead corridors), with
      // nothing in the way but a few houses
      if (opts.aiSurvey && !plan.ok) return plan;
      placeBuilding(plan.y, sty.placement);
      plan.cost = base + BUILDING_BASE * (sty.cost - 1) + (mx - mn) * length * layout.width * 600;
    } else if (level === 'underground') {
      if (wet) failp('Cannot build under water');
      plan.depth = Math.max(STATION_DEPTH.min, Math.min(STATION_DEPTH.max, opts.depth ?? (rmode === 'metro' ? STATION_DEPTH.metro : STATION_DEPTH.def)));
      plan.y = mn - plan.depth;
      if (fixed !== undefined) { plan.y = fixed; plan.depth = mn - fixed; if (plan.depth < STATION_DEPTH.min - 0.4) failp('Too shallow for underground station'); }
      const err = areas.map((f) => { const volume = undergroundStationVolume(f, plan.y); return this.rectConflict(volume, volume.y0 - (opts.alignment ? 0.15 : 0), volume.y1 + (opts.alignment ? 0.15 : 0), null, { ignoreStation: ign, ignoreEdges: opts.ignoreEdges }); }).find(Boolean);
      if (err) failp(err === 'Building in the way' ? 'Foundations in the way' : err);
      const k = Math.max(0, Math.min(1, (plan.depth - STATION_DEPTH.min) / (STATION_DEPTH.max - STATION_DEPTH.min)));
      // Cut-and-cover box, excavation and fit-out, plus entrances below: roughly 4-6x a ground station.
      plan.cost = civil * (3.8 + 1.5 * k);
    } else {
      // elevated: the deck clears the ground, buildings, roads and tracks beneath
      plan.height = Math.max(STATION_HEIGHT.min, Math.min(STATION_HEIGHT.max, opts.height ?? STATION_HEIGHT.def));
      let top = mx + plan.height;
      const R = Math.hypot(footprint.w, footprint.d) / 2 + 1;
      for (const id of w.bgrid.query(x - R, z - R, x + R, z + R)) {
        const b = w.buildings.get(id);
        if (b && areas.some((f) => rectsOverlap(f, b, 0.1))) top = Math.max(top, b.y + b.floors * FLOOR_H + 0.95);
      }
      for (const e of w.net.edgesNear(x - R, z - R, x + R, z + R)) {
        if (opts.ignoreEdges?.has(e.id) || ign !== undefined && e.station === ign) continue;
        const geo = w.net.geo(e), hw = w.net.halfWidth(e);
        for (let i = 0; i < geo.n; i++) {
          if (!areas.some((f) => distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], f.x, f.z, f.angle, f.w / 2, f.d / 2) < hw)) continue;
          const ey = geo.pts[i * 3 + 1];
          if (ey < top + 0.5) top = Math.max(top, ey + RAIL.clearance + 0.3);
        }
      }
      if (fixed !== undefined) { if (fixed < top - 0.05) failp('Too low for elevated station'); top = fixed; }
      plan.y = top;
      if (top - mx > 5.2) failp('Deck would exceed 50 m above ground');
      plan.height = top - mx;
      const err = areas.map((f) => this.rectConflict(f, plan.y - 0.4, plan.y + 1.0, null, { ignoreStation: ign, ignoreEdges: opts.ignoreEdges })).find(Boolean);
      if (err) failp(err === 'Building in the way' ? 'Tall building in the way' : err);
      const pr = opts.alignment ? this.curvedPiers(shape, layout.width, demolish, ign, opts.ignoreEdges) : this.viaductPiers(footprint, layout.width, demolish, ign, opts.ignoreEdges);
      if (pr.error) failp(pr.error);
      plan.piers = pr.piers;
      const k = Math.min(1, Math.max(0, (plan.height - STATION_HEIGHT.min) / 1.8));
      // Deck, columns and elevated access, plus the towers below: roughly 3-4x a ground station.
      plan.cost = civil * (3.4 + 0.5 * k);
    }
    plan.cost += doors;
    if (opts.aiSurvey && !plan.ok && !plan.error?.startsWith('No room')) return plan;
    if (level !== 'ground') {
      const want = opts.entrances ?? (length >= 20 ? 4 : length >= 13 ? 3 : 2);
      const sites = opts.alignment ? this.curvedEntranceSites(level, shape, layout.width, want, ign) : this.entranceSites(level, footprint, want, [], ign, undefined, opts.aiSurvey);
      if (!sites.length) failp('No room for station entrances');
      plan.entrances = sites.map((s) => ({ x: s.x, z: s.z, angle: s.angle, access: s.access }));
      for (const s of sites) for (const id of s.demolish) demolish.add(id);
      plan.cost += sites.length * ENTRANCE_COST[level];
      const e0 = plan.entrances[0];
      if (e0) { const sz = ENTRANCE_SIZE[level]; plan.building = { x: e0.x, z: e0.z, angle: e0.angle, w: sz.w, d: sz.d }; }
      plan.roadAccess = plan.entrances.some((e) => e.access);
      // a building at street level as well (beside the station, or a concourse under an elevated deck)
      if (sty.placement !== 'none') {
        const e0b = plan.building;
        placeBuilding(sum / cnt, level === 'elevated' && sty.placement === 'over' ? 'over' : 'side');
        if (!plan.ok && plan.error?.startsWith('No room')) { plan.ok = true; plan.error = undefined; plan.building = e0b; plan.forecourt = null; plan.style = 'none'; sty = STATION_STYLES.none; plan.warnings.push('No room for street-level building; entrances only'); delete (plan as StationPlan & { buildingCands?: unknown }).buildingCands; }
        else plan.cost += BUILDING_BASE * sty.cost;
      }
    }
    // transfer complex: an own stop-only station within walking range is joined, other own stations are linked
    // (by mode: dense metro / light-rail neighbours are no interchange; never consecutive stops of a line)
    const cand = this.nearOwn(owner, (o) => Math.min(...areas.map((f) => this.gapToArea(o, f))), ign);
    const rects = level === 'ground' ? [...areas, plan.building] : [...areas, ...plan.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle, w: ENTRANCE_SIZE[level].w, d: ENTRANCE_SIZE[level].d }))];
    for (const c of cand) {
      const close = !c.st.rail && c.st.stops.some((q) => rects.some((f) => distToRect(q.x, q.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < STOP_JOIN));
      if (!plan.join && close) plan.join = c.st;
      else if (c.gap <= autoLinkRange(rmode, this.mode(c.st)) && c.st.id !== ign && !(ign !== undefined && this.consecutiveStops(ign, c.st.id))) plan.links.push(c.st);
    }
    // road access: a road at the forecourt, else an access street to a road within reach (other building sites
    // are tried when the best one gets none)
    const bc = (plan as StationPlan & { buildingCands?: BuildingCand[] }).buildingCands;
    delete (plan as StationPlan & { buildingCands?: unknown }).buildingCands;
    if ((level === 'ground' || sty.placement !== 'none') && plan.ok && plan.forecourt && bc) {
      const chosen = bc[0], reach = styleOf(plan.style).placement === 'none' ? NO_BUILDING_REACH : 0.9;
      search: for (const c of bc.slice(0, 6)) {
        if (c.road > ACCESS_REACH) continue;
        // either forecourt of a concourse station will do (the one with the road becomes the main one)
        for (const [f1, f2] of c.fc2 ? [[c.fc, c.fc2], [c.fc2, c.fc]] : [[c.fc, undefined]]) {
          const swap = () => {
            if (c !== chosen) {
              for (const id of chosen.dem) if (!c.dem.has(id)) demolish.delete(id);
              for (const id of c.dem) demolish.add(id);
            }
            plan.building = c.b; plan.forecourt = f1!; plan.forecourt2 = f2 ?? null;
          };
          if (this.roadContact(f1!.x, f1!.z, reach)) { swap(); plan.roadAccess = true; break search; }
        }
        for (const [f1, f2] of c.fc2 ? [[c.fc, c.fc2], [c.fc2, c.fc]] : [[c.fc, undefined]]) {
          plan.building = c.b;
          const acc = this.planAccessStreet(f1!.x, f1!.z, plan, owner, c.end);
          plan.building = chosen.b;
          if (acc) {
            if (c !== chosen) {
              for (const id of chosen.dem) if (!c.dem.has(id)) demolish.delete(id);
              for (const id of c.dem) demolish.add(id);
            }
            plan.building = c.b; plan.forecourt = f1!; plan.forecourt2 = f2 ?? null;
            plan.access = acc; plan.cost += acc.cost; plan.roadAccess = true;
            break search;
          }
        }
      }
    }
    if (level === 'ground') {
      // A rail formation reaches all the grid cells under its ballast. Houses sharing those cells must be
      // cleared when it is regraded, including outside the platform rectangle and along through tracks.
      const reach = 0.32 + EARTHWORKS.corePad + 1.42;
      for (const off of [...layout.trackOffsets, ...layout.throughOffsets]) for (let s = -length / 2; s <= length / 2 + 0.001; s += 0.5) {
        const pt = pose(off, s), px = pt.x, pz = pt.z;
        if (Math.abs(plan.y - 0.1 - w.heightAt(px, pz)) <= 0.1) continue;
        for (const b of w.buildingsNear(px, pz, reach)) if (distToRect(px, pz, b.x, b.z, b.angle, b.w / 2, b.d / 2) < reach) demolish.add(b.id);
      }
    }
    plan.demolish = [...demolish];
    for (const id of plan.demolish) { const b = w.buildings.get(id); if (b) plan.cost += demolitionCost(g, b); }
    if (plan.join) plan.roadAccess = true;
    if (!plan.roadAccess && plan.ok) plan.warnings.push(level === 'ground' ? 'No road in reach: no passengers' : 'No roadside entrance: no passengers');
    plan.cost = Math.round(plan.cost);
    return plan;
  }

  /** Own stations (or `pred`-matching ones) with their walking gap to an area, nearest first. */
  private nearOwn(owner: number, gap: (st: Station) => number, ignore?: number): { st: Station; gap: number }[] {
    const out: { st: Station; gap: number }[] = [];
    for (const st of this.map.values()) {
      if (st.owner !== owner || st.id === ignore) continue;
      const d = gap(st);
      if (d <= TRANSFER_RANGE * 2) out.push({ st, gap: d });
    }
    return out.sort((a, b) => a.gap - b.gap);
  }

  /** Walking gap from a station's platforms / stops to a rectangle. */
  private gapToArea(st: Station, rect: Rect): number {
    let d = Infinity;
    if (st.rail) d = Math.min(...this.platformAreas(st).map((f) => rectGap(f, rect)));
    for (const p of st.stops) d = Math.min(d, distToRect(p.x, p.z, rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2));
    return d;
  }

  /** The platform area of a rail station. */
  platformRect(st: Station): Rect | null {
    const r = st.rail;
    return r ? { x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: r.length } : null;
  }

  private geometryMemo(): StationGeometryMemo {
    const net = this.game.world.net;
    let memo = stationGeometryMemos.get(this);
    if (!memo || memo.net !== net || memo.version !== net.version || memo.walk !== this.walkVersion) {
      memo = { net, version: net.version, walk: this.walkVersion, areas: new WeakMap(), gaps: new WeakMap() };
      stationGeometryMemos.set(this, memo);
    }
    return memo;
  }

  private platformGeometry(st: Station, memo = this.geometryMemo()): PlatformGeometryMemo {
    const r = st.rail, width = r ? railWidth(r) : 0;
    const inputs: unknown[] = [r, r?.x, r?.z, r?.angle, r?.length, width, r?.alignment];
    // stationStripRects uses the track nearest offset zero, its exact curves and reference-arc mapping.
    let track = r?.alignment?.tracks[0];
    for (const t of r?.alignment?.tracks ?? []) if (track && Math.abs(t.offset) < Math.abs(track.offset)) track = t;
    inputs.push(track);
    if (track) {
      inputs.push(track.offset, track.length, track.pieces.length, track.knots.length);
      for (const p of track.pieces) {
        const c = p.curve;
        inputs.push(p, p.length, c.x0, c.z0, c.x1, c.z1, c.x2, c.z2, c.x3, c.z3);
      }
      for (const k of track.knots) inputs.push(k.u, k.s);
    }
    // Gap also depends on road-stop positions, even for temporary stations sharing an ID.
    for (const p of st.stops) inputs.push(p.x, p.z);
    const old = memo.areas.get(st);
    if (old && old.inputs.length === inputs.length && old.inputs.every((v, i) => Object.is(v, inputs[i]))) return old;
    const current = { inputs, areas: r ? stationStripRects(r, 0, width) : [] };
    memo.areas.set(st, current);
    return current;
  }

  platformAreas(st: Station): Rect[] {
    // Preserve the public fresh-array contract: callers cannot corrupt a later cached geometry query.
    return this.platformGeometry(st).areas.map(r => ({ ...r }));
  }

  /**
   * Access street from a station forecourt to a nearby road: not through the station, and clear of the lead
   * corridors beyond both platform ends (where the line and its throat go).
   */
  private planAccessStreet(fx: number, fz: number, plan: { x: number; z: number; y?: number; angle: number; length: number; alignment?: RailStationAlignment; layout: { width: number }; footprint: Rect; building: Rect }, owner: number, headEnd?: number, extra: Rect[] = [], side?: number, reach = ACCESS_REACH): Proposal | null {
    const g = this.game, net = g.world.net;
    const ax = Math.sin(plan.angle), az = Math.cos(plan.angle);
    const LEAD = 26, half = plan.layout.width / 2 + 1.2;
    /** (an entrance's street: to roads on its own side of the tracks, or beyond the lead corridors) */
    const shape = { ...plan, y: plan.y ?? 0 };
    const across = (x: number, z: number) => {
      const p = stationLocal(shape, x, z);
      return !!side && p.off * side < plan.layout.width / 2 + 0.3 && Math.abs(p.along) < plan.length / 2 + LEAD;
    };
    // the lead corridors beyond the platform ends stay free for the line (not at a terminal building's end)
    const keepOut: Rect[] = [...(plan.alignment ? stationStripRects(shape, 0, plan.layout.width) : [plan.footprint]), plan.building, ...extra];
    for (const end of [1, -1]) if (end !== headEnd) {
      const p = stationPose(shape, 0, end * plan.length / 2);
      keepOut.push({ x: p.x + p.fx * end * LEAD / 2, z: p.z + p.fz * end * LEAD / 2, angle: p.angle, w: half * 2, d: LEAD });
    }
    const blocked = (x: number, z: number, m: number) => keepOut.some((r) => distToRect(x, z, r.x, r.z, r.angle, r.w / 2, r.d / 2) < m);
    // (an entrance's street may join a street closer than a street can be long, e.g. its old one: further along it)
    const near = side ? 1.05 : 0;
    // candidate road points: along every road near the forecourt, nearest first, outside the keep-out areas
    const cands: { e: NEdge; s: number; d: number }[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (const e of net.edgesNear(fx - reach, fz - reach, fx + reach, fz + reach)) {
      if (e.kind !== 'road' || e.depot >= 0) continue;
      let best: { s: number; d: number } | null = null;
      for (let s = 0; s <= e.len; s += Math.min(2, Math.max(0.5, e.len / 4))) {
        net.pointAt(e, s, p);
        const d = Math.hypot(p.x - fx, p.z - fz);
        if (d > reach || d < near || blocked(p.x, p.z, 0.6) || net.sectionAt(e, s) !== 'ground' || across(p.x, p.z)) continue;
        if (!best || d < best.d) best = { s, d };
      }
      if (best) cands.push({ e, ...best });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 6)) {
      let end: Snap;
      if (c.s < 0.8 || c.s > c.e.len - 0.8) { const n = net.nodes.get(c.s < 0.8 ? c.e.a : c.e.b)!; end = { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }; }
      else { net.pointAt(c.e, c.s, p); end = { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: c.e.id, s: c.s }; }
      const start: Snap = { kind: 'free', x: fx, z: fz, y: g.world.heightAt(fx, fz) };
      const prop = planEdge(g, start, end, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner });
      if (!prop.ok) continue;
      // (an entrance's street is walked: at ground level from its door, no cutting below the ground into a tunnel)
      if (side && prop.tracks.some((t) => t.sections.length || Math.abs(t.prof[0] - start.y) > 0.3)) continue;
      const tp = prop.tracks[0];
      let hit = false;
      for (let i = 1; i <= 24 && !hit; i++) {
        bezPoint(tp.bez, i / 24, p);
        if (Math.hypot(p.x - fx, p.z - fz) > 0.7 && blocked(p.x, p.z, 0.45)) hit = true;
      }
      if (!hit) return prop;
    }
    return null;
  }

  /** Viaduct columns under an elevated deck, rows every ~6 units, shifted to miss roads and tracks below. */
  private viaductPiers(fp: Rect, width: number, demolish: Set<number>, ignore?: number, ignoreEdges?: Set<number>): { piers: { x: number; z: number }[]; error?: string } {
    const w = this.game.world, net = w.net;
    const fx = Math.sin(fp.angle), fz = Math.cos(fp.angle), rx = fz, rz = -fx;
    const L = fp.d, rows = Math.max(2, Math.ceil((L - 0.8) / 6) + 1);
    const lats = width >= 1.3 ? [-(width / 2 - 0.35), width / 2 - 0.35] : [0];
    const piers: { x: number; z: number }[] = [];
    const clear = (px: number, pz: number) => {
      for (const e of net.edgesNear(px - 1.5, pz - 1.5, px + 1.5, pz + 1.5)) {
        if (ignoreEdges?.has(e.id) || ignore !== undefined && e.station === ignore) continue;
        const geo = net.geo(e), hw = net.halfWidth(e);
        for (let i = 0; i < geo.n; i++) if (Math.hypot(geo.pts[i * 3] - px, geo.pts[i * 3 + 2] - pz) < hw + 0.3) return false;
      }
      return true;
    };
    for (let k = 0; k < rows; k++) {
      const a0 = -L / 2 + 0.4 + ((L - 0.8) * k) / (rows - 1);
      let placed = false;
      for (const sh of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
        const a = Math.max(-L / 2 + 0.3, Math.min(L / 2 - 0.3, a0 + sh));
        const cols = lats.map((l) => ({ x: fp.x + fx * a + rx * l, z: fp.z + fz * a + rz * l }));
        if (!cols.every((c) => clear(c.x, c.z))) continue;
        for (const c of cols) {
          piers.push(c);
          for (const b of w.buildingsNear(c.x, c.z, 1)) if (distToRect(c.x, c.z, b.x, b.z, b.angle, b.w / 2 + 0.25, b.d / 2 + 0.25) <= 0) demolish.add(b.id);
        }
        placed = true;
        break;
      }
      if (!placed && (k === 0 || k === rows - 1)) return { piers, error: 'Roads or tracks block viaduct piers' };
    }
    return { piers };
  }

  private curvedPiers(r: StationGeometry, width: number, demolish: Set<number>, ignore?: number, ignoreEdges?: Set<number>) {
    const net = this.game.world.net, piers: { x: number; z: number }[] = [];
    const rows = Math.max(2, Math.ceil((r.length - 0.8) / 6) + 1), lats = width >= 1.3 ? [-(width / 2 - 0.35), width / 2 - 0.35] : [0];
    const clear = (x: number, z: number) => {
      for (const e of net.edgesNear(x - 1.5, z - 1.5, x + 1.5, z + 1.5)) {
        if (ignoreEdges?.has(e.id) || ignore !== undefined && e.station === ignore) continue;
        const geo = net.geo(e), hw = net.halfWidth(e);
        for (let i = 0; i < geo.n; i++) if (Math.hypot(geo.pts[i * 3] - x, geo.pts[i * 3 + 2] - z) < hw + 0.3) return false;
      }
      return true;
    };
    for (let i = 0; i < rows; i++) {
      const along = -r.length / 2 + 0.4 + (r.length - 0.8) * i / (rows - 1);
      let found = false;
      for (const shift of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
        const a = Math.max(-r.length / 2 + 0.3, Math.min(r.length / 2 - 0.3, along + shift));
        const cols = lats.map((off) => stationPose(r, off, a));
        if (!cols.every((p) => clear(p.x, p.z))) continue;
        for (const p of cols) {
          piers.push({ x: p.x, z: p.z });
          for (const b of this.game.world.buildingsNear(p.x, p.z, 1)) if (distToRect(p.x, p.z, b.x, b.z, b.angle, b.w / 2 + 0.25, b.d / 2 + 0.25) <= 0) demolish.add(b.id);
        }
        found = true; break;
      }
      if (!found && (i === 0 || i === rows - 1)) return { piers, error: 'Roads or tracks block viaduct piers' };
    }
    return { piers };
  }

  /** Is (x, z) within `r` of a road that belongs to a real road network (not just an isolated stub)? */
  private roadContact(x: number, z: number, r: number): boolean {
    const net = this.game.world.net;
    const ne = net.nearestEdge(x, z, r, 'road', pedestrianRoad);
    if (!ne) return false;
    // connected: at least ~20 units of road reachable from it
    const seen = new Set<number>([ne.edge.id]);
    const queue = [ne.edge];
    let len = 0;
    while (queue.length && seen.size < 48) {
      const e = queue.pop()!;
      len += e.len;
      if (len >= 20) return true;
      for (const nid of [e.a, e.b]) for (const id of net.nodes.get(nid)?.edges ?? []) {
        if (seen.has(id)) continue;
        const f = net.edges.get(id);
        if (f && pedestrianRoad(f)) { seen.add(id); queue.push(f); }
      }
    }
    return len >= 20;
  }

  /**
   * Entrance sites for an underground / elevated station: beside roads (on the sidewalk, facing the street)
   * near the platform ends, else on free land beside the platform ends (without road access).
   */
  private entranceSites(level: 'underground' | 'elevated', fp: Rect, want: number, taken: Entrance[], ignore?: number, reach?: number, memo = false): (Entrance & { access: boolean; demolish: number[] })[] {
    const w = this.game.world, net = w.net;
    const memoContext = memo ? this.entranceMemoContext() : undefined;
    const siteKey = memoContext && !taken.length ? [level, fp.x, fp.z, fp.angle, fp.w, fp.d, want, ignore ?? '', reach ?? ''].join(':') : undefined;
    if (siteKey && memoContext!.sites.has(siteKey)) {
      memoContext!.siteHits++;
      return memoContext!.sites.get(siteKey)!.map(e => ({ ...e, demolish: [...e.demolish] }));
    }
    if (siteKey) memoContext!.siteMisses++;
    const sz = ENTRANCE_SIZE[level];
    const maxD = reach ?? (level === 'elevated' ? 6 : 12);
    const fx = Math.sin(fp.angle), fz = Math.cos(fp.angle), rx = fz, rz = -fx;
    const R = fp.d / 2 + maxD + 4;
    type Cand = Entrance & { access: boolean; demolish: number[]; gap: number };
    const cands: Cand[] = [];
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    if (memoContext) {
      for (const e of net.edgesNear(fp.x - R, fp.z - R, fp.x + R, fp.z + R)) {
        if (e.kind !== 'road' || e.depot >= 0) continue;
        for (const c of this.entranceRoadSamples(level, e, memoContext, ignore)) {
          const gap = distToRect(c.x, c.z, fp.x, fp.z, fp.angle, fp.w / 2, fp.d / 2) - sz.d / 2;
          if (gap > maxD) continue;
          // Deck overlap depends on this station, unlike the environment around the roadside landing.
          if (level === 'elevated' && rectsOverlap({ x: c.x, z: c.z, angle: c.angle, ...sz }, fp, 0.05)) continue;
          if (c.dem === undefined) { memoContext.misses++; c.dem = this.entranceFree(level, c.x, c.z, c.angle, fp, e.id, ignore); }
          else memoContext.hits++;
          if (c.dem === null) continue;
          cands.push({ x: c.x, z: c.z, angle: c.angle, access: true, demolish: [...c.dem], gap });
        }
      }
    } else {
      for (const e of net.edgesNear(fp.x - R, fp.z - R, fp.x + R, fp.z + R)) {
        if (e.kind !== 'road' || e.depot >= 0) continue;
        const hw = net.halfWidth(e), ra = net.junctionRadius(e.a) + 0.5, rb = net.junctionRadius(e.b) + 0.5;
        for (let s = ra; s <= e.len - rb; s += 0.8) {
          if (net.sectionAt(e, s) !== 'ground') continue;
          net.pointAt(e, s, p, d);
          const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
          for (const side of [1, -1]) {
            const off = hw + sz.d / 2 + 0.06;
            const cx = p.x + nx * off * side, cz = p.z + nz * off * side;
            const gap = distToRect(cx, cz, fp.x, fp.z, fp.angle, fp.w / 2, fp.d / 2) - sz.d / 2;
            if (gap > maxD) continue;
            const ang = angleOf(-nx * side, -nz * side);
            const dem = this.entranceFree(level, cx, cz, ang, fp, e.id, ignore);
            if (!dem) continue;
            cands.push({ x: cx, z: cz, angle: ang, access: true, demolish: dem, gap });
          }
        }
      }
    }
    const targets = [
      { x: fp.x + fx * fp.d / 2, z: fp.z + fz * fp.d / 2 }, { x: fp.x - fx * fp.d / 2, z: fp.z - fz * fp.d / 2 },
      { x: fp.x + rx * (fp.w / 2 + 2), z: fp.z + rz * (fp.w / 2 + 2) }, { x: fp.x - rx * (fp.w / 2 + 2), z: fp.z - rz * (fp.w / 2 + 2) },
    ].slice(0, Math.max(2, want));
    const chosen: (Entrance & { access: boolean; demolish: number[] })[] = [];
    const farFrom = (c: Entrance) => [...taken, ...chosen].every((q) => Math.hypot(q.x - c.x, q.z - c.z) >= 4);
    for (const t of targets) {
      let best: Cand | null = null, bs = Infinity;
      for (const c of cands) {
        if (!farFrom(c)) continue;
        const score = Math.hypot(c.x - t.x, c.z - t.z) + c.gap * 1.5 + c.demolish.length * 25;
        if (score < bs) { bs = score; best = c; }
      }
      if (best) chosen.push({ x: best.x, z: best.z, angle: best.angle, access: true, demolish: best.demolish });
    }
    if (!chosen.length) {
      // no street within reach: entrances on free land beside the platform ends (no road access yet)
      for (const t of targets.slice(0, 2)) for (const side of [1, -1]) {
        if (chosen.some((c) => Math.hypot(c.x - t.x, c.z - t.z) < fp.w + 3)) break;
        const off = fp.w / 2 + sz.d / 2 + 0.5;
        const cx = t.x + rx * off * side, cz = t.z + rz * off * side;
        const ang = angleOf(rx * side, rz * side);
        const dem = (memo ? this.memoEntranceFree(level, cx, cz, ang, fp, -1, ignore, memoContext) : this.entranceFree(level, cx, cz, ang, fp, -1, ignore));
        if (dem && !dem.length && farFrom({ x: cx, z: cz, angle: ang })) chosen.push({ x: cx, z: cz, angle: ang, access: false, demolish: [] });
      }
    }
    if (siteKey) {
      if (memoContext!.sites.size >= 512) memoContext!.sites.clear();
      memoContext!.sites.set(siteKey, chosen.map(e => ({ ...e, demolish: [...e.demolish] })));
    }
    return chosen;
  }

  private curvedEntranceSites(level: 'underground' | 'elevated', r: StationGeometry, width: number, want: number, ignore?: number) {
    const out: (Entrance & { access: boolean; demolish: number[] })[] = [], area = stationStripRects(r, 0, width);
    for (const along of [-r.length / 2 + 0.7, r.length / 2 - 0.7, 0]) {
      const p = stationPose(r, 0, along), fp = { x: p.x, z: p.z, angle: p.angle, w: width, d: Math.min(1.4, r.length) };
      for (const e of this.entranceSites(level, fp, 2, out, ignore)) {
        const sz = ENTRANCE_SIZE[level], rect = { x: e.x, z: e.z, angle: e.angle, w: sz.w, d: sz.d };
        if (level === 'elevated' && area.some((f) => rectsOverlap(rect, f, 0.05))) continue;
        if (out.every((q) => Math.hypot(q.x - e.x, q.z - e.z) >= 4)) out.push(e);
        if (out.length >= want) return out;
      }
    }
    return out;
  }

  private entranceMemoContext(): EntranceMemo {
    const g = this.game, w = g.world;
    const epoch = [w.net.version, w.heightsVersion, w.lotVersions.version, this.walkVersion, this.map.size,
      g.networkVersion, g.depots.map.size, entranceRevisions.get(this) ?? 0].join(':');
    let state = entranceMemos.get(this);
    if (!state || state.world !== w || state.net !== w.net || state.stations !== this.map || state.depots !== g.depots.map || state.epoch !== epoch) {
      state = { world: w, net: w.net, stations: this.map, depots: g.depots.map, epoch, memo: new Map(), roads: new Map(), roadCount: 0,
        sites: new Map(), siteHits: state?.siteHits ?? 0, siteMisses: state?.siteMisses ?? 0, hits: state?.hits ?? 0, misses: state?.misses ?? 0 };
      entranceMemos.set(this, state);
    }
    return state;
  }

  /** Same native road sampling order as entranceSites; eligibility remains specific to each footprint. */
  private entranceRoadSamples(level: 'underground' | 'elevated', e: NEdge, memo: EntranceMemo, ignore?: number): EntranceRoadSample[] {
    const key = [level, e.id, ignore ?? ''].join(':');
    const found = memo.roads.get(key);
    if (found) return found;
    const net = this.game.world.net, sz = ENTRANCE_SIZE[level], samples: EntranceRoadSample[] = [];
    const hw = net.halfWidth(e), ra = net.junctionRadius(e.a) + 0.5, rb = net.junctionRadius(e.b) + 0.5;
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    for (let s = ra; s <= e.len - rb; s += 0.8) {
      if (net.sectionAt(e, s) !== 'ground') continue;
      net.pointAt(e, s, p, d);
      const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
      for (const side of [1, -1]) {
        const off = hw + sz.d / 2 + 0.06;
        samples.push({ x: p.x + nx * off * side, z: p.z + nz * off * side, angle: angleOf(-nx * side, -nz * side) });
      }
    }
    if (memo.roadCount + samples.length > 32768) { memo.roads.clear(); memo.roadCount = 0; }
    if (samples.length <= 32768) { memo.roads.set(key, samples); memo.roadCount += samples.length; }
    return samples;
  }

  private memoEntranceFree(level: 'underground' | 'elevated', x: number, z: number, angle: number, fp: Rect, road: number,
    ignore?: number, context?: EntranceMemo): number[] | null {
    if (level === 'elevated' && rectsOverlap({ x, z, angle, ...ENTRANCE_SIZE[level] }, fp, 0.05)) return null;
    const state = context ?? this.entranceMemoContext(), key = [level, x, z, angle, road, ignore ?? ''].join(':');
    if (state.memo.has(key)) { state.hits++; const result = state.memo.get(key)!; return result === null ? null : [...result]; }
    state.misses++;
    const result = this.entranceFree(level, x, z, angle, fp, road, ignore);
    if (state.memo.size >= 8192) state.memo.clear();
    state.memo.set(key, result === null ? null : [...result]);
    return result;
  }

  /** Read-only diagnostics for the bounded derived cache. Does not prime a default/UI query. */
  private entranceMemoStats() {
    const m = entranceMemos.get(this);
    return m ? { hits: m.hits, misses: m.misses, size: m.memo.size, siteHits: m.siteHits, siteMisses: m.siteMisses,
      siteSize: m.sites.size, roadCount: m.roadCount, roadSize: m.roads.size, revision: entranceRevisions.get(this) ?? 0 } : null;
  }

  /** Can an entrance stand at (x, z)? Returns the buildings it replaces (small houses only) or null. */
  private entranceFree(level: 'underground' | 'elevated', x: number, z: number, angle: number, fp: Rect, road: number, ignore?: number): number[] | null {
    const w = this.game.world;
    const sz = ENTRANCE_SIZE[level];
    const rect: Rect = { x, z, angle, w: sz.w, d: sz.d };
    if (!w.inside(x, z, 3)) return null;
    const fxa = Math.sin(angle), fza = Math.cos(angle), rxa = fza, rza = -fxa;
    let mn = Infinity, mx = -Infinity;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const h = w.heightAt(x + rxa * sz.w * a + fxa * sz.d * b, z + rza * sz.w * a + fza * sz.d * b);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    if (mn < WATER_Y + 0.15 || mx - mn > 0.6) return null;
    if (level === 'elevated' && rectsOverlap(rect, fp, 0.05)) return null;
    const dem = new Set<number>();
    const err = this.rectConflict(rect, mn - 0.2, mx + 0.8, dem, { skipRoad: road, ignoreStation: ignore });
    if (err) return null;
    for (const id of dem) if ((w.buildings.get(id)?.pop ?? 0) > 30) return null;
    return [...dem];
  }

  /** Build a planned rail station (a new station, or the rail part of a joined stop station). */
  commitRail(plan: StationPlan, owner: number): string | null {
    const g = this.game;
    if (!plan.ok) return plan.error ?? 'Cannot build';
    const co = g.company(owner);
    if (!co.economy.canAfford(plan.cost)) return 'Not enough money';
    const accessCost = plan.access ? plan.access.cost : 0;
    co.economy.spend(plan.cost - accessCost, 'construction');
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const join = plan.join && this.map.get(plan.join.id) === plan.join ? plan.join : null;
    const st = join ?? this.create(plan.x, plan.z, owner);
    this.buildRailPart(st, plan, owner);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    for (const o of plan.links) if (this.map.get(o.id) === o && !this.canLink(st.id, o.id) && this.nearbyComplex(st, o)) this.addLink(st, o);
    this.autoLinkNearby(st);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  /** Attach a preflighted facility to retained rail. Never lay, remove, rewire or transfer its running tracks. */
  commitNativeRail(plan: StationPlan, owner: number, groups: RailTrackGroup[], accessCommitted = false): { error: string | null; station: number } {
    const g = this.game, net = g.world.net, eco = g.company(owner).economy;
    if (!plan.ok || !plan.alignment) return { error: plan.error ?? 'No retained station geometry', station: -1 };
    if (!eco.canAfford(plan.cost - (accessCommitted ? plan.access?.cost ?? 0 : 0))) return { error: 'Not enough money', station: -1 };
    // The access proposal was checked against the complete swept station keep-out area.
    if (plan.access && !accessCommitted) { const err = commitProposal(g, plan.access); if (err) return { error: err, station: -1 }; }
    eco.spend(plan.cost - (plan.access?.cost ?? 0), 'construction');
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const st = plan.join && this.map.get(plan.join.id) === plan.join ? plan.join : this.create(plan.x, plan.z, owner);
    const edges = groups.filter((q) => !q.through).flatMap((q) => q.steps.map((s) => s.edge));
    const through = groups.filter((q) => q.through).flatMap((q) => q.steps.map((s) => s.edge));
    st.rail = { ...this.partOf(plan, edges, through), native: true, groups: groups.map((q) => ({ ...q, steps: q.steps.map((s) => ({ ...s })) })) };
    st.x = plan.x; st.z = plan.z;
    if (planWalkScale(plan) !== 1) st.city = true; else delete st.city;
    for (const q of groups) for (const step of q.steps) {
      const e = net.edges.get(step.edge)!;
      e.station = q.through ? -1 : st.id; net.touchEdge(e);
    }
    if (plan.level === 'ground') this.levelGround(plan);
    for (const f of this.footprints(st)) {
      if (f.part === 'entrance' || f.part === 'building') this.padGround(f);
      g.world.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.3);
    }
    this.repairSite(st);
    for (const o of plan.links) if (this.map.get(o.id) === o && !this.canLink(st.id, o.id) && this.nearbyComplex(st, o)) this.addLink(st, o);
    this.autoLinkNearby(st);
    this.markStation(st); this.accessVersion = -1;
    g.onNetworkChanged(); g.lines.rebuild();
    return { error: null, station: st.id };
  }

  /** Lay the platform edges of a plan for station `st` and shape the site. */
  private buildRailPart(st: Station, plan: StationPlan, owner: number, reuse?: Map<string, number>) {
    const g = this.game, w = g.world, net = w.net;
    const fx = Math.sin(plan.angle), fz = Math.cos(plan.angle), rx = fz, rz = -fx;
    const L = plan.length;
    const edges: NEdge[] = [], through: NEdge[] = [];
    const sec: Section[] = plan.level === 'underground' ? [{ s0: 0, s1: L, type: 'tunnel' }] : plan.level === 'elevated' ? [{ s0: 0, s1: L, type: 'bridge' }] : [];
    // platform tracks (station edges), then through tracks (ordinary edges); reused end nodes by '<i>:f|b' / 'T<i>:f|b'
    const lay = (off: number, key: string, station: number) => {
      const cx = plan.x + rx * off, cz = plan.z + rz * off;
      const ax = cx - fx * L / 2, az = cz - fz * L / 2, bx = cx + fx * L / 2, bz = cz + fz * L / 2;
      const ra = reuse?.get(key + ':b'), rb = reuse?.get(key + ':f');
      const na = ra !== undefined && net.nodes.get(ra) ? net.nodes.get(ra)! : net.addNode('rail', ax, plan.y, az, fx, fz, owner);
      const nb = rb !== undefined && net.nodes.get(rb) ? net.nodes.get(rb)! : net.addNode('rail', bx, plan.y, bz, fx, fz, owner);
      const len = Math.hypot(nb.x - na.x, nb.z - na.z);
      const m = Math.max(2, Math.ceil(len) + 1);
      const prof = new Float32Array(m).fill(plan.y);
      prof[0] = na.y; prof[m - 1] = nb.y;
      return net.addEdge('rail', na.id, nb.id, bezLine(na.x, na.z, nb.x, nb.z), prof, sec.map((s) => ({ ...s, s1: len })), plan.trackType ?? 'standard', owner, { station });
    };
    plan.layout.trackOffsets.forEach((off, i) => edges.push(lay(off, String(i), st.id)));
    plan.layout.throughOffsets.forEach((off, i) => through.push(lay(off, 'T' + i, -1)));
    const level = plan.level;
    st.rail = this.partOf(plan, edges.map((e) => e.id), through.map((e) => e.id));
    // (in town: the plan's standing, which a rebuild or move worked out from the station's own)
    if (planWalkScale(plan) !== 1) st.city = true; else delete st.city;
    st.x = plan.x; st.z = plan.z;
    if (level === 'ground') {
      this.levelGround(plan);
      applyEarthworks(w, [...edges, ...through]);
      for (const f of this.footprints(st)) w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.5);
    } else {
      // street level: pads under the entrances (and piers); trees under an elevated deck are cleared
      for (const f of this.footprints(st)) {
        if (f.part === 'deck') { w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.3); continue; }
        if (f.part === 'entrance' || f.part === 'building') this.padGround(f);
        w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.4);
      }
    }
    // the levelled site may have reshaped the ground under track and roads beside it: their formations again
    this.repairSite(st);
    w.markObjArea(plan.x - L - 30, plan.z - L - 30, plan.x + L + 30, plan.z + L + 30);
    this.markStation(st);
  }

  /** The rail part a plan builds, with its platform and through track edges (none: a planned part, for previews). */
  private partOf(plan: StationPlan, edges: number[], through: number[]): RailPart {
    const level = plan.level;
    return {
      x: plan.x, z: plan.z, y: plan.y, angle: plan.angle, length: plan.length, tracks: plan.tracks,
      trackOffsets: plan.layout.trackOffsets, platforms: plan.layout.platforms, edges,
      through: plan.layout.throughOffsets.length, throughOffsets: plan.layout.throughOffsets, throughEdges: through, width: plan.layout.width, throughMode: plan.throughMode,
      trackType: trackTypeOf(plan.trackType), mode: plan.mode ?? railModeOf(plan.trackType), platformStyle: plan.platformStyle ?? 'island', psd: !!plan.psd,
      style: plan.style ?? 'classic', forecourt2: plan.forecourt2 ?? undefined,
      building: plan.building,
      ...(plan.alignment ? { alignment: plan.alignment } : {}),
      level, underground: level === 'underground', depth: plan.depth, height: plan.height,
      entrances: plan.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle })), piers: plan.piers.map((p) => ({ ...p })),
      forecourt: plan.forecourt ?? undefined, cost: plan.cost,
    };
  }

  /** Flatten the ground under a small street-level structure. */
  private padGround(f: Rect) {
    const w = this.game.world;
    let sum = 0, n = 0;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const fx = Math.sin(f.angle), fz = Math.cos(f.angle);
      sum += w.heightAt(f.x + fz * f.w * a + fx * f.d * b, f.z - fx * f.w * a + fz * f.d * b); n++;
    }
    const target = sum / n;
    const R = Math.hypot(f.w, f.d) / 2 + 1;
    for (let z = Math.floor(f.z - R); z <= Math.ceil(f.z + R); z++) for (let x = Math.floor(f.x - R); x <= Math.ceil(f.x + R); x++) {
      if (x < 1 || z < 1 || x >= w.size || z >= w.size) continue;
      const k = w.vi(x, z);
      if (w.lock[k]) continue;
      const d = distToRect(x, z, f.x, f.z, f.angle, f.w / 2 + 0.2, f.d / 2 + 0.2);
      const wgt = d <= 0 ? 1 : Math.max(0, 1 - d / 1.2);
      if (wgt > 0) {
        const cur = w.h[k];
        let v = cur + (target - cur) * wgt;
        if (v < cur && v < DRY_MIN) v = Math.min(cur, DRY_MIN);
        w.setVertex(x, z, v);
      }
    }
  }

  /** Re-grade the formations of track and roads around a station site (after levelling or removing it). */
  private repairSite(st: { x: number; z: number; rail: { length: number; width?: number; building?: Rect; entrances?: Entrance[] } | null }) {
    const r = st.rail;
    const R = (r ? r.length / 2 + (r.width ?? 2) : 4) + 8;
    let x0 = st.x - R, z0 = st.z - R, x1 = st.x + R, z1 = st.z + R;
    // An extra entrance may lie up to ENTRANCE_REACH away from the platforms.
    const extend = (f: { x: number; z: number }, pad: number) => {
      x0 = Math.min(x0, f.x - pad); z0 = Math.min(z0, f.z - pad);
      x1 = Math.max(x1, f.x + pad); z1 = Math.max(z1, f.z + pad);
    };
    for (const f of r?.entrances ?? []) extend(f, 4);
    if (r?.building) extend(r.building, Math.hypot(r.building.w, r.building.d) / 2 + 3);
    repairFormations(this.game.world, x0, z0, x1, z1);
  }

  private levelGround(plan: StationPlan) {
    const w = this.game.world;
    const rects = plan.alignment ? [...stationStripRects(plan, 0, plan.layout.width), plan.building] : [plan.footprint, plan.building];
    const R = Math.hypot(plan.footprint.w, plan.footprint.d) / 2 + 6;
    for (let z = Math.floor(plan.z - R); z <= Math.ceil(plan.z + R); z++) for (let x = Math.floor(plan.x - R); x <= Math.ceil(plan.x + R); x++) {
      if (x < 1 || z < 1 || x >= w.size || z >= w.size) continue;
      let d = Infinity;
      for (const r of rects) d = Math.min(d, distToRect(x, z, r.x, r.z, r.angle, r.w / 2 + 0.3, r.d / 2 + 0.3));
      const k = w.vi(x, z);
      if (w.lock[k] & (LOCK.building | LOCK.formation)) continue;
      const cur = w.h[k];
      const target = plan.y - 0.1;
      const ext = Math.min(5, Math.abs(target - cur) * 1.6 + 0.6);
      if (d > ext) continue;
      const f = d / ext;
      const wgt = d <= 0 ? 1 : 1 - f * f * (3 - 2 * f);
      let v = cur + (target - cur) * wgt;
      if (v < cur && v < DRY_MIN) v = Math.min(cur, DRY_MIN);
      w.setVertex(x, z, v);
      if (d <= 0) w.lock[k] |= LOCK.formation;
    }
  }

  /** Remove a whole station (platform edges, stops). */
  removeStation(id: number): string | null {
    const g = this.game;
    const st = this.map.get(id);
    if (!st) return null;
    if (st.rail) for (const eid of [...st.rail.edges, ...st.rail.throughEdges]) if (g.vehicles.isEdgeBusy(eid)) return 'Train in the station';
    const hold = this.holds.get(id);
    if (hold) { releaseHold(g, hold.edges); this.holds.delete(id); }
    const site = st.rail ? { x: st.x, z: st.z, rail: st.rail } : null;
    if (st.rail) for (const eid of [...st.rail.edges, ...st.rail.throughEdges]) {
      if (st.rail.native) { const e = g.world.net.edges.get(eid); if (e && e.station === st.id) { e.station = -1; g.world.net.touchEdge(e); } }
      else g.world.net.removeEdge(eid);
    }
    this.markStation(st);
    st.rail = null;
    this.deleteStation(id);
    if (site) this.repairSite(site);
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  // ---------------------------------------------------------------- entrances and road access
  /**
   * Plan an extra entrance for a station near (x, z). Below / above the street: an entrance pavilion / stair tower
   * beside a road (snapped to its sidewalk, facing the street) within ENTRANCE_REACH of the platforms. Ground
   * stations: an entrance of `kind` (default a side hall) beside the track area on the side of (x, z), at its
   * position along the platforms (a gate at the nearer platform end); a footbridge or underpass also gets stairs on
   * the other side of the tracks where there is room. Nothing may be in the way (tracks, roads, buildings, other
   * structures); a road must reach one of its landings, else an access street is planned from the door on the
   * clicked side to a road within reach (`street: false`: none is planned, the plan fails with `door` set). Pure.
   */
  planEntrance(stationId: number, x: number, z: number, owner: number, kind?: EntranceKind, o: { street?: boolean } = {}): EntrancePlan {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId);
    const r = st?.rail;
    const lv0 = r?.level ?? 'ground';
    const none = (error: string, k: EntranceKind = lv0 === 'elevated' ? 'tower' : lv0 === 'underground' ? 'pavilion' : 'hall'): EntrancePlan => ({ ok: false, error, warnings: [], kind: k, cost: 0, access: null, landings: [] });
    if (!st || !r) return none('No such rail station');
    if (st.owner !== owner) return none('Not your station');
    const lv = r.level ?? 'ground';
    if (lv === 'ground') return this.planGroundEntrance(st, x, z, owner, kind, o);
    // below / above the street: a pavilion or stair tower beside a road
    const k: EntranceKind = lv === 'elevated' ? 'tower' : 'pavilion';
    const sz = ENTRANCE_SIZE[lv];
    const ne = net.nearestEdge(x, z, 3, 'road', (e) => e.depot < 0);
    if (!ne) return none('Entrances go beside a road', k);
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, p, d);
    const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
    const side = (x - p.x) * nx + (z - p.z) * nz >= 0 ? 1 : -1;
    const off = net.halfWidth(ne.edge) + sz.d / 2 + 0.06;
    const ex = p.x + nx * off * side, ez = p.z + nz * off * side, ang = angleOf(-nx * side, -nz * side);
    const fp = this.platformRect(st)!;
    if (this.platformAreas(st).every((f) => distToRect(ex, ez, f.x, f.z, f.angle, f.w / 2, f.d / 2) > ENTRANCE_REACH)) return none(`Too far from platforms · max ${ENTRANCE_REACH * 10} m`, k);
    if (r.entrances.some((q) => Math.hypot(q.x - ex, q.z - ez) < 3)) return none('Another entrance is too close', k);
    // the station's own street-level structures first (entranceFree ignores the station): its hall, its forecourt,
    // its entrances and an elevated deck's piers
    const own = this.ownStreetError(st, { x: ex, z: ez, angle: ang, w: sz.w, d: sz.d });
    if (own) return none(own, k);
    if (lv === 'elevated' && this.platformAreas(st).some((f) => rectsOverlap({ x: ex, z: ez, angle: ang, w: sz.w, d: sz.d }, f, 0.15))) return none('Entrance overlaps the station deck', k);
    const dem = this.entranceFree(lv, ex, ez, ang, r.alignment ? { ...fp, w: 0, d: 0 } : fp, ne.edge.id, st.id);
    if (!dem || dem.length) return none('Something is in the way', k);
    const cost = entranceCost(k, r);
    return { ok: true, warnings: [], kind: k, entrance: { x: ex, z: ez, angle: ang, kind: k, cost }, cost, access: null, landings: [{ x: ex, z: ez, angle: ang, road: true }] };
  }

  /** Why a structure at street level would stand on a station's own hall, forecourt, entrance or viaduct pier (null: clear). */
  private ownStreetError(st: Station, rect: Rect): string | null {
    const r = st.rail!;
    for (const f of this.structures(st)) {
      if ((f.part === 'building' || f.part === 'entrance' || f.part === 'pier') && rectsOverlap(rect, f, 0.1))
        return f.part === 'building' ? 'The station hall is in the way' : f.part === 'pier' ? 'A viaduct pier is in the way' : 'Another entrance is in the way';
    }
    if (styleOf(r.style).placement !== 'none') for (const f of [r.forecourt, r.forecourt2]) {
      if (f && distToRect(f.x, f.z, rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2) < 0.6) return 'In front of the station hall';
    }
    return null;
  }

  /** A ground station's entrance (see planEntrance). */
  private planGroundEntrance(st: Station, x: number, z: number, owner: number, kind: EntranceKind | undefined, o: { street?: boolean }): EntrancePlan {
    const r = st.rail!;
    const k: EntranceKind = kind ?? 'hall';
    const bad = (error: string, extra: Partial<EntrancePlan> = {}): EntrancePlan => ({ ok: false, error, warnings: [], kind: k, cost: 0, access: null, landings: [], ...extra });
    if (!GROUND_ENTRANCES.includes(k)) return bad(`${ENTRANCE_TYPES[k]?.name.toLowerCase() ?? 'street entrance'} needs an elevated or underground station`);
    const T = ENTRANCE_TYPES[k];
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const local = stationLocal(r, x, z), lat = local.off, lon = local.along;
    if (Math.abs(lon) > r.length / 2 + 8 || Math.abs(lat) > railWidth(r) / 2 + 12) return bad('Too far from the platforms');
    const side: 1 | -1 = lat >= 0 ? 1 : -1;
    const { along, near, far } = this.groundSites(r, k, side, lon);
    const err = this.stairsError(r, k, along) ?? this.landingError(st, k, near);
    if (err) return bad(err, { landings: [{ ...near, road: false }] });
    const both = T.twoSided && !this.landingError(st, k, far);
    const landings = both ? [near, far] : [near];
    const road = landings.map((p) => this.landingOnStreet(k, p));
    const own = entranceCost(k, r);
    const entrance: Entrance = { x: near.x, z: near.z, angle: near.angle, kind: k, ...(both ? { far } : {}), cost: own };
    const warnings: string[] = [];
    if (T.twoSided && !both) warnings.push('No room for stairs across tracks');
    let access: Proposal | null = null;
    if (!road.some(Boolean)) {
      const door = landingDoor(k, near);
      const marks = landings.map((p) => ({ ...p, road: false }));
      if (o.street === false) return bad('No road beside the entrance', { entrance, door, landings: marks, cost: own });
      const fp = this.platformRect(st)!;
      access = this.planAccessStreet(door.x, door.z, { x: r.x, z: r.z, y: r.y, angle: r.angle, length: r.length, alignment: r.alignment, layout: { width: railWidth(r) }, footprint: fp, building: r.building }, owner, undefined, landings.map((p) => landingRect(k, p)), side, ENTRANCE_STREET);
      if (!access) return bad(`No road on this side within ${ENTRANCE_STREET * 10} m`, { entrance, door, landings: marks, cost: own });
      road[0] = true;
    } else if (both && !road[0]) warnings.push('No road beside stairs on this side');
    else if (both && !road[1]) warnings.push('No road beside stairs across tracks');
    return { ok: true, warnings, kind: k, entrance, cost: own + (access?.cost ?? 0), access, landings: landings.map((p, i) => ({ ...p, road: road[i] })), ...(access ? { door: landingDoor(k, near) } : {}) };
  }

  /** A ground entrance's sites beside the track area: on `side`, at `lon` along the axis (a gate: at the nearer platform end). */
  private groundSites(r: RailPart, kind: EntranceKind, side: 1 | -1, lon: number) {
    const T = ENTRANCE_TYPES[kind], fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const lim = Math.max(0, r.length / 2 - ENTRANCE_END), off = railWidth(r) / 2 + T.d / 2 + ENTRANCE_GAP;
    const along = kind === 'gate' ? (lon >= 0 ? 1 : -1) * Math.max(0, r.length / 2 - T.w / 2 - 0.1) : Math.max(-lim, Math.min(lim, lon));
    const site = (sd: number) => { const p = stationPose(r, off * sd, along); return { x: p.x, z: p.z, angle: angleOf(p.fz * sd, -p.fx * sd) }; };
    return { along, near: site(side), far: site(-side) };
  }

  /**
   * Ground stations: why an entrance with its stairs at `along` would clash with another crossing: added entrances,
   * the station's own footbridge and underpass stairs (station-styles.ts stationCrossings, as drawn), a concourse or a
   * train shed (null: it fits).
   */
  private stairsError(r: RailPart, kind: EntranceKind, along: number): string | null {
    const a = kind === 'gate' ? (along >= 0 ? 1 : -1) * Math.max(0, r.length / 2 - GATE_STAIRS) : along;
    const half = kind === 'footbridge' ? CROSSING_HALF.footbridge : CROSSING_HALF.stairs;
    const clash = (lo: number, hi: number) => a + half + CROSSING_GAP > lo && a - half - CROSSING_GAP < hi;
    for (const e of r.entrances) {
      const x = entranceAlong(r, e), h = entranceKind('ground', e) === 'footbridge' ? CROSSING_HALF.footbridge : CROSSING_HALF.stairs;
      if (Math.abs(x - a) < ENTRANCE_SPACING || clash(x - h, x + h)) return 'Too close to another entrance’s stairs';
    }
    const own = stationCrossings(r);
    if (own.footbridge !== null && clash(own.footbridge - 0.15, own.footbridge + 0.45)) return 'Station’s own footbridge in the way';
    for (const q of own.stairs) if (clash(q.along - CROSSING_HALF.ownStairs, q.along + CROSSING_HALF.ownStairs)) return 'Too close to station’s own stairs';
    const pl = styleOf(r.style).placement, b = r.building, a0 = (b.x - r.x) * Math.sin(r.angle) + (b.z - r.z) * Math.cos(r.angle);
    if (pl === 'over' && Math.abs(a - a0) < b.w / 2 + 0.5) return 'The concourse is in the way';
    // a terminal's train shed covers the platforms from its head building (as build-stations.ts draws it)
    if (pl === 'end' && kind === 'footbridge' && a * (a0 >= 0 ? 1 : -1) > r.length / 2 - Math.min(r.length * 0.72, r.length - 0.6) - 0.4) return 'Train shed in the way: use underpass';
    return null;
  }

  /**
   * Can a ground entrance's landing stand at `p`? Level, dry ground near the platforms' height, clear of the station's
   * own structures and forecourts (of rail part `r`: the station's, or a planned one), of buildings, tracks, roads,
   * other stations and depots. Null if it can, else the reason.
   */
  private landingError(st: Station, kind: EntranceKind, p: { x: number; z: number; angle: number }, r: RailPart = st.rail!): string | null {
    const w = this.game.world, T = ENTRANCE_TYPES[kind];
    const rect = landingRect(kind, p);
    if (!w.inside(p.x, p.z, 3)) return 'Too close to the map edge';
    const fxa = Math.sin(p.angle), fza = Math.cos(p.angle), rxa = fza, rza = -fxa;
    let mn = Infinity, mx = -Infinity, sum = 0;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const h = w.heightAt(p.x + rxa * T.w * a + fxa * T.d * b, p.z + rza * T.w * a + fza * T.d * b);
      mn = Math.min(mn, h); mx = Math.max(mx, h); sum += h;
    }
    if (mn < WATER_Y + 0.15) return 'Water in the way';
    if (mx - mn > 0.6) return 'The ground is too uneven here';
    if (Math.abs(sum / 5 - r.y) > T.rise) return 'Ground too far above / below platforms';
    for (const f of this.structuresOf(r)) if (rectsOverlap(rect, f, 0.1)) return f.part === 'entrance' ? 'Another entrance is in the way' : 'The station is in the way';
    for (const f of [this.forecourtOf(r), r.forecourt2]) if (f && distToRect(f.x, f.z, rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2) < 0.6) return 'In front of the station building';
    return this.rectConflict(rect, mn - 0.2, kind === 'footbridge' ? Math.max(mx + 0.5, r.y + 1.0) : mx + 0.6, null, { groundEdges: true, ignoreStation: st.id });
  }

  /**
   * After a ground station's rail part was rebuilt in place or merged: its added entrances beside the new track area
   * (`part`: a planned one, previewing), each on its side of the tracks as near as it fits to where it stood along
   * the platforms (the station's own crossings may have moved with it). One a street reached still reaches one: a
   * place a street reaches comes first (with both landings of a crossing that had them), else a short access street
   * from the nearest place, where that costs at most ENTRANCE_RECONNECT of its price and demolishes nothing; else it
   * goes, as one without room does (its price leaves the station's value, its upkeep stops). Fills the part's
   * entrances; unless previewing, builds the streets, grounds the moved landings, and notes the player's losses in
   * the news (`what` the station went through).
   */
  private refitEntrances(st: Station, old: Entrance[], o: { part?: RailPart; preview?: boolean; what?: string } = {}): EntranceRefit {
    const g = this.game, out: EntranceRefit = { fates: [], streets: 0 };
    const r = o.part ?? st.rail, commit = !o.preview;
    if (!r || (r.level ?? 'ground') !== 'ground') return out;
    r.entrances = [];
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), width = railWidth(r);
    const site = { x: r.x, z: r.z, angle: r.angle, length: r.length, layout: { width }, footprint: { x: r.x, z: r.z, angle: r.angle, w: width, d: r.length }, building: r.building };
    type Fit = ReturnType<Stations['groundSites']> & { both: boolean; access: [boolean, boolean]; shift: number };
    for (const e of old) {
      const k = entranceKind('ground', e);
      const go = (fate: 'room' | 'cut') => {
        out.fates.push({ kind: k, fate });
        if (commit && typeof r.cost === 'number') r.cost = Math.max(0, r.cost - (e.cost ?? 0));
      };
      if (!GROUND_ENTRANCES.includes(k)) { go('room'); continue; }
      const lon = (e.x - r.x) * fx + (e.z - r.z) * fz, side = entranceSide(r, e);
      // The landing a street reached (its own side's first: where its walkers come from) must still reach one; the
      // other one keeps its street, and a crossing both landings, where they can.
      const hadNear = this.landingOnStreet(k, e), hadFar = !!e.far && this.landingOnStreet(k, e.far);
      const ess = hadNear ? 0 : hadFar ? 1 : -1;
      const lostEss = (f: Fit) => ess >= 0 && !f.access[ess as 0 | 1], farCut = (f: Fit) => ess === 0 && hadFar && !f.access[1];
      const rank = (f: Fit) => (lostEss(f) ? 4 : 0) + (farCut(f) ? 2 : 0) + (e.far && !f.both ? 1 : 0);
      const fits: Fit[] = [], tried = new Set<number>();
      let best: Fit | null = null;
      for (const shift of k === 'gate' ? [0] : REFIT_SHIFTS) {
        const sites = this.groundSites(r, k, side, lon + shift);
        const at = Math.round(sites.along * 1000);
        if (tried.has(at)) continue;
        tried.add(at);
        if (this.stairsError(r, k, sites.along) || this.landingError(st, k, sites.near, r)) continue;
        const both = !!e.far && !this.landingError(st, k, sites.far, r);
        const f: Fit = { ...sites, both, access: [this.landingOnStreet(k, sites.near), both && this.landingOnStreet(k, sites.far)], shift };
        fits.push(f);
        if (!best || rank(f) < rank(best)) best = f;
        if (rank(f) === 0) break;
      }
      if (!best) { go('room'); continue; }
      let street: Proposal | null = null;
      if (lostEss(best)) {
        // no street reaches that landing where the entrance fits: a short access street from its street side (on
        // its side of the tracks), from the nearest place first
        const price = e.cost ?? entranceCost(k, r);
        const others = r.entrances.flatMap((q) => entranceLandings(q).map((p) => landingRect(entranceKind('ground', q), p)));
        for (const f of [...fits].sort((a, b) => rank(a) - rank(b))) {
          if (ess === 1 && !f.both) continue;
          const lands = f.both ? [f.near, f.far] : [f.near], door = landingDoor(k, lands[ess]);
          const prop = this.planAccessStreet(door.x, door.z, site, st.owner, undefined, [...others, ...lands.map((p) => landingRect(k, p))], ess ? -side : side, ENTRANCE_STREET);
          if (prop && !prop.demolish.length && prop.cost <= price * ENTRANCE_RECONNECT) { street = prop; best = f; break; }
        }
        if (!street || (commit && commitProposal(g, street))) { go('cut'); continue; }
        out.streets += street.cost;
      }
      const { near, far, both } = best;
      const ne: Entrance = { x: near.x, z: near.z, angle: near.angle, kind: k, ...(both ? { far } : {}), ...(e.cost !== undefined ? { cost: e.cost } : {}) };
      r.entrances.push(ne);
      out.fates.push({ kind: k, fate: street ? 'street' : best.shift === 0 ? 'stays' : 'moves', ...(e.far && !both ? { lostFar: true } : farCut(best) ? { farCut: true } : {}) });
      if (commit) {
        const T = ENTRANCE_TYPES[k];
        for (const p of entranceLandings(ne)) {
          this.padGround(landingRect(k, p));
          g.world.removeTreesNear(p.x, p.z, Math.hypot(T.w, T.d) / 2 + 0.6);
          g.world.markObjArea(p.x - 3, p.z - 3, p.x + 3, p.z + 3);
        }
      }
    }
    if (commit) {
      if (r.entrances.length) this.repairSite(st);
      const gone = out.fates.filter((f) => f.fate === 'room' || f.fate === 'cut');
      if (gone.length && !g.company(st.owner).ai) {
        const why = gone.every((f) => f.fate === 'cut') ? 'no street beside new platforms' : gone.every((f) => f.fate === 'room') ? 'no room beside the new platforms' : 'no room or street beside new platforms';
        g.postNews(`${st.name} ${o.what ?? 'rebuilt'}, removing ${gone.length === 1 ? `its ${ENTRANCE_TYPES[gone[0].kind].name.toLowerCase()}` : `${gone.length} entrances`}: ${gone.length === 1 ? why : why.replace(' it ', ' them ')}.`, 'bad', st.x, st.z);
      }
    }
    return out;
  }

  /** What rebuilding a ground station as `plan` (in place, still on the ground) would do to its added entrances. Pure. */
  previewRefit(st: Station, plan: StationPlan): EntranceRefit | null {
    const r = st.rail;
    if (!r || (r.level ?? 'ground') !== 'ground' || plan.level !== 'ground' || !r.entrances.length) return null;
    return this.refitEntrances(st, r.entrances, { part: this.partOf(plan, [], []), preview: true });
  }

  /** Build a planned entrance (planEntrance; the AI's evaluated plans). Null = OK, else the reason. */
  commitEntrance(stationId: number, pl: EntrancePlan, owner: number): string | null {
    const g = this.game;
    if (!pl.ok || !pl.entrance) return pl.error ?? 'Cannot build here';
    const st = this.map.get(stationId), r = st?.rail;
    if (!st || !r) return 'No such rail station';
    if (st.owner !== owner) return 'Not your station';
    const co = g.company(owner);
    if (!co.economy.canAfford(pl.cost)) return 'Not enough money';
    if (pl.access) { const err = commitProposal(g, pl.access); if (err) return err; }
    co.economy.spend(pl.cost - (pl.access?.cost ?? 0), 'construction');
    const e: Entrance = { ...pl.entrance, ...(pl.entrance.far ? { far: { ...pl.entrance.far } } : {}) };
    r.entrances.push(e);
    if (typeof r.cost === 'number') r.cost += e.cost ?? 0;
    const k = entranceKind(r.level ?? 'ground', e), T = ENTRANCE_TYPES[k];
    for (const p of entranceLandings(e)) {
      this.padGround(landingRect(k, p));
      g.world.removeTreesNear(p.x, p.z, Math.hypot(T.w, T.d) / 2 + 0.6);
      g.world.markObjArea(p.x - 3, p.z - 3, p.x + 3, p.z + 3);
    }
    this.repairSite(st);
    entranceRevisions.set(this, (entranceRevisions.get(this) ?? 0) + 1);
    this.accessVersion = -1;
    g.lines.catchmentDirty = true;
    return null;
  }

  /** Add an entrance to a station (see planEntrance). Null = OK, else the reason. */
  addEntrance(stationId: number, x: number, z: number, owner: number, kind?: EntranceKind): string | null {
    return this.commitEntrance(stationId, this.planEntrance(stationId, x, z, owner, kind), owner);
  }

  /** Why an entrance cannot be removed (null: it can; a station below or above the street keeps at least one). */
  removeEntranceError(stationId: number, index: number, owner: number): string | null {
    const st = this.map.get(stationId);
    const r = st?.rail;
    if (!st || !r || !r.entrances[index]) return 'No such entrance';
    if (st.owner !== owner) return 'Not your station';
    if ((r.level ?? 'ground') !== 'ground' && r.entrances.length <= 1) return 'Needs at least one entrance';
    return null;
  }

  /** Remove an entrance (a station below or above the street keeps at least one). Null = OK, else the reason. */
  removeEntrance(stationId: number, index: number, owner: number): string | null {
    const err = this.removeEntranceError(stationId, index, owner);
    if (err) return err;
    const r = this.map.get(stationId)!.rail!;
    const [e] = r.entrances.splice(index, 1);
    const lv = r.level ?? 'ground';
    // (an entrance-only station's first entrance stands for its building)
    if (lv !== 'ground' && index === 0 && r.entrances[0] && (styleOf(r.style).placement === 'none' || !r.forecourt)) { const sz = ENTRANCE_SIZE[lv]; r.building = { x: r.entrances[0].x, z: r.entrances[0].z, angle: r.entrances[0].angle, w: sz.w, d: sz.d }; }
    if (typeof r.cost === 'number' && e.cost) r.cost = Math.max(0, r.cost - e.cost);
    for (const p of entranceLandings(e)) this.game.world.markObjArea(p.x - 3, p.z - 3, p.x + 3, p.z + 3);
    entranceRevisions.set(this, (entranceRevisions.get(this) ?? 0) + 1);
    this.accessVersion = -1;
    this.game.lines.catchmentDirty = true;
    return null;
  }

  /**
   * The nearest point of a street a pedestrian may use within `maxD` of (x, z) on one side of a ground station's
   * tracks (or beyond its platform ends' lead corridors): where an entrance's access street would lead. Pure.
   */
  sideRoad(stationId: number, x: number, z: number, side: 1 | -1, maxD: number): { x: number; z: number; d: number } | null {
    const r = this.map.get(stationId)?.rail, net = this.game.world.net;
    if (!r) return null;
    const ax = Math.sin(r.angle), az = Math.cos(r.angle), width = railWidth(r);
    let best: { x: number; z: number; d: number } | null = null;
    const p = { x: 0, y: 0, z: 0 };
    for (const e of net.edgesNear(x - maxD, z - maxD, x + maxD, z + maxD)) {
      if (!pedestrianRoad(e)) continue;
      for (let s = 0; s <= e.len; s += Math.min(1, Math.max(0.25, e.len / 8))) {
        net.pointAt(e, s, p);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d > maxD || net.sectionAt(e, s) !== 'ground' || (best && (d > best.d || (d === best.d && (p.x > best.x || (p.x === best.x && p.z >= best.z)))))) continue;
        if (((p.x - r.x) * az - (p.z - r.z) * ax) * side < width / 2 + 0.3 && Math.abs((p.x - r.x) * ax + (p.z - r.z) * az) < r.length / 2 + 26) continue;
        best = { x: p.x, z: p.z, d };
      }
    }
    return best;
  }

  /** Does an entrance touch a road (street side; a two-sided crossing: on either side)? */
  entranceAccess(st: Station, e: Entrance): boolean {
    const lv = st.rail?.level ?? 'ground';
    if (lv !== 'ground') return this.roadContact(e.x, e.z, ENTRANCE_SIZE[lv].d / 2 + 0.9);
    const k = entranceKind(lv, e);
    return entranceLandings(e).some((p) => this.landingOnStreet(k, p));
  }

  /** Does a street reach a ground entrance's landing (the walking catchment can start there)? */
  private landingOnStreet(kind: EntranceKind, p: { x: number; z: number }): boolean {
    const reach = landingReach(kind);
    return this.roadContact(p.x, p.z, reach) && walkableStreetNear(this.game, p.x, p.z, reach);
  }

  /** The street side of a ground station's building (where the access road ends). */
  forecourt(st: Station): { x: number; z: number } | null { return st.rail ? this.forecourtOf(st.rail) : null; }

  /** The street side of a ground rail part's building (a station's, or a planned one). */
  private forecourtOf(r: RailPart): { x: number; z: number } | null {
    if ((r.level ?? 'ground') !== 'ground') return null;
    if (r.forecourt) return r.forecourt;
    const b = r.building, fx = Math.sin(b.angle), fz = Math.cos(b.angle);
    return { x: b.x - fx * (b.d / 2 + FORECOURT), z: b.z - fz * (b.d / 2 + FORECOURT) };
  }

  /** Can passengers reach the rail part (road at the forecourt / an entrance on a street, or a stop of the station)? */
  private railReachable(st: Station): boolean {
    const r = st.rail;
    if (!r) return false;
    if (st.stops.some((s) => { const e = this.game.world.net.edges.get(s.edge); return !!e && pedestrianRoad(e); })) return true;
    if ((r.level ?? 'ground') === 'ground') {
      const f = this.forecourt(st), reach = styleOf(r.style).placement === 'none' ? NO_BUILDING_REACH : 0.9;
      return (!!f && this.roadContact(f.x, f.z, reach)) || (!!r.forecourt2 && this.roadContact(r.forecourt2.x, r.forecourt2.z, reach))
        || r.entrances.some((e) => this.entranceAccess(st, e));
    }
    // below / above the street: an entrance on a street, or the street-level building's forecourt
    if (styleOf(r.style).placement !== 'none' && r.forecourt && this.roadContact(r.forecourt.x, r.forecourt.z, 0.9)) return true;
    return r.entrances.some((e) => this.entranceAccess(st, e));
  }

  /** Recompute the stations' road access after the network changed (cheap when nothing changed). */
  refreshAccess(force = false) {
    this.game.world.syncCatchmentTerrain();
    const v = this.game.world.net.version;
    if (!force && v === this.accessVersion) return;
    this.accessVersion = v;
    this.walkVersion++;
    let changed = walkRoadsChanged(this.game);
    const direct = new Map<number, boolean>();
    for (const st of this.map.values()) direct.set(st.id, st.rail ? this.railReachable(st)
      : st.stops.some(s => { const e = this.game.world.net.edges.get(s.edge); return !!e && pedestrianRoad(e); }));
    const seen = new Set<number>();
    for (const st of this.map.values()) {
      if (seen.has(st.id)) continue;
      const parts = this.catchmentMembers(st.id), accessible = parts.some(id => direct.get(id));
      for (const id of parts) {
        seen.add(id);
        const part = this.map.get(id)!;
        if (accessible !== part.roadAccess) { part.roadAccess = accessible; changed = true; }
      }
    }
    if (changed) this.game.lines.catchmentDirty = true;
  }

  /** Does the station take part in passenger traffic? (a rail station needs road access, see Station.roadAccess) */
  hasAccess(st: Station): boolean {
    this.refreshAccess();
    return st.roadAccess;
  }

  // ---------------------------------------------------------------- bus stops
  /**
   * A bus / tram stop station near (x, z) that `owner` may share instead of building its own: a stop of a usable
   * station (own, or another company's with access) within STOP_JOIN, a tram stop for trams. Nearest first.
   */
  findSharedStop(x: number, z: number, owner: number, tram = false): Station | null {
    const net = this.game.world.net;
    let best: Station | null = null, bd = Infinity;
    for (const st of this.map.values()) {
      if (!st.stops.length || !this.game.canUse(owner, st.owner)) continue;
      for (const q of st.stops) {
        const d = Math.hypot(q.x - x, q.z - z);
        if (d > STOP_JOIN || d >= bd) continue;
        const e = net.edges.get(q.edge);
        if (!e || (tram && !(e.tram && this.game.canUse(owner, e.tramOwner ?? -1)))) continue;
        best = st; bd = d;
      }
    }
    return best;
  }

  planBusStop(x: number, z: number, owner: number, opts: { share?: boolean } = {}): BusStopPlan {
    const g = this.game;
    const net = g.world.net;
    const none = (error: string): BusStopPlan => ({ ok: false, error, cost: 0, join: null, links: [], mode: 'bus' });
    const ne = net.nearestEdge(x, z, 1.4, 'road', (e) => e.depot < 0);
    if (!ne) return none('Click on a road');
    const e = ne.edge;
    // sharing: an existing stop within reach (own or another company's) is used instead of a new one
    if (opts.share) {
      const sh = this.findSharedStop(x, z, owner, !!e.tram);
      if (sh) { const q = sh.stops[0]; return { ok: true, edge: e, s: ne.s, px: q.x, pz: q.z, cost: 0, join: sh, links: [], mode: e.tram ? 'tram' : 'bus', reuse: sh.id }; }
    }
    const ra = net.junctionRadius(e.a) + 0.9, rb = net.junctionRadius(e.b) + 0.9;
    if (ne.s < ra || ne.s > e.len - rb) return none('Too close to a junction');
    if (net.sectionAt(e, ne.s) !== 'ground') return none('No stop on bridges or in tunnels');
    for (const st of this.map.values()) for (const p of st.stops) if (p.edge === e.id && Math.abs(p.s - ne.s) < 1.6) return none('Another stop is too close');
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(e, ne.s, p);
    // an own rail station within walking range takes the stop, else a stop-only station across the street
    let join: Station | null = null;
    const links: Station[] = [];
    const pt: Rect = { x: p.x, z: p.z, angle: 0, w: 0, d: 0 };
    const near = this.nearOwn(owner, (o) => this.gapToArea(o, pt));
    // within 80 m of an own rail station's platforms / building / entrances: the stop becomes part of it
    for (const c of near) if (c.st.rail && [...this.platformAreas(c.st), ...this.footprints(c.st)].some((f) => distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < STOP_JOIN)) { join = c.st; break; }
    if (!join) for (const c of near) if (!c.st.rail && c.st.stops.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3)) { join = c.st; break; }
    for (const c of near) if (c.st !== join && c.gap <= autoLinkRange(e.tram ? 'tram' : 'bus', this.mode(c.st))) links.push(c.st);
    return { ok: true, edge: e, s: ne.s, px: p.x, pz: p.z, cost: 30000, join, links, mode: e.tram ? 'tram' : 'bus' };
  }

  commitBusStop(x: number, z: number, owner: number, opts: { share?: boolean } = {}): string | null {
    const g = this.game;
    const p = this.planBusStop(x, z, owner, opts);
    if (!p.ok) return p.error!;
    if (p.reuse !== undefined) return null;
    if (!g.company(owner).economy.spend(p.cost, 'construction')) return 'Not enough money';
    const st = p.join ?? this.create(p.px!, p.pz!, owner);
    st.stops.push({ edge: p.edge!.id, s: p.s!, x: p.px!, z: p.pz! });
    if (!st.rail) { st.x = st.stops.reduce((a, q) => a + q.x, 0) / st.stops.length; st.z = st.stops.reduce((a, q) => a + q.z, 0) / st.stops.length; }
    for (const o of p.links) if (o !== st && this.map.get(o.id) === o && !this.canLink(st.id, o.id) && this.nearbyComplex(st, o)) this.addLink(st, o);
    g.world.net.markEdge(p.edge!);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  /** Stops of a station on tram tracks that `user` may use: trams of a tram line stop there. */
  tramStops(st: Station, user: number): BusStop[] {
    const net = this.game.world.net;
    return st.stops.filter((p) => { const e = net.edges.get(p.edge); return !!e && !!e.tram && this.game.canUse(user, e.tramOwner ?? -1); });
  }

  removeStop(st: Station, idx: number) {
    const stop = st.stops[idx];
    if (!stop) return;
    st.stops.splice(idx, 1);
    const e = this.game.world.net.edges.get(stop.edge);
    if (e) this.game.world.net.markEdge(e);
    if (!st.stops.length && !st.rail) this.deleteStation(st.id);
    this.accessVersion = -1;
    this.game.lines.rebuild();
  }

  // ---------------------------------------------------------------- transfer complexes
  /** Walking distance between the platform areas / stops of two stations (0 when they overlap). */
  gap(a: Station, b: Station): number {
    const memo = this.geometryMemo(), ga = this.platformGeometry(a, memo), gb = this.platformGeometry(b, memo);
    const previous = memo.gaps.get(a)?.get(b);
    if (previous?.a === ga && previous.b === gb) return previous.distance;
    let d = Infinity;
    const ra = ga.areas, rb = gb.areas;
    for (const p of ra) for (const q of rb) d = Math.min(d, rectGap(p, q));
    for (const p of a.stops) {
      for (const q of rb) d = Math.min(d, distToRect(p.x, p.z, q.x, q.z, q.angle, q.w / 2, q.d / 2));
      for (const q of b.stops) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
    }
    for (const p of ra) for (const q of b.stops) d = Math.min(d, distToRect(q.x, q.z, p.x, p.z, p.angle, p.w / 2, p.d / 2));
    let forward = memo.gaps.get(a), reverse = memo.gaps.get(b);
    if (!forward) { forward = new WeakMap(); memo.gaps.set(a, forward); }
    if (!reverse) { reverse = new WeakMap(); memo.gaps.set(b, reverse); }
    forward.set(b, { a: ga, b: gb, distance: d });
    reverse.set(a, { a: gb, b: ga, distance: d });
    return d;
  }

  /** Can `from` be merged into `into` (one station: stops, platforms, passengers and line stops move)? Null if yes, else the reason. */
  canMerge(intoId: number, fromId: number): string | null {
    const a = this.map.get(intoId), b = this.map.get(fromId);
    if (!a || !b) return 'No such station';
    if (a === b) return 'The same station';
    if (a.owner !== b.owner) return 'Merge requires the same owner';
    // (two station types stay two parts of one interchange: railMergeable says so, the merge links them)
    if (a.rail && b.rail && railPartMode(a.rail) !== railPartMode(b.rail)) return `${STYLE_WORD[railPartMode(a.rail)]} + ${STYLE_WORD[railPartMode(b.rail)]}: link as one interchange`;
    if (a.rail && b.rail) { const r = this.railMergeable(intoId, fromId); return r ? `${r}: link them for transfers instead` : null; }
    const d = this.gap(a, b);
    if (d > TRANSFER_RANGE) return `Too far apart (${Math.round(d * 10)} m, at most ${TRANSFER_RANGE * 10} m)`;
    // a line stopping at both would be left with a single stop
    for (const l of this.game.lines.map.values()) {
      if (!l.stops.includes(a.id) || !l.stops.includes(b.id)) continue;
      if (new Set(l.stops.map((s) => (s === b.id ? a.id : s))).size < 2) return `${l.name} would be left with one stop`;
    }
    return null;
  }

  /** Can two stations be linked for walking transfers? Null if yes, else the reason. */
  canLink(aId: number, bId: number): string | null {
    const a = this.map.get(aId), b = this.map.get(bId);
    if (!a || !b) return 'No such station';
    if (a === b) return 'The same station';
    if (a.links.includes(b.id)) return 'Already linked';
    // Passenger walking passages are public; operating either company's platforms still requires native rail access.
    const d = this.gap(a, b), range = this.linkRange(a, b);
    if (d > range) return `Walking transfer: ${Math.round(d * 10)} m > max ${range * 10} m`;
    return null;
  }

  /** Intermediate transfer reach, distinct from either station's origin/destination walking coverage. */
  linkRange(a: Station, b: Station): number { return transferWalkLimit(this.game, a, b); }

  /** Automatic complexes stay compact: every existing part must be near every part being added. */
  private nearbyComplex(a: Station, b: Station): boolean {
    const left = this.complex(a.id), right = this.complex(b.id);
    if (left.some(id => right.includes(id))) return false;
    for (const x of left) for (const y of right) {
      const p = this.map.get(x)!, q = this.map.get(y)!;
      if (this.consecutiveStops(x, y) || this.gap(p, q) > Math.min(autoLinkRange(this.mode(p), this.mode(q)), this.linkRange(p, q))) return false;
    }
    return true;
  }

  /** Nearby rail platforms are one public interchange, retaining their separate track groups and owners. */
  private autoLinkNearby(st: Station): number {
    if (!st.rail) return 0;
    const candidates = [...this.map.values()].filter(o => o !== st && o.rail && !st.links.includes(o.id))
      .map(o => ({ st: o, gap: this.gap(st, o) })).sort((a, b) => a.gap - b.gap || a.st.id - b.st.id);
    let added = 0;
    for (const c of candidates) {
      if (c.gap > Math.min(autoLinkRange(this.mode(st), this.mode(c.st)), this.linkRange(st, c.st))) continue;
      if (!this.nearbyComplex(st, c.st) || this.canLink(st.id, c.st.id)) continue;
      this.addLink(st, c.st); added++;
    }
    return added;
  }

  /** Load migration: retain valid explicit passages and group old nearby rail parts once. No physical assets move. */
  restoreComplexes(autoLink: boolean): boolean {
    let changed = false;
    for (const st of this.map.values()) {
      const kept = st.links.filter(id => {
        const other = this.map.get(id);
        return !!other && other !== st && this.gap(st, other) <= this.linkRange(st, other);
      });
      if (kept.length !== st.links.length) { st.links = kept; changed = true; }
    }
    if (autoLink) for (const st of [...this.map.values()].sort((a, b) => a.id - b.id)) if (this.autoLinkNearby(st)) changed = true;
    const named = new Set<number>();
    for (const st of this.map.values()) if (!named.has(st.id)) {
      const group = stationComplex(this.game, st.id);
      if (group.parts.length > 1) this.renameComplex(st.id, this.map.get(group.main)!.name);
      for (const id of group.parts) named.add(id);
    }
    return changed;
  }

  private addLink(a: Station, b: Station) {
    if (!a.links.includes(b.id)) a.links.push(b.id);
    if (!b.links.includes(a.id)) b.links.push(a.id);
    this.accessVersion = -1;
    this.catchGroups.version = -1;
    this.walkVersion++;
    const main = this.map.get(stationComplex(this.game, a.id).main)!;
    this.renameComplex(a.id, main.name);
  }

  /** Link two stations for walking transfers (both stay separate stations). Null = OK, else the reason. */
  link(aId: number, bId: number): string | null {
    const err = this.canLink(aId, bId);
    if (err) return err;
    this.addLink(this.map.get(aId)!, this.map.get(bId)!);
    this.game.lines.rebuild();
    return null;
  }

  /** End a walking link between two stations. */
  unlink(aId: number, bId: number) {
    const a = this.map.get(aId), b = this.map.get(bId);
    let n = 0;
    if (a && a.links.includes(bId)) { a.links = a.links.filter((x) => x !== bId); n++; }
    if (b && b.links.includes(aId)) { b.links = b.links.filter((x) => x !== aId); n++; }
    if (n) { this.accessVersion = -1; this.catchGroups.version = -1; this.walkVersion++; this.game.lines.rebuild(); }
  }

  /** One logical station, with physical platform IDs and track permissions kept separate. Pure membership read. */
  isSameStationComplex(aId: number, bId: number): boolean {
    const st = this.map.get(aId);
    if (!st || !this.map.has(bId)) return false;
    if (!st.links.length) return aId === bId && !!st.rail && st.stops.length > 0;
    const parts = this.complex(aId);
    return parts.includes(bId) && (parts.length > 1 || !!st.rail && st.stops.length > 0);
  }

  /** All platform groups of one public station share its actual saved name. */
  renameComplex(id: number, name: string) {
    const value = name.trim().slice(0, 40);
    if (!value) return;
    for (const part of this.catchmentMembers(id)) { const st = this.map.get(part); if (st) st.name = value; }
  }

  /** All stations of a station's transfer complex (itself and everything linked to it, transitively). */
  complex(id: number): number[] {
    const out = [id], seen = new Set(out);
    for (let i = 0; i < out.length; i++) for (const o of this.map.get(out[i])?.links ?? []) if (!seen.has(o) && this.map.has(o)) { seen.add(o); out.push(o); }
    return out;
  }

  private catchGroups = { version: -1, count: -1, ids: new Map<number, number>(), members: new Map<number, number[]>() };
  /** Stable physical-complex identity for population claims; independent of display mode or ownership. */
  catchmentGroup(id: number): number {
    const cache = this.catchGroups;
    if (cache.version !== this.walkVersion || cache.count !== this.map.size) {
      cache.version = this.walkVersion; cache.count = this.map.size; cache.ids.clear(); cache.members.clear();
      const adjacent = new Map<number, Set<number>>();
      for (const st of this.map.values()) adjacent.set(st.id, new Set());
      for (const st of this.map.values()) for (const to of st.links) if (this.map.has(to)) {
        adjacent.get(st.id)!.add(to); adjacent.get(to)!.add(st.id);
      }
      for (const st of this.map.values()) if (!cache.ids.has(st.id)) {
        const parts = [st.id], seen = new Set(parts);
        for (let i = 0; i < parts.length; i++) for (const to of adjacent.get(parts[i])!) if (!seen.has(to)) { seen.add(to); parts.push(to); }
        const group = Math.min(...parts);
        cache.members.set(group, parts);
        for (const member of parts) cache.ids.set(member, group);
      }
    }
    return cache.ids.get(id) ?? id;
  }

  /** Logical member identity is undirected even for an asymmetric legacy passage; rail route edges stay physical. */
  catchmentMembers(id: number): readonly number[] {
    return this.catchGroups.members.get(this.catchmentGroup(id)) ?? [id];
  }

  /** Nearby stations for the merge / link controls: walking gap, linked, and why a merge / link is not possible. */
  transferOptions(id: number): { id: number; name: string; gap: number; linked: boolean; merge: string | null; link: string | null }[] {
    const st = this.map.get(id);
    if (!st) return [];
    const out: { id: number; name: string; gap: number; linked: boolean; merge: string | null; link: string | null }[] = [];
    for (const o of this.map.values()) {
      if (o === st) continue;
      if (Math.hypot(o.x - st.x, o.z - st.z) > TRANSFER_RANGE * 2 + (st.rail?.length ?? 0) + (o.rail?.length ?? 0)) continue;
      const d = this.gap(st, o);
      if (d > TRANSFER_RANGE * 2) continue;
      out.push({ id: o.id, name: o.name, gap: d, linked: st.links.includes(o.id), merge: this.canMerge(st.id, o.id), link: st.links.includes(o.id) ? null : this.canLink(st.id, o.id) });
    }
    return out.sort((a, b) => a.gap - b.gap);
  }

  /** Walking transfer cost between linked stations (Lines.rebuild adds its transfer penalty). */
  walkCost(a: Station, b: Station): number { return (this.isSameStationComplex(a.id, b.id) ? 0 : WALK_BASE) + WALK_PER_UNIT * this.gap(a, b); }

  /** Walking transfer edges of all transfer complexes (both directions), for the line graph. */
  walkLinks(): { from: number; to: number; cost: number }[] {
    const out: { from: number; to: number; cost: number }[] = [];
    for (const st of this.map.values()) for (const id of st.links) {
      const o = this.map.get(id);
      if (o && o !== st) out.push({ from: st.id, to: id, cost: this.walkCost(st, o) });
    }
    return out;
  }

  /**
   * Merge station `from` into `into`: its stops (and platforms, if only `from` has any), waiting passengers,
   * links and the stops of every line (of any company) move to `into`, which keeps its name. Null = OK.
   */
  merge(intoId: number, fromId: number): string | null {
    const a = this.map.get(intoId), b = this.map.get(fromId);
    if (a?.rail && b?.rail) return this.mergeRail(intoId, fromId);
    const err = this.canMerge(intoId, fromId);
    if (err) return err;
    this.absorb(a!, b!);
    return null;
  }

  /** Station `b` becomes part of `a` (its rail part, if `a` has none, its stops, passengers, links and line stops); no checks. */
  private absorb(a: Station, b: Station) {
    const g = this.game, net = g.world.net;
    if (b.rail) {
      a.rail = b.rail; b.rail = null;
      for (const eid of a.rail.edges) { const e = net.edges.get(eid); if (e) { e.station = a.id; net.markEdge(e); } }
      a.x = a.rail.x; a.z = a.rail.z;
      // (the rail part keeps its standing in town)
      if (b.city) a.city = true; else delete a.city;
    }
    a.stops.push(...b.stops);
    b.stops = [];
    if (!a.rail && a.stops.length) { a.x = a.stops.reduce((s, q) => s + q.x, 0) / a.stops.length; a.z = a.stops.reduce((s, q) => s + q.z, 0) / a.stops.length; }
    // statistics
    a.genMonth += b.genMonth; a.pickupMonth += b.pickupMonth; a.arrivedMonth += b.arrivedMonth;
    a.genLast += b.genLast; a.pickupLast += b.pickupLast; a.arrivedLast += b.arrivedLast;
    a.lostMonth += b.lostMonth; a.lostLast += b.lostLast;
    a.lastPickup = Math.max(a.lastPickup, b.lastPickup); a.lastSpeed = Math.max(a.lastSpeed, b.lastSpeed);
    a.rating = Math.max(a.rating, b.rating);
    a.lastCall = Math.max(a.lastCall, b.lastCall); a.callDays = (a.callDays | b.callDays) & CALL_MASK;
    // links
    for (const o of b.links) { const os = this.map.get(o); if (os) os.links = os.links.filter((x) => x !== b.id); if (os && os !== a) this.addLink(a, os); }
    b.links = [];
    a.links = a.links.filter((x) => x !== b.id);
    // passengers: waiting at `from`, and everywhere heading to / changing at `from`
    const re = (id: number) => (id === b.id ? a.id : id);
    const moved = [...b.waiting.values()];
    b.waiting.clear(); b.waitingTotal = 0;
    for (const st of this.map.values()) {
      if (st === b) continue;
      let hit = false;
      for (const w of st.waiting.values()) if (w.alight === b.id || w.dest === b.id) { hit = true; break; }
      if (!hit) continue;
      const old = [...st.waiting.values()];
      st.waiting.clear(); st.waitingTotal = 0;
      for (const w of old) if (re(w.dest) !== st.id) this.addWaiting(st, w.line, re(w.alight), re(w.dest), w.count, 0, w.t, w.transfers ?? 0, w.rail ?? 0);
    }
    for (const w of moved) if (re(w.dest) !== a.id) this.addWaiting(a, w.line, re(w.alight), re(w.dest), w.count, 0, w.t, w.transfers ?? 0, w.rail ?? 0);
    // mail: b's queues and figures join a's; mail heading to or changing at b heads for a (also aboard vehicles)
    const mailDeliveries = absorbMail(g, a, b, re);
    for (const v of g.vehicles.map.values()) {
      let hit = false;
      for (const c of v.cargo.values()) if (c.alight === b.id || c.dest === b.id || c.from === b.id) { hit = true; break; }
      if (hit) {
        const old = [...v.cargo.values()];
        v.cargo = cargoGroups(old.map((c) => ({ ...c, alight: re(c.alight), dest: re(c.dest), from: re(c.from) })));
      }
      const t = v as unknown as { routeTarget?: number; atStation?: number };
      if (t.routeTarget === b.id) t.routeTarget = a.id;
      if (t.atStation === b.id) t.atStation = a.id;
    }
    // line stops (any company's lines): `from` becomes `into`, repeated stops collapse
    for (const l of g.lines.map.values()) {
      if (!l.stops.includes(b.id)) continue;
      const map: number[] = [], out: number[] = [];
      for (const s0 of l.stops) {
        const s = re(s0);
        if (out.length && out[out.length - 1] === s) { map.push(out.length - 1); continue; }
        out.push(s); map.push(out.length - 1);
      }
      if (out.length > 1 && out[0] === out[out.length - 1]) { out.pop(); for (let i = 0; i < map.length; i++) if (map[i] >= out.length) map[i] = 0; }
      l.stops = out;
      for (const vid of l.vehicles) {
        const v = g.vehicles.get(vid);
        if (!v) continue;
        v.stopIndex = map[v.stopIndex] ?? 0;
        v.onLineChanged();
      }
    }
    this.map.delete(b.id);
    g.world.markObjArea(Math.min(a.x, b.x) - 20, Math.min(a.z, b.z) - 20, Math.max(a.x, b.x) + 20, Math.max(a.z, b.z) + 20);
    this.markStation(a);
    this.accessVersion = -1;
    g.onNetworkChanged();
    this.refreshAccess();
    g.lines.rebuild();
    for (const d of mailDeliveries) settleMail(g, d.st, d.count, d.j, null);
  }

  /**
   * Can rail station `b`'s tracks join `a`'s rail part (one station)? Same company, same level and height,
   * parallel (axes within ~8 degrees), side by side (track areas at most 1.5 units apart) and overlapping along
   * the platforms; up to 8 platform and 2 through tracks together. Tracks at an angle of more than 1.5 degrees
   * are laid anew along `a`'s axis, which needs their ends free of track. Null if they can, else the reason.
   */
  railMergeable(aId: number, bId: number): string | null {
    const a = this.map.get(aId), b = this.map.get(bId);
    if (!a || !b) return 'No such station';
    if (a === b) return 'The same station';
    const A = a.rail, B = b.rail;
    if (!A || !B) return 'Not two rail stations';
    if (A.native || B.native) return 'Retained track platforms: link as an interchange';
    if (a.owner !== b.owner) return 'Merge requires the same owner';
    // (stations of two types, main line / metro / light rail by railPartMode, each keep their own part, style and
    // walking reach: they merge as one interchange, a transfer complex shown as one station, never as one rail part)
    if (railPartMode(A) !== railPartMode(B)) return `${STYLE_WORD[railPartMode(A)]} + ${STYLE_WORD[railPartMode(B)]}: separate parts`;
    if ((A.level ?? 'ground') !== (B.level ?? 'ground') || Math.abs(A.y - B.y) > 0.3) return 'Platforms at different levels';
    const tilt = this.tilt(A, B);
    if (Math.abs(tilt) > MERGE_TILT) return `Platforms not parallel · ${Math.round((Math.abs(tilt) * 180) / Math.PI)}° apart`;
    const fx = Math.sin(A.angle), fz = Math.cos(A.angle), rx = fz, rz = -fx;
    const wA = railWidth(A), wB = railWidth(B);
    let l0 = Infinity, l1 = -Infinity, u0 = Infinity, u1 = -Infinity;
    const bx = Math.sin(B.angle), bz = Math.cos(B.angle), brx = bz, brz = -bx;
    for (const [i, j] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) {
      const px = B.x + bx * (B.length / 2) * i + brx * (wB / 2) * j, pz = B.z + bz * (B.length / 2) * i + brz * (wB / 2) * j;
      const lat = (px - A.x) * rx + (pz - A.z) * rz, lon = (px - A.x) * fx + (pz - A.z) * fz;
      l0 = Math.min(l0, lat); l1 = Math.max(l1, lat); u0 = Math.min(u0, lon); u1 = Math.max(u1, lon);
    }
    if (l1 > -wA / 2 && l0 < wA / 2) return 'The platforms overlap';
    const gapLat = l0 >= wA / 2 ? l0 - wA / 2 : -wA / 2 - l1;
    if (gapLat > 1.5) return `Tracks ${Math.round(gapLat * 10)} m apart > max 15 m`;
    if (Math.min(u1, A.length / 2) - Math.max(u0, -A.length / 2) < 1) return 'Platforms not side by side along their length';
    if (A.tracks + B.tracks > 8) return 'More than 8 platform tracks';
    if ((A.through ?? 0) + (B.through ?? 0) > 2) return 'More than 2 through tracks';
    if (Math.abs(tilt) > MERGE_TILT_ADOPT) {
      for (const t of this.trackEnds(b, true)) for (const nid of [t.front, t.back]) if ((this.game.world.net.nodes.get(nid)?.edges.length ?? 0) > 1) return 'Angled platforms have connected track';
    }
    for (const l of this.game.lines.map.values()) {
      if (!l.stops.includes(a.id) || !l.stops.includes(b.id)) continue;
      if (new Set(l.stops.map((s) => (s === b.id ? a.id : s))).size < 2) return `${l.name} would be left with one stop`;
    }
    return null;
  }

  /** Signed angle between two rail parts' axes, folded to -90..90 degrees (platforms are parallel either way round). */
  private tilt(A: RailPart, B: RailPart): number {
    let d = B.angle - A.angle;
    while (d > Math.PI / 2) d -= Math.PI;
    while (d < -Math.PI / 2) d += Math.PI;
    return d;
  }

  /**
   * Merge rail station `b` into `a` as one rail part (see railMergeable): b's platform and through tracks join
   * a's (laid anew along a's axis when they meet it at more than 1.5 degrees), the platforms are united under a's
   * building, and b's stops, passengers, links and line stops move to `a`; `b` is removed. 'busy' while a train
   * stands on b's tracks. Null = OK, else the reason.
   */
  mergeRail(aId: number, bId: number): string | null {
    const err = this.railMergeable(aId, bId);
    if (err) return err;
    const g = this.game, net = g.world.net;
    const a = this.map.get(aId)!, b = this.map.get(bId)!;
    const A = a.rail!, B = b.rail!;
    for (const id of [...B.edges, ...B.throughEdges]) if (g.vehicles.isEdgeBusy(id)) return 'busy';
    const fx = Math.sin(A.angle), fz = Math.cos(A.angle), rx = fz, rz = -fx;
    const latOf = (x: number, z: number) => (x - A.x) * rx + (z - A.z) * rz, lonOf = (x: number, z: number) => (x - A.x) * fx + (z - A.z) * fz;
    // b's tracks: kept as they lie, or laid anew along a's axis (free ends only, checked above)
    const tracks: { ids: number[]; through: boolean; lat: number; u0: number; u1: number }[] = [];
    const relay = Math.abs(this.tilt(A, B)) > MERGE_TILT_ADOPT;
    for (const t of this.trackEnds(b, true)) {
      const nf = net.nodes.get(t.front)!, nb = net.nodes.get(t.back)!;
      const lat = latOf((nf.x + nb.x) / 2, (nf.z + nb.z) / 2);
      const uf = lonOf(nf.x, nf.z), ub = lonOf(nb.x, nb.z);
      const mine = (t.through ? B.throughEdges : B.edges).filter((id) => { const e = net.edges.get(id); if (!e) return false; const p = net.nodes.get(e.a)!, q = net.nodes.get(e.b)!; return Math.abs(latOf((p.x + q.x) / 2, (p.z + q.z) / 2) - lat) < 0.3; });
      if (!relay) { tracks.push({ ids: mine, through: t.through, lat, u0: Math.min(uf, ub), u1: Math.max(uf, ub) }); continue; }
      const old = net.edges.get(mine[0])!;
      const type = old.type, secs = old.sections.length ? [{ ...old.sections[0] }] : [];
      for (const id of mine) net.removeEdge(id);
      for (const n of [nf, nb]) if (net.nodes.has(n.id) && !n.edges.length) net.removeNode(n.id);
      const u0 = Math.min(uf, ub), u1 = Math.max(uf, ub);
      const ax = A.x + fx * u0 + rx * lat, az = A.z + fz * u0 + rz * lat, bx2 = A.x + fx * u1 + rx * lat, bz2 = A.z + fz * u1 + rz * lat;
      const na = net.addNode('rail', ax, A.y, az, fx, fz, a.owner), nb2 = net.addNode('rail', bx2, A.y, bz2, fx, fz, a.owner);
      const len = Math.hypot(bx2 - ax, bz2 - az), m = Math.max(2, Math.ceil(len) + 1);
      const e = net.addEdge('rail', na.id, nb2.id, bezLine(ax, az, bx2, bz2), new Float32Array(m).fill(A.y), secs.map((sc) => ({ ...sc, s0: 0, s1: len })), type, a.owner, { station: t.through ? -1 : b.id });
      tracks.push({ ids: [e.id], through: t.through, lat, u0, u1 });
    }
    // one rail part: a's axis and building, both stations' tracks and platforms, the union's extent
    const own: { lat: number; u0: number; u1: number; through: boolean }[] = [];
    for (const t of this.trackEnds(a, true)) {
      const nf = net.nodes.get(t.front)!, nb = net.nodes.get(t.back)!;
      own.push({ lat: latOf((nf.x + nb.x) / 2, (nf.z + nb.z) / 2), u0: Math.min(lonOf(nf.x, nf.z), lonOf(nb.x, nb.z)), u1: Math.max(lonOf(nf.x, nf.z), lonOf(nb.x, nb.z)), through: t.through });
    }
    const all = [...own, ...tracks];
    const bAx = Math.sin(B.angle), bAz = Math.cos(B.angle);
    const flip = bAx * fx + bAz * fz < 0 ? -1 : 1;
    const bPlat = B.platforms.map((p) => {
      // b's platform: its centre line in a's frame (b's offsets point the other way when b faces the other way)
      const px = B.x + Math.cos(B.angle) * p.off, pz = B.z - Math.sin(B.angle) * p.off;
      return { lat: latOf(px, pz), w: p.w, u0: lonOf(B.x, B.z) - B.length / 2, u1: lonOf(B.x, B.z) + B.length / 2, flip };
    });
    const aPlat = A.platforms.map((p) => ({ lat: p.off, w: p.w, u0: -A.length / 2, u1: A.length / 2 }));
    const U0 = Math.min(...all.map((t) => t.u0)), U1 = Math.max(...all.map((t) => t.u1));
    const lats = [...all.map((t) => t.lat), ...aPlat.map((p) => p.lat), ...bPlat.map((p) => p.lat)];
    const L0 = Math.min(...lats), L1 = Math.max(...lats);
    const cu = (U0 + U1) / 2, cl = (L0 + L1) / 2;
    const ncx = A.x + fx * cu + rx * cl, ncz = A.z + fz * cu + rz * cl;
    this.markStation(a); this.markStation(b);
    A.x = ncx; A.z = ncz; A.length = U1 - U0;
    A.edges = [...A.edges, ...tracks.filter((t) => !t.through).flatMap((t) => t.ids)];
    A.throughEdges = [...A.throughEdges, ...tracks.filter((t) => t.through).flatMap((t) => t.ids)];
    A.tracks = A.tracks + B.tracks; A.through = (A.through ?? 0) + (B.through ?? 0);
    A.trackOffsets = all.filter((t) => !t.through).map((t) => t.lat - cl).sort((p, q) => p - q);
    A.throughOffsets = all.filter((t) => t.through).map((t) => t.lat - cl).sort((p, q) => p - q);
    A.platforms = [...aPlat, ...bPlat].map((p) => ({ off: p.lat - cl, w: p.w, from: p.u0 - cu, to: p.u1 - cu })).sort((p, q) => p.off - q.off);
    A.width = L1 - L0 + 0.6;
    const entrances = [...A.entrances, ...B.entrances];
    A.entrances = entrances;
    A.piers = [...A.piers, ...B.piers];
    A.cost = (A.cost ?? 0) + (B.cost ?? 0);
    for (const id of A.edges) { const e = net.edges.get(id); if (e && e.station !== a.id) { e.station = a.id; net.markEdge(e); } }
    a.x = A.x; a.z = A.z;
    b.rail = null;
    // a ground station's added entrances: beside the united track area where they still fit and a street reaches them
    if ((A.level ?? 'ground') === 'ground' && entrances.length) { this.refitEntrances(a, entrances, { what: 'merged' }); this.markStation(a); }
    this.absorb(a, b);
    return null;
  }

  // ---------------------------------------------------------------- modes
  /** Construction style of a station's rail part (legacy track type fallback; null: no rail part). */
  railMode(st: Station): RailMode | null { return st.rail ? railPartMode(st.rail) : null; }

  /**
   * Construction style of a station: its rail style (main line, metro, light rail), else tram (a stop on tram tracks)
   * or bus. Every rail style is the one transport mode 'rail' (lines, catchment, fares); see catchMode.
   */
  mode(st: Station): StationMode {
    if (st.rail) return railPartMode(st.rail);
    const net = this.game.world.net;
    return st.stops.some((p) => net.edges.get(p.edge)?.tram) ? 'tram' : 'bus';
  }

  /** Transport mode of a station: 'rail' for every rail station (any track type), else tram or bus. */
  catchMode(st: Station): CatchMode {
    const m = this.mode(st);
    return m === 'tram' || m === 'bus' ? m : 'rail';
  }

  /** Are two stations consecutive stops of some line (any company's; vehicles go on from the last stop to the first)? */
  consecutiveStops(a: number, b: number): boolean {
    const L = this.game.lines;
    if (!L) return false;
    for (const l of L.map.values()) {
      const s = l.stops, n = s.length;
      if (n < 2 || !s.includes(a) || !s.includes(b)) continue;
      for (let i = 0; i < n; i++) {
        const p = s[i], q = s[(i + 1) % n];
        if ((p === a && q === b) || (p === b && q === a)) return true;
      }
    }
    return false;
  }

  // ---------------------------------------------------------------- catchment & passengers
  /**
   * Legacy access/reach metadata for AI scoring. Actual passenger coverage and UI use walkingCatchment.
   * Only access points connected to streets are active; `r` is the nominal walking limit.
   */
  catchmentShapes(st: Station, all = false): CatchShape[] {
    const out: CatchShape[] = [];
    const r = st.rail;
    if (r) {
      this.refreshAccess();
      const act = st.roadAccess, R = CATCHMENT_RADIUS.rail * (1 + styleOf(r.style).catchBonus) * railWalkScale(st);
      if ((r.level ?? 'ground') === 'ground') {
        for (const p of [this.forecourt(st), r.forecourt2]) if (p) out.push({ ...p, r: R, mode: 'rail', active: act });
        for (const e of r.entrances) {
          const k = entranceKind('ground', e);
          for (const p of entranceLandings(e)) out.push({ x: p.x, z: p.z, r: R, mode: 'rail', active: act && this.landingOnStreet(k, p) });
        }
      } else for (const e of r.entrances) out.push({ x: e.x, z: e.z, r: R, mode: 'rail', active: act && this.entranceAccess(st, e) });
    }
    const net = this.game.world.net;
    for (const p of st.stops) { const e = net.edges.get(p.edge); out.push({ ...stopCatchShape(p.x, p.z, !!e?.tram), active: !!e && pedestrianRoad(e) }); }
    return all ? out : out.filter((c) => c.active);
  }

  /** Planned access/reach metadata; see planWalkingCatchment for the walking preview. */
  planCatchShapes(plan: StationPlan): CatchShape[] {
    const R = CATCHMENT_RADIUS.rail * (1 + styleOf(plan.style).catchBonus) * planWalkScale(plan);
    if (plan.level === 'ground') return [plan.forecourt, plan.forecourt2].filter((p): p is { x: number; z: number } => !!p).map((p) => ({ ...p, r: R, mode: 'rail' as const, active: plan.roadAccess }));
    return plan.entrances.map((e) => ({ x: e.x, z: e.z, r: R, mode: 'rail' as const, active: plan.roadAccess && e.access }));
  }

  /** Nominal walking limit of a station, before the grid detour allowance (an in-city metro / light-rail station: half). */
  catchmentRadius(st: Station) {
    if (st.rail) return CATCHMENT_RADIUS.rail * (1 + styleOf(st.rail.style).catchBonus) * railWalkScale(st);
    return st.stops.some((p) => this.game.world.net.edges.get(p.edge)?.tram) ? CATCHMENT_RADIUS.tram : CATCHMENT_RADIUS.bus;
  }

  /**
   * Does a station at (x, z) of `town` stand in town (CITY_STATION)? `was`: its standing so far (a station in town
   * stays there until its town shrinks below leavePop or lies beyond leaveCore x the core radius). Reads only the
   * town's population and centre: cheap, and the same in a loaded game.
   */
  cityAt(x: number, z: number, town: Town | null | undefined, was?: boolean): boolean {
    if (!town) return false;
    const d = Math.hypot(x - town.x, z - town.z), core = this.game.towns.maxRadius(town);
    return was ? town.pop >= CITY_STATION.leavePop && d <= core * CITY_STATION.leaveCore
      : town.pop >= CITY_STATION.pop && d <= core * CITY_STATION.core;
  }

  /**
   * Month end (game.ts): which metro / light-rail stations stand in town (cityAt, from their standing so far). A
   * change of standing changes the station's walking reach, so the catchments are shared out again. Main-line
   * stations and stops have no standing (Station.city unset).
   */
  updateCity(): void {
    let changed = false;
    for (const st of this.map.values()) {
      const r = st.rail, was = st.city === true;
      const city = !!r && railPartMode(r) !== 'mainline' && this.cityAt(r.x, r.z, this.game.towns.list[st.townId], was);
      if (city) st.city = true; else if (st.city !== undefined) delete st.city;
      if (city !== was) changed = true;
    }
    if (changed) this.walkVersion++;
  }

  /** Legacy circular AI site estimate (routing.ts migrates separately); never used for passenger coverage. */
  popInShapes(shapes: { x: number; z: number; r: number }[]): number {
    const w = this.game.world;
    const seen = new Set<number>();
    let pop = 0;
    for (const c of shapes) for (const id of w.bgrid.query(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r)) {
      if (seen.has(id)) continue;
      const b = w.buildings.get(id);
      if (b && (b.x - c.x) ** 2 + (b.z - c.z) ** 2 <= c.r * c.r) { seen.add(id); pop += b.pop; }
    }
    return pop;
  }

  /** Buildings within the (active) catchment of a station. */
  catchmentBuildings(st: Station): number[] {
    return [...walkingCatchment(this.game, st).buildings.keys()];
  }

  /** Exact catchment: per station its buildings and shares, per building its stations and shares (see computeShares). */
  private shareSt = new Map<number, { ids: number[]; w: number[] }>();
  private shareB = new Map<number, { st: number[]; w: number[] }>();
  private sharesReady = false;
  /** Bumped whenever the catchment shares are worked out again. */
  catchVersion = 0;
  /** Buildings up to this id took part in the last share-out (saved: after loading the shares come out the same). */
  catchMaxB = 0;

  /** An untouched empty network has not performed its first catchment share-out. */
  get emptyCatchmentCold() { return !this.sharesReady && this.map.size === 0 && this.catchMaxB === 0; }

  /**
   * Split each reachable building among stations, preferring served stations when any is served. Weight is
   * catchment.ts walkWeight, so a nearer station always receives more regardless of
   * its mode's limit. The weights are normalised by their sum, but at least by the weight at FULL_COVER_WALK: a
   * building only far from every station is partly covered (fewer of its residents walk that far).
   * Cached local Dijkstra results survive unrelated edits and monthly population changes. Ratings play no part;
   * identical buildings, stations and lines rebuild identical shares after loading.
   */
  private walkSt = new Map<number, WalkingCatchment>();
  private covered = new Map<number, Map<number, number>>();
  private coveredPop = new Map<number, number>();
  private shareMembers = new Map<number, Map<number, number>>();
  private served = new Map<number, boolean>();
  private shareGroups = new Map<number, number>();
  private pendingPop = new Set<number>();
  /** Saved input work can remain owed even when there are no stations to put in pendingPop. */
  private pendingInputs = false;
  private catchInputs = { roads: -1, lots: -1, terrain: -1, stations: -1, served: -1 };

  /** Event counters only; callers can avoid even entering the walking/share computation. */
  catchmentInputsChanged(): boolean {
    return !this.sharesReady || !this.sameCatchInputs(this.catchInputs);
  }
  private currentCatchInputs() {
    const w = this.game.world;
    return { roads: w.net.roadVersions.version, lots: w.lotVersions.version, terrain: w.terrainVersions.version,
      stations: this.walkVersion, served: this.game.lines.servedVersion };
  }
  private sameCatchInputs(p: typeof this.catchInputs) {
    const w = this.game.world;
    return p.roads === w.net.roadVersions.version && p.lots === w.lotVersions.version && p.terrain === w.terrainVersions.version &&
      p.stations === this.walkVersion && p.served === this.game.lines.servedVersion;
  }
  get catchmentPopulationPending() { return this.pendingInputs || this.pendingPop.size > 0; }

  private computeShares(maxB: number) {
    if (!this.catchmentInputsChanged() && maxB === this.catchMaxB) return;
    const w = this.game.world, previousMaxB = this.catchMaxB, wasReady = this.sharesReady;
    refreshWalkBuildings(this.game);
    const dirty = new Set<number>(), populations = new Set<number>(), order = new Map<number, number>();
    let servedChanged = false;
    for (const [sid, old] of this.walkSt) if (!this.map.has(sid)) {
      for (const id of old.buildings.keys()) { this.covered.get(id)?.delete(sid); dirty.add(id); populations.add(id); }
      this.walkSt.delete(sid); this.served.delete(sid); this.shareGroups.delete(sid); this.shareMembers.delete(sid); this.shareSt.delete(sid);
    }
    for (const st of this.map.values()) {
      order.set(st.id, order.size);
      const walk = walkingCatchment(this.game, st), old = this.walkSt.get(st.id);
      const group = this.catchmentGroup(st.id);
      if (this.shareGroups.get(st.id) !== group) {
        for (const id of old?.buildings.keys() ?? []) dirty.add(id);
        for (const id of walk.buildings.keys()) dirty.add(id);
        this.shareGroups.set(st.id, group);
      }
      if (walk !== old) {
        for (const [id, before] of old?.buildings ?? []) {
          populations.add(id);
          if (!walk.buildings.has(id)) { this.covered.get(id)?.delete(st.id); dirty.add(id); }
          else if (walk.buildings.get(id)!.distance !== before.distance) dirty.add(id);
        }
        for (const [id, reach] of walk.buildings) {
          populations.add(id);
          if (!old?.buildings.has(id)) dirty.add(id);
          let reaches = this.covered.get(id);
          if (!reaches) { reaches = new Map(); this.covered.set(id, reaches); }
          reaches.set(st.id, reach.distance);
        }
        this.walkSt.set(st.id, walk);
        if (!old) this.pendingPop.add(st.id);
      }
      const served = this.game.lines.stationServed(st.id);
      if (this.served.get(st.id) !== served) {
        servedChanged = true; this.served.set(st.id, served);
        for (const id of walk.buildings.keys()) dirty.add(id);
      }
    }
    if (maxB !== previousMaxB) for (const id of this.covered.keys())
      if ((id > previousMaxB && id <= maxB) || (id > maxB && id <= previousMaxB)) { dirty.add(id); populations.add(id); }
    for (const id of populations) {
      const pop = w.buildings.get(id)?.pop ?? 0, before = this.coveredPop.get(id) ?? 0;
      if (pop !== before) {
        if ((pop > 0) !== (before > 0)) dirty.add(id);
        for (const sid of this.covered.get(id)?.keys() ?? []) this.pendingPop.add(sid);
        for (const sid of this.shareB.get(id)?.st ?? []) this.pendingPop.add(sid);
      }
      if (this.covered.get(id)?.size) this.coveredPop.set(id, pop); else this.coveredPop.delete(id);
    }
    let sharesChanged = false;
    const shareStations = new Set<number>();
    for (const id of dirty) {
      const b = w.buildings.get(id), old = this.shareB.get(id);
      const reaches = b && b.pop > 0 && id <= maxB
        ? [...(this.covered.get(id) ?? [])].sort((a, b) => order.get(a[0])! - order.get(b[0])!) : [];
      const anyServed = reaches.some(([sid]) => this.served.get(sid));
      const weights = walkClaimShares(reaches.map(([sid, distance]) => ({ group: this.catchmentGroup(sid),
        weight: anyServed && !this.served.get(sid) ? 0 : walkWeight(distance) })));
      const rec = { st: [] as number[], w: [] as number[] };
      for (let k = 0; k < reaches.length; k++) if (weights[k] > 0) { rec.st.push(reaches[k][0]); rec.w.push(weights[k]); }
      if (!this.covered.get(id)?.size) this.covered.delete(id);
      if (old && old.st.length === rec.st.length && old.st.every((sid, i) => sid === rec.st[i] && old.w[i] === rec.w[i])) continue;
      if (!old && !rec.st.length) continue;
      sharesChanged = true;
      for (const sid of old?.st ?? []) {
        this.shareMembers.get(sid)?.delete(id); this.pendingPop.add(sid); shareStations.add(sid);
      }
      if (rec.st.length) {
        this.shareB.set(id, rec);
        for (let k = 0; k < rec.st.length; k++) {
          const sid = rec.st[k];
          let members = this.shareMembers.get(sid);
          if (!members) { members = new Map(); this.shareMembers.set(sid, members); }
          members.set(id, rec.w[k]); this.pendingPop.add(sid); shareStations.add(sid);
        }
      } else this.shareB.delete(id);
    }
    for (const sid of shareStations) {
      if (!this.map.has(sid)) continue;
      // Population-only edits retain the arrays. Changed shares keep the original ascending sum order.
      const members = [...(this.shareMembers.get(sid) ?? [])].sort((a, b) => a[0] - b[0]);
      if (members.length) this.shareSt.set(sid, { ids: members.map((m) => m[0]), w: members.map((m) => m[1]) });
      else this.shareSt.delete(sid);
    }
    this.sharesReady = true; this.catchMaxB = maxB;
    this.catchInputs = this.currentCatchInputs();
    if (!wasReady || sharesChanged || servedChanged || this.pendingPop.size) this.catchVersion++;
  }

  /** A cold/load computation uses a separate share buffer until every station and building is ready. */
  private fullPreparation: {
    inputs: { roads: number; lots: number; terrain: number; stations: number; served: number }; maxB: number; stations: Station[]; next: number; tick: number;
    walks: Map<number, WalkingCatchment>; covered: Map<number, Map<number, number>>; pop: Map<number, number>;
    served: Map<number, boolean>; ids?: number[]; building: number;
    shareSt: Map<number, { ids: number[]; w: number[] }>; shareB: Map<number, { st: number[]; w: number[] }>;
    members: Map<number, Map<number, number>>; populations: Map<number, number>;
  } | null = null;
  get catchmentWorkPending() { return this.fullPreparation !== null; }

  private prepareFullCatchment(): boolean {
    let job = this.fullPreparation;
    if (!job || !this.sameCatchInputs(job.inputs)) {
      job = { inputs: this.currentCatchInputs(), maxB: this.game.world.nextBuildingId - 1, stations: this.all(), next: 0, tick: -1,
        walks: new Map(), covered: new Map(), pop: new Map(), served: new Map(), building: 0,
        shareSt: new Map(), shareB: new Map(), members: new Map(), populations: new Map() };
      this.fullPreparation = job;
    }
    if (job.tick === this.game.tick) return false;
    job.tick = this.game.tick;
    const B = this.game.world.buildings;
    // Work budgets count entities, never elapsed milliseconds or rendered frames.
    for (let n = 0; n < 2 && job.next < job.stations.length; n++) {
      const st = job.stations[job.next++], walk = walkingCatchment(this.game, st);
      job.walks.set(st.id, walk); job.served.set(st.id, this.game.lines.stationServed(st.id));
      for (const [id, reach] of walk.buildings) {
        let covered = job.covered.get(id);
        if (!covered) { covered = new Map(); job.covered.set(id, covered); }
        covered.set(st.id, reach.distance); job.pop.set(id, B.get(id)?.pop ?? 0);
      }
    }
    if (job.next < job.stations.length) return false;
    job.ids ??= [...job.covered.keys()].sort((a, b) => a - b);
    for (let n = 0; n < 256 && job.building < job.ids.length; n++) {
      const id = job.ids[job.building++], b = B.get(id);
      if (!b || b.pop <= 0 || id > job.maxB) continue;
      // covered was filled in station Map order, exactly as in the original share-out.
      const reaches = [...job.covered.get(id)!], anyServed = reaches.some(([sid]) => job!.served.get(sid));
      const weights = walkClaimShares(reaches.map(([sid, distance]) => ({ group: this.catchmentGroup(sid),
        weight: anyServed && !job.served.get(sid) ? 0 : walkWeight(distance) })));
      const rec = { st: [] as number[], w: [] as number[] };
      for (let k = 0; k < reaches.length; k++) if (weights[k] > 0) {
        const sid = reaches[k][0], sh = weights[k];
        rec.st.push(sid); rec.w.push(sh);
        let station = job.shareSt.get(sid), members = job.members.get(sid);
        if (!station) { station = { ids: [], w: [] }; job.shareSt.set(sid, station); }
        if (!members) { members = new Map(); job.members.set(sid, members); }
        station.ids.push(id); station.w.push(sh); members.set(id, sh);
        job.populations.set(sid, (job.populations.get(sid) ?? 0) + b.pop * sh);
      }
      job.shareB.set(id, rec);
    }
    if (job.building < job.ids.length) return false;
    // Publish all shares and populations together. Demand keeps its previous shares until this point too.
    this.walkSt = job.walks; this.covered = job.covered; this.coveredPop = job.pop; this.served = job.served;
    this.shareGroups = new Map(job.stations.map(st => [st.id, this.catchmentGroup(st.id)]));
    this.shareSt = job.shareSt; this.shareB = job.shareB; this.shareMembers = job.members;
    this.catchMaxB = job.maxB; this.catchInputs = job.inputs; this.sharesReady = true; this.catchVersion++;
    for (const st of this.map.values()) st.catchPop = job.populations.get(st.id) ?? 0;
    this.pendingPop.clear(); this.pendingInputs = false; this.fullPreparation = null;
    return true;
  }

  /** Native share weighting and sum order, without publishing populations or demand. */
  private shareView(walks: Map<number, WalkingCatchment>): { stations: Map<number, { ids: number[]; w: number[]; pop: number }>; buildings: Map<number, { st: number[]; w: number[] }> } {
    const w = this.game.world, stations = new Map<number, { ids: number[]; w: number[]; pop: number }>();
    const buildings = new Map<number, { st: number[]; w: number[] }>(), covered = new Map<number, { sid: number; distance: number }[]>();
    for (const st of this.map.values()) {
      stations.set(st.id, { ids: [], w: [], pop: 0 });
      for (const [id, walk] of walks.get(st.id)!.buildings) {
        const b = w.buildings.get(id); if (!b || b.pop <= 0 || id > this.catchMaxB) continue;
        const a = covered.get(id), c = { sid: st.id, distance: walk.distance };
        if (a) a.push(c); else covered.set(id, [c]);
      }
    }
    for (const [id, reaches] of [...covered].sort((a, b) => a[0] - b[0])) {
      const anyServed = reaches.some((r) => this.game.lines.stationServed(r.sid));
      const weights = walkClaimShares(reaches.map(r => ({ group: this.catchmentGroup(r.sid),
        weight: anyServed && !this.game.lines.stationServed(r.sid) ? 0 : walkWeight(r.distance) })));
      const rec = { st: [] as number[], w: [] as number[] };
      for (let k = 0; k < reaches.length; k++) if (weights[k] > 0) {
        const sh = weights[k], sid = reaches[k].sid, ps = stations.get(sid)!;
        rec.st.push(sid); rec.w.push(sh); ps.ids.push(id); ps.w.push(sh);
      }
      buildings.set(id, rec);
    }
    for (const st of stations.values()) for (let i = 0; i < st.ids.length; i++) st.pop += (w.buildings.get(st.ids[i])?.pop ?? 0) * st.w[i];
    return { stations, buildings };
  }

  /** Uncached, synchronous reference using the original full share-out and floating-point order. */
  debugFullCatchment() { return this.shareView(fullWalkingCatchments(this.game)); }

  private readShares: {
    inputs: { roads: number; lots: number; terrain: number; stations: number; served: number }; maxB: number;
    stations: Map<number, { ids: number[]; w: number[] }>; buildings: Map<number, { st: number[]; w: number[] }>;
  } | null = null;

  /** Current native membership at the saved horizon; only disposable read caches change here. */
  private currentReadShares() {
    const old = this.readShares;
    if (old && old.maxB === this.catchMaxB && this.sameCatchInputs(old.inputs)) return old;
    const walks = new Map<number, WalkingCatchment>();
    for (const st of this.map.values()) walks.set(st.id, readWalkingCatchment(this.game, st));
    const view = this.shareView(walks);
    return this.readShares = { inputs: this.currentCatchInputs(), maxB: this.catchMaxB,
      stations: new Map([...view.stations].map(([id, s]) => [id, { ids: s.ids, w: s.w }])), buildings: view.buildings };
  }

  /** Rebuild derived shares at the saved horizon; a pending road edit still owes a population refresh. */
  restoreCatchmentShares(maxB = this.game.world.nextBuildingId - 1, populationPending = false) {
    this.computeShares(maxB);
    this.pendingInputs = populationPending;
    if (!populationPending) this.pendingPop.clear();
  }

  /**
   * Current walking membership of the published building horizon. Pending inputs are read without
   * publishing catchment populations or demand ahead of their monthly/service update.
   */
  buildingShares(st: Station | number): { ids: number[]; w: number[] } {
    const shares = this.sharesReady && !this.catchmentInputsChanged() ? this.shareSt : this.currentReadShares().stations;
    return shares.get(typeof st === 'number' ? st : st.id) ?? { ids: [], w: [] };
  }

  /** The stations whose catchment holds a building, and their shares of its people (summing to 1; empty: none). */
  stationsForBuilding(bId: number): { st: number[]; w: number[] } {
    const shares = this.sharesReady && !this.catchmentInputsChanged() ? this.shareB : this.currentReadShares().buildings;
    return shares.get(bId) ?? { st: [], w: [] };
  }

  /** Sum of share x f(building) over a station's catchment (e.g. its residents or its jobs). */
  catchSum(st: Station | number, f: (b: Building) => number): number {
    const sh = this.buildingShares(st), B = this.game.world.buildings;
    let sum = 0;
    for (let i = 0; i < sh.ids.length; i++) { const b = B.get(sh.ids[i]); if (b) sum += sh.w[i] * f(b); }
    return sum;
  }

  /**
   * Catchment population of every station (its shares of the buildings' people, see computeShares), after the
   * catchments, the stations, the lines serving them or the buildings change (lines.flushCatchment; monthly).
   */
  recomputeCatchment(slice = false): boolean {
    this.refreshAccess();
    // Finish before daily passenger generation so slicing cannot change the simulation's RNG or demand.
    // Direct/debug callers remain synchronous. Only a cold cache of a running/loaded game needs slices.
    if (slice && !this.game.paused && !this.sharesReady && this.map.size >= 16 && this.game.tick > 0 &&
      this.game.tick % this.game.ticksPerDay !== this.game.ticksPerDay - 1) return this.prepareFullCatchment();
    this.fullPreparation = null;
    this.computeShares(this.game.world.nextBuildingId - 1);
    const B = this.game.world.buildings;
    for (const sid of this.pendingPop) {
      const st = this.map.get(sid); if (!st) continue;
      const sh = this.shareSt.get(sid);
      let pop = 0;
      if (sh) for (let i = 0; i < sh.ids.length; i++) pop += (B.get(sh.ids[i])?.pop ?? 0) * sh.w[i];
      st.catchPop = pop;
    }
    this.pendingPop.clear();
    this.pendingInputs = false;
    return true;
  }

  /**
   * Passengers wait at `st` for `line` to `alight` on their way to `dest`. A walking hop (WALK_LINE) takes them
   * straight to the linked station `alight`, where they arrive or wait for their next leg.
   */
  addWaiting(st: Station, line: number, alight: number, dest: number, count: number, depth = 0, t?: number, transferred = 0, rail = 0) {
    if (count <= 0) return;
    rail = railHistory(rail);
    if (line === WALK_LINE) { this.walkTo(alight, dest, count, depth, t, transferred, st, rail); return; }
    // ops: when they started waiting (weighted mean), their changes of vehicle so far, their rail fares so far; groups
    // never mix fare histories or change classes (each pays its own minimum and transfer reduction)
    const at = t ?? simNow(this.game), tr = Math.max(0, transferred);
    const key = fareGroupKey(line, alight, dest, rail, changeClass(tr, count));
    const g = st.waiting.get(key);
    if (g) {
      g.t = ((g.t ?? at) * g.count + at * count) / (g.count + count); g.count += count; if (tr || g.transfers) g.transfers = (g.transfers ?? 0) + tr;
    } else {
      const ng: WaitGroup = tr ? { line, alight, dest, count, t: at, transfers: tr } : { line, alight, dest, count, t: at };
      if (rail > 0) ng.rail = rail;
      st.waiting.set(key, ng);
    }
    st.waitingTotal += count;
  }

  /**
   * Passengers walk to the linked station `toId`: they have arrived, or wait there for their next leg (the walk
   * counts towards that leg's time).
   */
  private walkTo(toId: number, dest: number, count: number, depth: number, t?: number, transferred = 0, from?: Station, rail = 0) {
    const g = this.game;
    const to = this.map.get(toId);
    if (!to || depth > 4) return;
    if (toId === dest) {
      to.arrivedMonth += count;
      const town = g.towns.list[to.townId];
      if (town) town.passTransMonth += count;
      return;
    }
    const hop = g.lines.nextHop(toId, dest);
    if (!hop) return;
    const at = (t ?? simNow(g)) - (from ? transferWalkTime(this.gap(from, to), this.isSameStationComplex(from.id, to.id)) : 0);
    g.lines.distribute(hop, count, (l, n) => this.addWaiting(to, l, hop.alight, dest, n, depth + 1, at, Math.round((transferred * n) / count), rail));
  }

  /**
   * Passengers beyond the station's useful queue give up waiting: counted per station and town and month
   * (lostMonth, Town.passLostMonth); the share who give up lowers the station's rating (updateRatings).
   */
  trimWaiting(st: Station, max: number) {
    // The caller's legacy platform cap is a hard ceiling. People in the catchment and the size of the transfer
    // complex set the useful queue: tens at a village/stop, low hundreds at a large multi-platform hub. Enlarging
    // platforms alone must not invent thousands of waiting passengers.
    const space = st.rail ? st.rail.tracks * st.rail.length * 0.75 : 0;
    max = Math.max(0, Math.floor(Math.min(max, 300, 12 + st.catchPop * 0.035 + space + st.stops.length * 4)));
    if (st.waitingTotal <= max) return;
    const f = max / st.waitingTotal;
    // Largest remainders retain exactly `max` people. Flooring every OD group independently can erase an entire
    // small queue when the network offers many destinations, and particularly penalises transfer passengers.
    const groups = [...st.waiting].map(([key, g]) => {
      const scaled = g.count * f, count = Math.floor(scaled);
      return { key, g, count, remainder: scaled - count, transfers: g.transfers ?? 0, oldCount: g.count };
    });
    let spare = max - groups.reduce((n, x) => n + x.count, 0);
    groups.sort((a, b) => b.remainder - a.remainder);
    for (const x of groups) if (spare > 0) { x.count++; spare--; }
    let tot = 0, lost = 0;
    for (const x of groups) {
      const g = x.g;
      g.count = x.count;
      lost += x.oldCount - x.count;
      // transfers (the group's changes of vehicle so far) shrink with it, the changes per passenger kept as they were
      // (rounded totals moved a mixed group of older saves into another change class without re-keying it)
      if (x.transfers) g.transfers = x.transfers * g.count / x.oldCount;
      if (g.count <= 0) st.waiting.delete(x.key); else tot += g.count;
    }
    st.waitingTotal = tot;
    this.rekeyWaiting(st);
    if (lost > 0) {
      st.lostMonth = (st.lostMonth || 0) + lost;
      const town = this.game.towns.list[st.townId];
      if (town) town.passLostMonth = (town.passLostMonth ?? 0) + lost;
    }
  }

  /** Mail (units of MAIL_UNIT_T) waits at `st` for `line` to `alight` on its way to `dest`, on journey `j` (default: posted here now). */
  addMail(st: Station, line: number, alight: number, dest: number, count: number, j?: MailJourney) { addMail(this.game, st, line, alight, dest, count, j ?? newJourney(this.game, st, dest)); }
  /** Mail beyond the station's queue cap is lost (mail.ts trimMail). */
  trimMail(st: Station) { trimMail(this.game, st); }
  /** Mail re-routed after the routing changed (mail.ts rerouteMail; Lines.rebuild does this for every station). */
  rerouteMail(st: Station) { rerouteMail(this.game, st); }
  /**
   * Keep a station's waiting groups under their canonical keys (fareGroupKey of their own fields): a group whose change
   * class moved (passengers left it, floating-point at a class boundary) joins the group of its class, in order. A game
   * loaded from a save keys every group afresh, so the running game must too, or later arrivals would merge differently.
   */
  rekeyWaiting(st: Station) {
    const canonical = (w: WaitGroup) => fareGroupKey(w.line, w.alight, w.dest, w.rail ?? 0, changeClass(w.transfers, w.count));
    let stale = false;
    for (const [k, w] of st.waiting) if (canonical(w) !== k) { stale = true; break; }
    if (!stale) return;
    const old = [...st.waiting.values()];
    st.waiting.clear();
    for (const w of old) {
      const key = canonical(w), g = st.waiting.get(key);
      if (!g) { st.waiting.set(key, w); continue; }
      const n = g.count + w.count;
      if (g.t !== undefined || w.t !== undefined) g.t = ((g.t ?? w.t!) * g.count + (w.t ?? g.t!) * w.count) / n;
      if (g.transfers || w.transfers) g.transfers = (g.transfers ?? 0) + (w.transfers ?? 0);
      g.count = n;
    }
  }

  rerouteWaiting(st: Station) {
    const lines = this.game.lines;
    const old = [...st.waiting.values()];
    st.waiting.clear();
    st.waitingTotal = 0;
    for (const g of old) {
      const hop = lines.nextHop(st.id, g.dest);
      if (hop) this.addWaiting(st, hop.line, hop.alight, g.dest, g.count, 0, g.t, g.transfers ?? 0, g.rail ?? 0);
    }
  }

  /** Platform edges of a station. */
  platformEdges(st: Station): number[] { return st.rail ? st.rail.edges : []; }

  // ---------------------------------------------------------------- rebuilding and relocating
  /**
   * Plan rebuilding a ground rail station with longer (or shorter) platforms and / or more tracks, keeping the
   * station (id, name, lines, waiting passengers). Existing tracks keep their positions (new ones are added on
   * the side with room); ends without approach tracks move first, connected ends extend over straight approach
   * track (which is shortened to meet the new platform ends). A level change rebuilds an unconnected station.
   */
  planUpgrade(stationId: number, o: UpgradeOpts): UpgradePlan {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId);
    const r = st?.rail;
    const bad = (error: string): UpgradePlan => ({ ok: false, error, warnings: [], station: stationId, cost: 0, length: r?.length ?? 0, tracks: r?.tracks ?? 0, through: r?.through ?? 0, plan: null, delta: [0, 0], keep: [], cuts: [], rebuild: false });
    if (!st || !r) return bad('No such rail station');
    if (r.native) return bad('Retained track station: geometry-preserving rebuild required');
    const Th0 = r.through ?? 0;
    const L2 = Math.max(4, Math.min(60, o.length ?? r.length)), T2 = Math.max(r.tracks, Math.min(8, o.tracks ?? r.tracks)), Th2 = Math.max(Th0, Math.min(2, o.through ?? Th0));
    const level = o.level ?? r.level ?? 'ground';
    if ((o.tracks ?? r.tracks) < r.tracks) return bad('Tracks can be added, not removed');
    if ((o.through ?? Th0) < Th0) return bad('Through tracks cannot be removed');
    // through tracks added to a station without any go outside its platforms (the platform tracks stay put)
    const mode: ThroughMode = Th0 ? r.throughMode ?? 'middle' : 'outer';
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    // every track (platform and through) with its end nodes and the approach edges there
    const ends: { node: number; approach: number[] }[][] = [];
    const kinds: boolean[] = [];
    for (const [eid, thr] of [...r.edges.map((e) => [e, false] as const), ...r.throughEdges.map((e) => [e, true] as const)]) {
      const e = net.edges.get(eid);
      if (!e) return bad('Station track missing');
      const na = net.nodes.get(e.a)!, nb = net.nodes.get(e.b)!;
      const fwd = (nb.x - na.x) * fx + (nb.z - na.z) * fz >= 0;
      const back = fwd ? na : nb, front = fwd ? nb : na;
      const appr = (n: typeof na) => n.edges.filter((id) => { const f = net.edges.get(id); return f && id !== eid && f.station !== st.id; });
      ends.push([{ node: front.id, approach: appr(front) }, { node: back.id, approach: appr(back) }]);
      kinds.push(thr);
    }
    if (ends.length !== r.tracks + Th0) return bad('Station track split: cannot rebuild; check signals');
    const latOf = (nid: number) => { const n = net.nodes.get(nid)!; return (n.x - r.x) * rx + (n.z - r.z) * rz; };
    const order = ends.map((_, i) => i).sort((p, q) => latOf(ends[p][0].node) - latOf(ends[q][0].node));
    const connected = [ends.some((t) => t[0].approach.length > 0), ends.some((t) => t[1].approach.length > 0)];
    // the building style (restyle: the new building minus 30% salvage of the old one); a head building only at a free end
    const style = o.style && STATION_STYLES[o.style] ? o.style : styleOf(r.style).id;
    const restyle = style !== styleOf(r.style).id ? Math.round(BUILDING_BASE * (styleOf(style).cost - 0.3 * styleOf(r.style).cost)) : 0;
    const blockedEnds = ([[connected[0], 1], [connected[1], -1]] as [boolean, 1 | -1][]).filter(([c]) => c).map(([, e]) => e);
    const rebuild = (lv: StationLevel) => {
      if (connected[0] || connected[1]) return bad(lv !== (r.level ?? 'ground') ? 'Connected station: level cannot change' : 'Connected station: track layout cannot change');
      const ground = lv === 'ground' && (r.level ?? 'ground') === 'ground';
      const avoid = ground ? r.entrances.flatMap((e) => entranceLandings(e).map((p) => landingRect(entranceKind('ground', e), p))) : undefined;
      const plan = this.planRail(r.x, r.z, r.angle, L2, T2, st.owner, { level: lv, height: o.height, depth: o.depth, ignoreStation: st.id, through: Th2, throughMode: mode, trackType: r.trackType, mode: railPartMode(r), platformStyle: r.platformStyle, psd: r.psd, style, avoid });
      // still on the ground: its added entrances stay beside the new platforms where they fit; at another level they go
      const fit = plan.ok && ground ? this.previewRefit(st, plan) : null;
      const gone = ground ? null : entrancesGo(r.level ?? 'ground', r.entrances, 'the station is rebuilt anew');
      const warnings = [...plan.warnings, ...refitWarnings(fit), ...(gone ? [gone] : [])];
      return { ok: plan.ok, error: plan.error, warnings, station: st.id, cost: plan.cost + 20000 + (fit?.streets ?? 0), length: L2, tracks: T2, through: Th2, plan, delta: [0, 0] as [number, number], keep: [], cuts: [], rebuild: true, ...(fit ? { entrances: fit } : {}) };
    };
    if (level !== (r.level ?? 'ground')) return rebuild(level);
    if (level !== 'ground' && L2 === r.length && T2 === r.tracks && Th2 === Th0 && style !== styleOf(r.style).id) {
      // a new building at street level for a station below or above the street (tracks and entrances stay)
      const ign = new Set<number>([...r.edges, ...r.throughEdges, ...ends.flatMap((t) => [...t[0].approach, ...t[1].approach])]);
      const sz = ENTRANCE_SIZE[level];
      const kept = r.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle, w: sz.w, d: sz.d }));
      const p2 = this.planRail(r.x, r.z, r.angle, r.length, r.tracks, st.owner, { level, fixedY: r.y, ignoreStation: st.id, ignoreEdges: ign, through: Th0, throughMode: r.throughMode, trackType: r.trackType, mode: railPartMode(r), platformStyle: r.platformStyle, psd: r.psd, style, avoid: kept });
      if (!p2.ok) return bad(p2.error ?? 'No room for the building');
      if (p2.style !== style) return bad('No room for street-level building');
      // (its entrances stay: the new building must not stand on them)
      if (kept.some((q) => rectsOverlap(p2.building, q, 0.1))) return bad('No room for street-level building beside entrances');
      let cost = Math.max(0, restyle);
      cost += demolitionTotal(g, p2.demolish);
      return { ok: true, warnings: p2.warnings, station: st.id, cost: Math.round(cost + (p2.access?.cost ?? 0)), length: r.length, tracks: r.tracks, through: Th0, plan: p2, delta: [0, 0], keep: [], cuts: [], rebuild: false, restyleOnly: true };
    }
    if (level !== 'ground') return bad('In-place extensions need ground stations');
    const dL = L2 - r.length;
    const splits: [number, number][] = dL === 0 ? [[0, 0]] : !connected[0] && !connected[1] ? [[dL / 2, dL / 2]] : !connected[0] ? [[dL, 0], [dL / 2, dL / 2]] : !connected[1] ? [[0, dL], [dL / 2, dL / 2]] : [[dL / 2, dL / 2], [dL, 0], [0, dL]];
    // lateral: the old tracks keep their offsets (and kinds) inside the new layout, new ones go beside them
    const lay2 = stationLayout(T2, Th2, mode, r.platformStyle ?? 'island');
    const newAll = [...lay2.trackOffsets.map((off, i) => ({ off, key: String(i), thr: false })), ...lay2.throughOffsets.map((off, i) => ({ off, key: 'T' + i, thr: true }))].sort((p, q) => p.off - q.off);
    const old = order.map((i) => ({ off: latOf(ends[i][0].node), thr: kinds[i] }));
    const shifts: { k: number; c: number; keys: string[] }[] = [];
    for (let k = 0; k + old.length <= newAll.length; k++) {
      const c = old[0].off - newAll[k].off;
      if (old.every((v, j) => Math.abs(newAll[k + j].off + c - v.off) < 0.03 && newAll[k + j].thr === v.thr)) shifts.push({ k, c, keys: newAll.slice(k, k + old.length).map((q) => q.key) });
    }
    if (!shifts.length) return rebuild(level);
    // the side for new tracks: k = 0 puts them right of the old ones (positive offsets), the largest k left;
    // 'auto' tries the side away from the building first, then the other, then both sides
    const kMax = newAll.length - old.length;
    const bl = (r.building.x - r.x) * rx + (r.building.z - r.z) * rz;
    const want = o.side ?? 'auto';
    const sideOf = (k: number): 'left' | 'right' | 'both' | 'none' => (kMax === 0 ? 'none' : k === 0 ? 'right' : k === kMax ? 'left' : 'both');
    const pref = want !== 'auto' ? [want] : styleOf(r.style).placement === 'side' && Math.abs(bl) > 0.1 ? (bl > 0 ? ['left', 'right'] : ['right', 'left']) : ['right', 'left'];
    const rank = (k: number) => { const sd = sideOf(k); const i = pref.indexOf(sd); return sd === 'none' ? 0 : i >= 0 ? i : want === 'auto' ? pref.length : 99; };
    const ordered = shifts.filter((sh) => rank(sh.k) < 99).sort((a, b) => rank(a.k) - rank(b.k));
    if (!ordered.length) return bad(`No layout adds tracks on ${want} side`);
    let firstErr = '';
    for (const [dF, dB] of splits) for (const sh of ordered) {
      const res = this.tryUpgrade(st, L2, T2, Th2, mode, dF, dB, sh, order, ends, style, restyle, blockedEnds);
      if (res.ok) {
        // A new ground-level building does not replace unchanged platform track or its electrification.
        if (L2 === r.length && T2 === r.tracks && Th2 === Th0 && style !== styleOf(r.style).id
          && !res.cuts.length && res.delta.every((d) => Math.abs(d) < 1e-6)) res.restyleOnly = true;
        return res;
      }
      if (!firstErr) firstErr = res.error ? (kMax > 0 && sideOf(sh.k) !== 'both' ? `${res.error} (new tracks on the ${sideOf(sh.k)})` : res.error) : '';
    }
    return bad(firstErr || 'Cannot rebuild the station');
  }

  private tryUpgrade(st: Station, L2: number, T2: number, Th2: number, mode: ThroughMode, dF: number, dB: number, sh: { k: number; c: number; keys: string[] }, order: number[], ends: { node: number; approach: number[] }[][], style: string, restyle: number, blockedEnds: (1 | -1)[]): UpgradePlan {
    const g = this.game, net = g.world.net;
    const r = st.rail!;
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const along = (dF - dB) / 2;
    const cx = r.x + fx * along + rx * sh.c, cz = r.z + fz * along + rz * sh.c;
    const bad = (error: string): UpgradePlan => ({ ok: false, error, warnings: [], station: st.id, cost: 0, length: L2, tracks: T2, through: Th2, plan: null, delta: [dF, dB], keep: [], cuts: [], rebuild: false });
    // connected ends that move out: the approach must run straight and level on for the extension (no switch)
    const cuts: UpgradePlan['cuts'] = [];
    // track attached at the platform ends starts on the station's boundary (and is cut back where the ends move)
    const ignoreEdges = new Set<number>(ends.flatMap((t) => [...t[0].approach, ...t[1].approach]));
    for (const id of r.throughEdges) ignoreEdges.add(id);
    const p = { x: 0, y: 0, z: 0 };
    for (const [end, d] of [[0, dF], [1, dB]] as [0 | 1, number][]) {
      if (d < -1e-6 && ends.some((t) => t[end].approach.length)) return bad('Cannot shorten connected platform ends');
      if (d <= 1e-6) continue;
      const dir = end === 0 ? 1 : -1;
      for (let j = 0; j < order.length; j++) {
        const t = ends[order[j]][end];
        if (!t.approach.length) continue;
        if (t.approach.length > 1) return bad('Switch at platform end');
        let node = net.nodes.get(t.node)!, eid = t.approach[0], acc = 0;
        const remove: number[] = [];
        let cut: UpgradePlan['cuts'][number] | null = null;
        for (let guard = 0; guard < 24 && !cut; guard++) {
          const e = net.edges.get(eid);
          if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0) return bad('No plain track beyond platforms');
          if (e.owner !== st.owner) return bad(`Approach track belongs to ${g.company(e.owner).name}`);
          const fromA = e.a === node.id;
          const need = Math.min(e.len, d - acc + 0.6);
          for (const sc of e.sections) { const s0 = fromA ? sc.s0 : e.len - sc.s1; if (s0 < need) return bad('Bridge or tunnel at platform end'); }
          for (let s = 0.5; s <= need + 1e-6; s += 0.5) {
            net.pointAt(e, fromA ? s : e.len - s, p);
            const lat = (p.x - node.x) * rx + (p.z - node.z) * rz, lon = ((p.x - node.x) * fx + (p.z - node.z) * fz) * dir;
            if (Math.abs(lat) > 0.04 || Math.abs(lon - s) > 0.06) return bad('Curve at platform end');
            if (Math.abs(p.y - r.y) > 0.08) return bad('Grade at platform end');
          }
          const rest = d - acc;
          if (Math.abs(e.len - rest) < 0.3) { remove.push(e.id); cut = { end, rank: j, node: t.node, remove, edge: -1, s: 0, fromA, at: fromA ? e.b : e.a }; break; }
          if (e.len > rest) { cut = { end, rank: j, node: t.node, remove, edge: e.id, s: fromA ? rest : e.len - rest, fromA, at: -1 }; break; }
          remove.push(e.id);
          acc += e.len;
          const nn = net.nodes.get(fromA ? e.b : e.a)!;
          if (nn.edges.length !== 2) return bad('Switch too close to platform end');
          node = nn;
          eid = nn.edges.find((x) => x !== e.id)!;
        }
        if (!cut) return bad('No plain track beyond platforms');
        for (const id of cut.remove) ignoreEdges.add(id);
        if (cut.edge >= 0) ignoreEdges.add(cut.edge);
        cuts.push(cut);
      }
    }
    const avoid = (r.level ?? 'ground') === 'ground' ? r.entrances.flatMap((e) => entranceLandings(e).map((p) => landingRect(entranceKind('ground', e), p))) : undefined;
    const plan = this.planRail(cx, cz, r.angle, L2, T2, st.owner, { ignoreStation: st.id, ignoreEdges, through: Th2, throughMode: mode, fixedY: r.y, level: r.level ?? 'ground', trackType: r.trackType, mode: railPartMode(r), platformStyle: r.platformStyle, psd: r.psd, style, blockedEnds, avoid });
    if (!plan.ok) return bad(plan.error ?? 'Cannot build');
    plan.join = null;
    const extra = Math.max(0, (T2 + Th2 * 0.7) * L2 - (r.tracks + (r.through ?? 0) * 0.7) * r.length);
    let cost = extra * 9000 + 60000 + restyle + (plan.access?.cost ?? 0);
    cost += demolitionTotal(g, plan.demolish);
    const warnings = [...plan.warnings];
    if (T2 + Th2 > r.tracks + (r.through ?? 0) && ends.some((t) => t[0].approach.length || t[1].approach.length)) warnings.push('New tracks get turnouts to neighbours where space permits');
    // its added entrances beside the new track area: where they still fit and a street still reaches them
    const fit = this.previewRefit(st, plan);
    if (fit) { cost += fit.streets; warnings.push(...refitWarnings(fit)); }
    return { ok: true, warnings, station: st.id, cost: Math.max(0, Math.round(cost)), length: L2, tracks: T2, through: Th2, plan, delta: [dF, dB], keep: sh.keys, cuts, rebuild: false, ...(fit ? { entrances: fit } : {}) };
  }

  /**
   * Rebuild a station as planned by planUpgrade. Fails with 'busy' when a train stands on its platforms or the
   * approach track being converted. Null = OK, else the reason.
   */
  commitUpgrade(up: UpgradePlan): string | null {
    const g = this.game, net = g.world.net;
    if (!up.ok) return up.error ?? 'Cannot rebuild';
    const st = this.map.get(up.station);
    const r = st?.rail;
    if (!st || !r) return 'No such rail station';
    if (r.native) return 'Retained-track stations need geometry-preserving works';
    if (!up.plan) return up.error ?? 'Cannot rebuild';
    if (up.rebuild) {
      // rebuilt anew on its site: still on the ground, its added entrances stay beside the platforms where they fit
      const old = r.entrances, keep = (r.level ?? 'ground') === 'ground' && up.plan.level === 'ground';
      const err = this.relocate(st.id, up.plan, up.cost - (up.entrances?.streets ?? 0));
      if (!err && keep && old.length) {
        const nr = st.rail!;
        if (typeof nr.cost === 'number') nr.cost += old.reduce((c, e) => c + (e.cost ?? 0), 0);
        this.refitEntrances(st, old);
        this.markStation(st);
      }
      return err;
    }
    if (up.restyleOnly) {
      const co = g.company(st.owner);
      if (!co.economy.canAfford(up.cost)) return 'Not enough money';
      co.economy.spend(up.cost - (up.plan.access?.cost ?? 0) - (up.entrances?.streets ?? 0), 'construction');
      for (const id of up.plan.demolish) g.towns.demolishBuilding(id);
      this.markStation(st);
      r.style = up.plan.style; r.building = up.plan.style === 'none' ? r.building : up.plan.building;
      r.forecourt = up.plan.style === 'none' ? undefined : up.plan.forecourt ?? undefined; r.forecourt2 = up.plan.forecourt2 ?? undefined;
      if ((r.level ?? 'ground') === 'ground' && typeof r.cost === 'number') r.cost += up.cost - (up.entrances?.streets ?? 0);
      if (up.plan.access && up.plan.access.ok) commitProposal(g, up.plan.access);
      if ((r.level ?? 'ground') === 'ground' && r.entrances.length) this.refitEntrances(st, r.entrances);
      for (const f of this.footprints(st)) if (f.part === 'entrance' || f.part === 'building') this.padGround(f);
      this.repairSite(st);
      this.markStation(st);
      this.accessVersion = -1;
      g.lines.catchmentDirty = true;
      return null;
    }
    // the network must still be as planned
    for (const c of up.cuts) {
      for (const id of c.remove) if (!net.edges.has(id)) return 'The track changed, plan again';
      if (c.edge >= 0) { const e = net.edges.get(c.edge); if (!e || c.s <= 0.05 || c.s >= e.len - 0.05) return 'The track changed, plan again'; }
      if (c.at >= 0 && !net.nodes.has(c.at)) return 'The track changed, plan again';
    }
    const occupied = [...r.edges, ...r.throughEdges, ...up.cuts.flatMap((c) => [...c.remove, c.edge])].some((eid) => eid >= 0 && g.vehicles.isEdgeBusy(eid));
    // new tracks may need the crossovers at a connected end moved out: they must be free of trains too
    // new tracks get a turnout ladder at connected ends: the line track there must be free of trains (crossovers
    // in the ladder's way are laid again further out, where the track is free)
    const added = up.tracks + up.through - (r.tracks + (r.through ?? 0));
    if (added > 0) {
      // Hold incoming trains while occupied platforms drain too: waiting for empty platforms before taking
      // a possession lets the next train enter them, so a busy terminus can never begin its upgrade.
      let free = !occupied;
      for (const end of ['front', 'back'] as const) if (!throatFree(g, st.id, end, st.owner, added)) free = false;
      if (!free) {
        // a possession: trains no longer enter the works area (held for up to 30 days) while those in it leave
        if (!this.holds.has(st.id)) {
          const edges = (['front', 'back'] as const).flatMap((end) => holdThroat(g, st.id, end, st.owner, added));
          if (edges.length) this.holds.set(st.id, { edges, until: g.day + 30 });
        }
        return 'busy';
      }
    } else if (occupied) return 'busy';
    const hold = this.holds.get(st.id);
    if (hold) { releaseHold(g, hold.edges); this.holds.delete(st.id); }
    const co = g.company(st.owner);
    if (!co.economy.canAfford(up.cost)) return 'Not enough money';
    // (new access streets to added entrances are paid as they are built)
    co.economy.spend(up.cost - (up.plan.access?.cost ?? 0) - (up.entrances?.streets ?? 0), 'construction');
    const plan = up.plan;
    const signalled = this.signalledNear(st);
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    // the new track ends: kept connected end nodes, or nodes where the approach is cut
    const reuse = new Map<string, number>();
    const oldEnds = this.trackEnds(st, true);
    for (let j = 0; j < oldEnds.length; j++) {
      const t = oldEnds[j], key = up.keep[j];
      if (key === undefined) continue;
      const conn = (nid: number) => !!net.nodes.get(nid)?.edges.some((id) => id !== t.edge && net.edges.get(id)?.station !== st.id);
      if (Math.abs(up.delta[0]) < 1e-6 && conn(t.front)) reuse.set(key + ':f', t.front);
      if (Math.abs(up.delta[1]) < 1e-6 && conn(t.back)) reuse.set(key + ':b', t.back);
    }
    for (const c of up.cuts) {
      const rm = [...c.remove];
      let nodeId = c.at;
      if (c.edge >= 0) {
        const res = net.splitEdge(c.edge, c.s)!;
        nodeId = res.node.id;
        rm.push(c.fromA ? res.e1.id : res.e2.id);
      }
      reuse.set(up.keep[c.rank] + (c.end === 0 ? ':f' : ':b'), nodeId);
      for (const id of rm) net.removeEdge(id);
    }
    for (const eid of [...r.edges, ...r.throughEdges]) net.removeEdge(eid);
    this.markStation(st);
    st.rail = null;
    this.buildRailPart(st, { ...plan, cost: (r.cost ?? 0) + up.cost - (up.entrances?.streets ?? 0) }, st.owner, reuse);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    // the added entrances of a ground station stay beside the new track area where they still fit and a street still
    // reaches them (a short new access street where needed), else they go
    if ((r.level ?? 'ground') === 'ground' && r.entrances.length) { this.refitEntrances(st, r.entrances); this.markStation(st); }
    // new tracks at connected ends: turnout ladders onto the neighbouring tracks' approaches (crossovers in the way
    // are laid again beyond them); the throat signals again
    growThroat(g, st.id, st.owner);
    g.lines.rebuild();
    if (signalled) this.resignal(st);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  /**
   * Track end nodes of a rail station in lateral order (left to right): per track the front (+axis) and back node,
   * its edge, and whether it is a through track (only listed with `withThrough`).
   */
  trackEnds(st: Station, withThrough = false): { front: number; back: number; edge: number; through: boolean }[] {
    const net = this.game.world.net, r = st.rail;
    if (!r) return [];
    if (r.groups) return this.railTrackGroups(st, withThrough).map((t) => ({ front: t.front, back: t.back, edge: t.steps[0].edge, through: t.through }));
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const out: { front: number; back: number; edge: number; through: boolean; lat: number }[] = [];
    const add = (eid: number, through: boolean) => {
      const e = net.edges.get(eid);
      if (!e) return;
      const a = net.nodes.get(e.a)!, b = net.nodes.get(e.b)!;
      const fw = (b.x - a.x) * fx + (b.z - a.z) * fz >= 0;
      out.push({ front: fw ? b.id : a.id, back: fw ? a.id : b.id, edge: eid, through, lat: ((a.x + b.x) / 2 - r.x) * rx + ((a.z + b.z) / 2 - r.z) * rz });
    };
    for (const eid of r.edges) add(eid, false);
    if (withThrough) for (const eid of r.throughEdges) add(eid, true);
    // a split track (e.g. a signal on a through track) is listed once, by its outermost pieces
    const merged: typeof out = [];
    for (const t of out.sort((p, q) => p.lat - q.lat)) {
      const m = merged.find((q) => Math.abs(q.lat - t.lat) < 0.05);
      if (!m) { merged.push({ ...t }); continue; }
      const along = (id: number) => { const n = net.nodes.get(id)!; return (n.x - r.x) * fx + (n.z - r.z) * fz; };
      if (along(t.front) > along(m.front)) m.front = t.front;
      if (along(t.back) < along(m.back)) m.back = t.back;
    }
    return merged.map(({ front, back, edge, through }) => ({ front, back, edge, through }));
  }

  /** Ordered physical tracks, with stable native identities; legacy chains are derived without saving or mutating. */
  railTrackGroups(st: Station, withThrough = false): RailTrackGroup[] {
    const r = st.rail, net = this.game.world.net;
    if (!r) return [];
    if (r.groups) return r.groups.flatMap((q): RailTrackGroup[] => {
      if ((!withThrough && q.through) || !q.steps.length) return [];
      let node = q.back, length = 0;
      const seen = new Set<number>(), members = q.through ? r.throughEdges : r.edges;
      for (const s of q.steps) {
        const e = net.edges.get(s.edge);
        if (!e || e.kind !== 'rail' || seen.has(e.id) || !members.includes(e.id)
          || (s.dir !== 1 && s.dir !== -1) || (s.dir > 0 ? e.a : e.b) !== node) return [];
        seen.add(e.id); node = s.dir > 0 ? e.b : e.a; length += e.len;
      }
      // A broken or truncated physical platform is unavailable, never a sum across disconnected pieces.
      if (node !== q.front) return [];
      return [{ ...q, steps: q.steps.map((s) => ({ ...s })), length }];
    });
    const out: RailTrackGroup[] = [];
    for (const through of withThrough ? [false, true] : [false]) {
      const remaining = new Set((through ? r.throughEdges : r.edges).filter((id) => net.edges.has(id)));
      while (remaining.size) {
        const seed = remaining.values().next().value!, ids = new Set<number>(), todo = [seed];
        while (todo.length) {
          const id = todo.pop()!;
          if (!remaining.delete(id)) continue;
          ids.add(id);
          const e = net.edges.get(id)!;
          for (const nid of [e.a, e.b]) for (const next of net.nodes.get(nid)?.edges ?? []) if (remaining.has(next)) todo.push(next);
        }
        const nodes = new Map<number, number[]>();
        for (const id of ids) { const e = net.edges.get(id)!; for (const nid of [e.a, e.b]) nodes.set(nid, [...(nodes.get(nid) ?? []), id]); }
        const ends = [...nodes].filter(([, e]) => e.length === 1).map(([id]) => id);
        if (ends.length !== 2) continue;
        const along = (id: number) => { const n = net.nodes.get(id)!; return (n.x - r.x) * Math.sin(r.angle) + (n.z - r.z) * Math.cos(r.angle); };
        ends.sort((a, b) => along(a) - along(b));
        const steps: RailTrackStep[] = [], seen = new Set<number>();
        let node = ends[0];
        while (node !== ends[1]) {
          const id = nodes.get(node)?.find((e) => !seen.has(e));
          if (id === undefined) break;
          seen.add(id); const e = net.edges.get(id)!;
          const dir = e.a === node ? 1 : -1;
          steps.push({ edge: id, dir }); node = dir > 0 ? e.b : e.a;
        }
        if (node !== ends[1] || !steps.length) continue;
        const a = net.nodes.get(ends[0])!, b = net.nodes.get(ends[1])!;
        const offset = ((a.x + b.x) / 2 - r.x) * Math.cos(r.angle) - ((a.z + b.z) / 2 - r.z) * Math.sin(r.angle);
        out.push({ id: steps[0].edge, through, offset, steps, back: ends[0], front: ends[1], length: steps.reduce((n, s) => n + net.edges.get(s.edge)!.len, 0) });
      }
    }
    return out.sort((a, b) => a.offset - b.offset || a.id - b.id);
  }

  // ---------------------------------------------------------------- capacity
  /** Edges of each station track (platform tracks, then through tracks when asked), grouped by lateral offset. */
  private trackGroups(st: Station, withThrough = false): number[][] {
    const r = st.rail, net = this.game.world.net;
    if (!r) return [];
    if (r.groups) return this.railTrackGroups(st, withThrough).map((q) => q.steps.map((s) => s.edge));
    const ca = Math.cos(r.angle), sa = Math.sin(r.angle);
    const out: { lat: number; ids: number[] }[] = [];
    for (const id of withThrough ? [...r.edges, ...r.throughEdges] : r.edges) {
      const e = net.edges.get(id);
      if (!e) continue;
      const a = net.nodes.get(e.a)!, b = net.nodes.get(e.b)!;
      const lat = ((a.x + b.x) / 2 - r.x) * ca - ((a.z + b.z) / 2 - r.z) * sa;
      const grp = out.find((q) => Math.abs(q.lat - lat) < 0.05);
      if (grp) grp.ids.push(id); else out.push({ lat, ids: [id] });
    }
    return out.sort((p, q) => p.lat - q.lat).map((q) => q.ids);
  }

  /** Station works waiting for a free throat: track held so no train enters (see commitUpgrade). */
  private holds = new Map<number, { edges: number[]; until: number }>();

  heldForWorks(edge: number): boolean {
    return [...this.holds].some(([sid, h]) => this.map.has(sid) && h.until > this.game.day && h.edges.includes(edge));
  }
  saveWorks(): [number, { edges: number[]; until: number }][] {
    return [...this.holds].map(([sid, h]): [number, typeof h] => [sid, { edges: [...h.edges], until: h.until }]).sort((a, b) => a[0] - b[0]);
  }
  loadWorks(holds: ReturnType<Stations['saveWorks']>) {
    for (const h of this.holds.values()) releaseHold(this.game, h.edges);
    this.holds.clear();
    for (const [sid, h] of holds) {
      if (!this.map.has(sid)) continue;
      const edges = h.edges.filter((id) => this.game.world.net.edges.has(id));
      if (!edges.length) continue;
      this.holds.set(sid, { edges, until: h.until });
      for (const id of edges) this.game.vehicles.setRes(id, WORKS_HOLD);
    }
  }

  /**
   * Daily platform sampling for the capacity figures (game.ts, once a day): occupied platform tracks, trains
   * calling and passing (each train counted once per visit), as rolling means over about a month.
   */
  daily() {
    const g = this.game, V = g.vehicles, K = 1 / 30;
    for (const [sid, h] of [...this.holds]) if (g.day >= h.until || !this.map.has(sid)) { releaseHold(g, h.edges); this.holds.delete(sid); }
    for (const st of this.map.values()) {
      if (!st.rail) continue;
      const groups = this.trackGroups(st);
      let busy = 0;
      const here: number[] = [];
      for (const ids of groups) {
        let t = 0;
        for (const id of ids) { t = V.getRes(id); if (t) break; }
        if (!t) continue;
        busy++;
        if (!here.includes(t)) here.push(t);
      }
      let calls = 0, passes = 0;
      for (const t of here) {
        if (st.onPlat?.includes(t)) continue;
        const v = V.get(t);
        if (v?.line?.stops.includes(st.id)) calls++; else passes++;
      }
      st.occ = (st.occ ?? 0) * (1 - K) + (groups.length ? busy / groups.length : 0) * K;
      st.tpd = (st.tpd ?? 0) * (1 - K) + calls * K;
      st.ppd = (st.ppd ?? 0) * (1 - K) + passes * K;
      st.onPlat = here;
    }
  }

  /** Service frequency: the share of the last CALL_DAYS days on which a vehicle called at the station (0..1). */
  callShare(st: Station): number {
    let m = st.callDays || 0, n = 0;
    while (m) { m &= m - 1; n++; }
    return n / CALL_DAYS;
  }

  /**
   * Daily station ratings (game.ts): a rating moves towards a target from the days since a vehicle last called,
   * the queue, the speed of the services and the share of passengers who gave up waiting (lostShare); a station
   * no line serves stays at or below 50 %. Also the service history (callDays: the days a vehicle called, from lastCall).
   */
  updateRatings() {
    const g = this.game;
    for (const st of this.map.values()) {
      const days = g.day - st.lastPickup;
      // a vehicle called yesterday (building the station is no call: lastCall is only set by vehicles)
      const called = st.lastCall >= 0 && g.day - st.lastCall === 1 ? 1 : 0;
      st.callDays = (((st.callDays || 0) << 1) | called) & CALL_MASK;
      let target = 0.33;
      target += days <= 7 ? 0.27 : days <= 14 ? 0.18 : days <= 30 ? 0.08 : 0;
      target += st.waitingTotal < 100 ? 0.15 : st.waitingTotal < 400 ? 0.08 : st.waitingTotal < 1200 ? 0 : -0.12;
      target += Math.min(0.17, Math.max(0, (st.lastSpeed - 45) / 900));
      target -= RATING_LOST * lostShare(st);
      if (!g.lines.stationServed(st.id)) target = Math.min(target, 0.5);
      st.rating += (target - st.rating) * 0.04;
      st.rating = Math.max(0, Math.min(1, st.rating));
    }
  }

  /**
   * How busy a rail station's platforms are and whether it should grow (more platform tracks, through tracks
   * for trains passing without stopping, longer platforms for longer trains); null for stations without rail.
   */
  capacity(stationId: number): StationCapacity | null {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId), r = st?.rail;
    if (!st || !r) return null;
    const p = { x: 0, y: 0, z: 0 };
    let waiting = 0, lines = 0, longest = 0;
    const R = r.length / 2 + 40;
    for (const v of g.vehicles.map.values()) {
      const t = v as unknown as { kind: string; state: string; routeTarget?: number; length: number; worldPos(o: typeof p): void };
      if (t.kind !== 'train' || t.state !== 'waiting' || t.routeTarget !== st.id) continue;
      t.worldPos(p);
      if (Math.hypot(p.x - r.x, p.z - r.z) <= R) waiting++;
    }
    for (const l of g.lines.map.values()) {
      if (!l.stops.includes(st.id)) continue;
      lines++;
      for (const vid of l.vehicles) { const v = g.vehicles.get(vid) as unknown as { kind: string; length: number } | undefined; if (v && v.kind === 'train') longest = Math.max(longest, v.length); }
    }
    const ends = this.trackEnds(st);
    const freeEnd = (k: 'front' | 'back') => ends.every((t) => (net.nodes.get(t[k])?.edges.length ?? 0) <= 1);
    const terminus = freeEnd('front') || freeEnd('back');
    const occ = st.occ ?? 0, tpd = st.tpd ?? 0, ppd = st.ppd ?? 0;
    let tracks = r.tracks, through = r.through ?? 0, length = r.length;
    const why: string[] = [];
    if (longest > r.length - 0.2) { length = Math.min(40, Math.ceil(longest + 1)); why.push(`trains of ${Math.round(longest * 10)} m on ${Math.round(r.length * 10)} m platforms`); }
    if (occ > 0.6 || (waiting > 0 && occ > 0.4)) { tracks = Math.min(8, tracks + 2); why.push(`platforms ${Math.round(occ * 100)}% occupied${waiting ? `, ${waiting} train${waiting > 1 ? 's' : ''} waiting` : ''}${terminus ? ' (turning trains)' : ''}`); }
    else if (lines > r.tracks * 2) { tracks = Math.min(8, tracks + 2); why.push(`${lines} lines on ${r.tracks} platform track${r.tracks > 1 ? 's' : ''}`); }
    if (ppd > 0.15 && through < 2 && !terminus) { through = 2; why.push(`${ppd.toFixed(1)} non-stopping trains/day`); }
    const grow = tracks !== r.tracks || through !== (r.through ?? 0) || length !== r.length;
    return {
      station: st.id, platforms: r.tracks, through: r.through ?? 0, length: r.length, occupancy: occ, waitingTrains: waiting, lines,
      trainsPerDay: tpd, trainsPerHour: tpd / 24, passingPerDay: ppd, longestTrain: longest, terminus,
      recommended: grow ? { tracks, through, length } : null,
      reason: grow ? why.join('; ') : occ < 0.3 ? 'Plenty of room' : 'Enough platforms for now',
    };
  }

  /**
   * A station's platforms moved to another level in place (planRelevel: the track keeps its edges, the relevel
   * sets their heights and structures): the new level's height, entrances or piers and building from `plan`.
   */
  relevelInPlace(stationId: number, plan: StationPlan) {
    const g = this.game;
    const st = this.map.get(stationId), r = st?.rail;
    if (!st || !r || r.native && !plan.alignment) return;
    this.markStation(st);
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    // added entrances: a ground station staying on the ground keeps them beside its platforms where they still fit
    // (refitEntrances); at another level they go (planRelevel warns), their price leaving the station's value
    const added = r.entrances.filter((e) => e.kind), keep = (r.level ?? 'ground') === 'ground' && plan.level === 'ground';
    const addedCost = added.reduce((c, e) => c + (e.cost ?? 0), 0);
    r.level = plan.level; r.underground = plan.level === 'underground'; r.y = plan.y; r.depth = plan.depth; r.height = plan.height;
    if (r.native) r.alignment = plan.alignment;
    r.entrances = plan.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle }));
    r.piers = plan.piers.map((p) => ({ ...p }));
    r.style = plan.style; r.building = plan.building;
    r.forecourt = plan.forecourt ?? undefined; r.forecourt2 = plan.forecourt2 ?? undefined;
    r.cost = Math.round(Math.max(0, (r.cost ?? 0) - addedCost) * 0.7 + plan.cost) + (keep ? addedCost : 0);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    if (plan.level === 'ground') this.levelGround(plan);
    else for (const f of this.footprints(st)) if (f.part === 'entrance' || f.part === 'building') this.padGround(f);
    this.repairSite(st);
    if (keep && added.length) this.refitEntrances(st, added, { what: 're-levelled' });
    this.markStation(st);
    this.accessVersion = -1;
    g.lines.catchmentDirty = true;
  }

  /** Is there a signal around a station (its throats, within ~40 units of the platforms)? */
  private signalledNear(st: Station): boolean {
    const net = this.game.world.net, r = st.rail;
    if (!r) return false;
    const R = r.length / 2 + 40;
    for (const id of net.nodeGrid.query(r.x - R, r.z - R, r.x + R, r.z + R)) if (net.nodes.get(id)?.signal) return true;
    return false;
  }

  /** After the throat changed: the owner's lines through the station get their signals by the rules again. */
  private resignal(st: Station) {
    const g = this.game;
    for (const l of g.lines.map.values()) if (l.owner === st.owner && l.stops.includes(st.id)) autoSignalLine(g, l.id, st.owner);
  }

  // ---------------------------------------------------------------- passing through (service patterns)
  private throughOf = new Map<number, number>();
  private throughOfVersion = -1;
  /** The station whose through track (no platform) an edge is, or -1. */
  throughStationOf(edgeId: number): number {
    const net = this.game.world.net;
    if (this.throughOfVersion !== net.version) {
      this.throughOf.clear();
      for (const st of this.map.values()) if (st.rail) for (const id of st.rail.throughEdges) this.throughOf.set(id, st.id);
      this.throughOfVersion = net.version;
    }
    return this.throughOf.get(edgeId) ?? -1;
  }

  /**
   * Station tracks a train passing without stopping can take, best first, travelling along the station axis
   * `dir` (+1: towards the front (sin a, cos a), -1: towards the back; or a travel vector): tracks connected at
   * both ends whose signals let trains through that way; through tracks (no platform) first, then platform
   * tracks; free ones (no train on them) before busy ones. `entry` / `exit`: the track's end nodes in travel
   * order. (findRailRoute already prefers through tracks and free platforms on the way to a train's next stop;
   * this is for choosing or checking explicitly.)
   */
  passTracks(stationId: number, dir: number | { x: number; z: number }): PassTrack[] {
    const st = this.map.get(stationId), r = st?.rail;
    if (!st || !r) return [];
    const net = this.game.world.net, V = this.game.vehicles;
    const fwd = typeof dir === 'number' ? dir > 0 : dir.x * Math.sin(r.angle) + dir.z * Math.cos(r.angle) >= 0;
    const out: PassTrack[] = [];
    for (const t of this.trackEnds(st, true)) {
      const entry = fwd ? t.back : t.front, exit = fwd ? t.front : t.back;
      const ne = net.nodes.get(entry), nx = net.nodes.get(exit);
      if (!ne || !nx) continue;
      // the track's own edges at both ends, and the approach beyond them
      const own = (n: typeof ne) => n.edges.map((id) => net.edges.get(id)!).find((e) => e.station === st.id || this.throughStationOf(e.id) === st.id);
      const away = (n: typeof ne, o: NEdge | undefined) => n.edges.map((id) => net.edges.get(id)!).filter((e) => e !== o);
      const oe = own(ne), ox = own(nx);
      if (!oe || !ox || !away(ne, oe).length || !away(nx, ox).length) continue;
      // signals: entering the track at the entry node, leaving it at the exit node
      if (net.signalFor(ne, net.sideAt(oe, ne.id)) < 0) continue;
      if (!away(nx, ox).some((e) => net.signalFor(nx, net.sideAt(e, nx.id)) >= 0)) continue;
      const pieces = t.through ? r.throughEdges : r.edges;
      const lat = (id: number) => { const e = net.edges.get(id); if (!e) return NaN; const a = net.nodes.get(e.a)!; return (a.x - r.x) * Math.cos(r.angle) - (a.z - r.z) * Math.sin(r.angle); };
      const l0 = lat(t.edge), group = r.groups?.find((q) => q.steps.some((s) => s.edge === t.edge));
      const mine = group ? group.steps.map((s) => s.edge) : pieces.filter((id) => Math.abs(lat(id) - l0) < 0.05);
      out.push({ edge: t.edge, edges: mine, entry, exit, through: t.through, free: !mine.some((id) => V.isEdgeBusy(id)) });
    }
    return out.sort((a, b) => Number(b.through) - Number(a.through) || Number(b.free) - Number(a.free));
  }

  /** The through track (no platform) a train passing the station takes in that direction, or null (it passes a platform track then). */
  throughTrackFor(stationId: number, dir: number | { x: number; z: number }): PassTrack | null {
    return this.passTracks(stationId, dir).find((t) => t.through) ?? null;
  }

  /**
   * Move a station's rail part to a new site (a plan from planRail, e.g. with { ignoreStation }): the old platforms
   * are removed, the station keeps its id, name, lines and waiting passengers. Fails with 'busy' when a train stands
   * in the station. Null = OK, else the reason.
   */
  relocate(stationId: number, plan: StationPlan, cost?: number): string | null {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId);
    if (!st || !st.rail) return 'No such rail station';
    if (st.rail.native) return 'Retained-track stations cannot be moved off their running tracks';
    if (!plan.ok) return plan.error ?? 'Cannot build';
    for (const eid of [...st.rail.edges, ...st.rail.throughEdges]) if (g.vehicles.isEdgeBusy(eid)) return 'busy';
    const total = cost ?? plan.cost + 20000;
    const co = g.company(st.owner);
    if (!co.economy.canAfford(total)) return 'Not enough money';
    co.economy.spend(total - (plan.access?.cost ?? 0), 'construction');
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const old = st.rail;
    for (const eid of [...old.edges, ...old.throughEdges]) net.removeEdge(eid);
    this.markStation(st);
    st.rail = null;
    this.repairSite({ x: old.x, z: old.z, rail: old });
    this.buildRailPart(st, plan, st.owner);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    for (const o of plan.links) if (o !== st && this.map.get(o.id) === o && !this.canLink(st.id, o.id) && this.nearbyComplex(st, o)) this.addLink(st, o);
    this.autoLinkNearby(st);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }
}

/** The service history of a saved station (older saves: from the day of its last pickup, if later than its building). */
function callsOf(s: any): { lastCall: number; callDays: number } {
  const lastCall = typeof s.lastCall === 'number' ? s.lastCall : s.lastPickup > s.built ? s.lastPickup : -1;
  return { lastCall, callDays: typeof s.callDays === 'number' ? s.callDays : lastCall >= 0 ? OLD_SAVE_CALLS : 0 };
}

/** A station restored from a save: own copies of every array, defaults for fields older saves lack. */
export function restoreStation(s: any): Station {
  const r = s.rail;
  const lv: StationLevel = r ? (r.level ?? (r.underground ? 'underground' : 'ground')) : 'ground';
  return {
    ...s,
    rail: r ? {
      ...r, ...(r.alignment ? { alignment: { tracks: r.alignment.tracks.map((t: any) => ({ ...t, pieces: t.pieces.map((p: any) => ({ ...p, curve: { ...p.curve }, profile: [...p.profile] })), knots: t.knots.map((k: any) => ({ ...k })) })) } } : {}),
      ...(r.groups ? { groups: r.groups.map((q: any) => ({ ...q, steps: q.steps.map((p: any) => ({ ...p })) })) } : {}),
      edges: [...r.edges], trackOffsets: [...(r.trackOffsets ?? [])], platforms: (r.platforms ?? []).map((p: any) => ({ ...p })), building: { ...r.building },
      through: r.through ?? 0, throughOffsets: [...(r.throughOffsets ?? [])], throughEdges: [...(r.throughEdges ?? [])], width: r.width ?? stationLayout(r.tracks, r.through ?? 0).width,
      trackType: trackTypeOf(r.trackType), mode: railPartMode(r), platformStyle: r.platformStyle ?? 'island', psd: !!r.psd,
      style: r.style && STATION_STYLES[r.style] ? r.style : 'classic', forecourt2: r.forecourt2 ? { ...r.forecourt2 } : undefined,
      level: lv, underground: lv === 'underground', depth: r.depth ?? 0, height: r.height ?? 0,
      entrances: (r.entrances ?? []).map((e: any) => ({ ...e, ...(e.far ? { far: { ...e.far } } : {}) })), piers: (r.piers ?? []).map((p: any) => ({ ...p })),
      forecourt: r.forecourt ? { ...r.forecourt } : undefined,
    } : null,
    stops: (s.stops ?? []).map((p: any) => ({ ...p })),
    links: [...(s.links ?? [])],
    roadAccess: s.roadAccess ?? true,
    // older saves: no passengers lost yet; a station picked up from after it was built has had calls (a typical
    // frequency, three in the last 30 days, to start from)
    lostMonth: s.lostMonth ?? 0, lostLast: s.lostLast ?? 0, ...callsOf(s),
    // (no key before the first daily sampling: that adds its figures in the original's order)
    ...(s.onPlat ? { onPlat: [...s.onPlat] } : {}),
    waiting: new Map(),
  };
}

// ------------------------------------------------------------------ game-level wrappers (AI / UI)

/** Plan rebuilding a rail station with longer platforms / more tracks / another level (see Stations.planUpgrade). */
export function planStationUpgrade(g: Game, stationId: number, o: UpgradeOpts): UpgradePlan { return g.stations.planUpgrade(stationId, o); }
/** Rebuild a station as planned; 'busy' while a train stands in it. Null = OK, else the reason. */
export function commitStationUpgrade(g: Game, plan: UpgradePlan): string | null { return g.stations.commitUpgrade(plan); }
/**
 * Merge two adjacent stop stations of one owner (bus / tram stops within STOP_JOIN, no platforms) into one:
 * lines, passengers and links move to `a`, and b's stops that lie next to a stop of a of the same kind go (one
 * stop to maintain instead of two). Returns the station and how many stops went, or the reason.
 */
export function mergeStops(g: Game, aId: number, bId: number): { error: string | null; station: number; removedStops: number } {
  const S = g.stations, net = g.world.net;
  const a = S.get(aId), b = S.get(bId);
  const bad = (error: string) => ({ error, station: -1, removedStops: 0 });
  if (!a || !b || a === b) return bad('Pick two stations');
  if (a.rail || b.rail || !a.stops.length || !b.stops.length) return bad('Only bus / tram stops can merge this way');
  if (a.owner !== b.owner) return bad('Only stops of the same company');
  if (S.gap(a, b) > STOP_JOIN) return bad(`Too far apart (at most ${STOP_JOIN * 10} m)`);
  const tramAt = (q: BusStop) => !!net.edges.get(q.edge)?.tram;
  const bStops = b.stops.map((q) => ({ ...q }));
  const err = S.merge(aId, bId);
  if (err) return bad(err);
  let removed = 0;
  for (const q of bStops) {
    const i = a.stops.findIndex((p) => p.edge === q.edge && Math.abs(p.s - q.s) < 1e-6);
    if (i < 0) continue;
    const twin = a.stops.some((p, j) => j !== i && tramAt(p) === tramAt(q) && Math.hypot(p.x - q.x, p.z - q.z) <= STOP_JOIN);
    if (twin) { S.removeStop(a, i); removed++; }
  }
  return { error: null, station: a.id, removedStops: removed };
}

/**
 * A station's transfer complex shown as one station (one label, one window): its main part (rail before stops,
 * the most platform tracks, main line before metro and light rail, then the busiest) and all parts, main first.
 */
export function stationComplex(g: Game, id: number): { main: number; parts: number[] } {
  const S = g.stations;
  const rank = (sid: number) => {
    const st = S.get(sid);
    if (!st) return -1;
    const m = S.mode(st);
    return (st.rail ? 100 + st.rail.tracks * 10 : 0) + (m === 'mainline' ? 5 : m === 'metro' ? 3 : m === 'lightrail' ? 2 : 0) + Math.min(4.9, (st.pickupLast + st.arrivedLast) / 1000);
  };
  const parts = [...S.catchmentMembers(id)].sort((a, b) => rank(b) - rank(a) || a - b);
  return { main: parts[0] ?? id, parts };
}

/** Platform use and growth recommendation of a rail station (see Stations.capacity). */
export function stationCapacity(g: Game, stationId: number): StationCapacity | null { return g.stations.capacity(stationId); }
/** Move a station to a new site (plan from planRail with { ignoreStation: id } when it overlaps the old site). */
export function relocateStation(g: Game, stationId: number, plan: StationPlan): string | null { return g.stations.relocate(stationId, plan); }

export { ROAD_TYPES };
