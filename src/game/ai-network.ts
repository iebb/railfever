// AI network management (v2.4, UPDATE 9f / 9g / 9i / 9k / 9l / 9m): what an AI company does with the railways it
// already has, beside opening new ones (ai.ts). ai.ts calls `networkDaily(ai)` once a game day while the company
// has no project running; one task starts at a time (each on its own period, the first runs spread out per
// company) and its work runs in small steps within a few milliseconds a day:
//  - lines: no line is a subset / superset of another (patterns.ts canonicalizeLines: one line, service patterns);
//  - decommission: railways use the saved five-year loss / annual service-cut policy; road routes use their
//    shorter loss horizon. Stations, depots and track nobody uses are taken up after a grace period (what other
//    companies use is kept: their fees pay for it);
//  - capacity: stations needing room (alongside ai.ts, also for other companies' trains), junctions of two operators and
//    hubs of three lines to 3-4 platforms, trains of any company waiting for a platform; a building where its
//    wider catchment pays for it (halt -> building, concourse / terminal in big towns), none at quiet halts;
//  - pair: two own single tracks side by side become one directional double track (pairAsDoubleTrack);
//  - crossovers: double track normalised to =====x==[station]==x===== (normaliseCrossovers, when there);
//  - connect: a terminus whose free end faces another line's track gets a junction and its line runs through to
//    the next station there (X-A-B + Y-A-C networks), when the trips it connects pay for it;
//  - roads: shortcuts between facing streets for road services with costly detours;
//  - join: compatible end-to-end services become a through line when passengers benefit;
//  - insert: a station on a line where the town grew beyond the stations' catchment (planStationOnTrack);
//  - interchange: a station where two lines cross or meet (in town or in open country) purely for transfers,
//    justified by the trips between their stations that routing cannot serve today;
//  - consolidate: two of our termini in one town become one station (rail parts united, or the lines moved to
//    the bigger one over a new junction and the other taken up);
//  - stops: our adjacent bus stops merged, one of ours beside an open-access stop given up for it;
//  - tidy: dead-end stubs of ours taken up (no track or road of ours ends on a bridge);
//  - relevel: a ground station splitting a town centre lifted onto a viaduct (planRelevel, when there);
//  - xlink: another AI company's network beside or across ours (stations or tracks within XLINK_REACH, mutual open
//    access) is linked to ours by a connecting curve where direct services across both pay (each change of vehicle
//    costs 10% of the fares of the leg ending in it and the later legs, and routing charges it): a joint line of ours
//    runs them, the owner earns its fees and is offered mutual through running; walking links where no curve fits;
//  - citylink: two lines' stations a short walk apart in one town (ours, or an agreeing company's: mutual open access)
//    become one interchange: linked for transfers when within walking range, else a stop of ours beside the other
//    line's station, when the trips the change of lines newly allows pay for it (each change costs 10% of the fares).
// Spending follows the company's money rules (available(), borrowing in steps as ai.ts does); land is graded and
// a few town buildings demolished where that gives a better site (cost plus compensation, a small rating hit).
import type { Game } from './game';
import type { AIController } from './ai';
import type { Station, StationPlan, EntranceKind } from './stations';
import type { NEdge, NNode } from './network';
import type { Line } from './lines';
import type { Economy } from './economy';
import type { Proposal, BuildOptions, Snap } from './construction';
import { railModeOf, railPartMode, PLATFORM_LENGTH, defaultPlatformLength, planStationUpgrade, commitStationUpgrade, railCatchShapes, CATCHMENT_RADIUS, ENTRANCE_TYPES, railWidth, entranceSide, TRANSFER_RANGE, railWalkScale, CITY_WALK_SCALE, STATION_UPKEEP_FACTOR } from './stations';
import { defaultStationStyle, styleOf, stylesFor } from './station-styles';
import * as Trackops from './trackops';
import * as StationsMod from './stations';
import * as Patterns from './patterns';
import { autoSignalLine } from './signals';
import { findRailRoute, railNext, platformWaits, depotReaches, lineCongestion, trackAllows, lineCompatibility } from './train';
import type { Train } from './train';
import { linearStops, outAndBack } from './lines';
import { planEdge, commitProposal, findSnap } from './construction';
import { removeEdges, nodeSnap } from './routing';
import { terraformBrush } from './build-ops';
import { BT_TOWER } from './towns';
import { estimateLegTime, estimateLegFare } from './fares';
import { fareFor, refTime, tripFactor } from './fares';
import { TRACK_TYPES, ROAD_TYPES, TRAM, PASSENGER_RATE_SCALE, PASSENGER_FARE_SCALE, UNIT_M } from './constants';
import type { VehicleModel } from './vehicle-types';
import { Network } from './network';
import { findRoadRoute, makeLaneSeg, makeConn } from './roadvehicle';
import type { RoadVehicle, RSeg } from './roadvehicle';
import { tramUsable } from './build-ops';
import { closestOnPolyline } from './geom';
import { YEAR_S, estimateVehicleYear } from './opcosts';
import { TRANSFER_FARE_FACTOR } from './fares';
import { TF_TYPICAL, TRIPS_PER_MONTH, localTripMultiplier } from './demand';
import { TRANSFER_PENALTY_S, PLATFORM_CHANGE_S } from './patterns';
import { recomputeLocks } from './terraform';
import { pickTrain } from './ai';
import { walkingCatchment, entrancePlanCatchment, extraAccessCatchment, pedestrianRoad, walkWeight, coverOf, type WalkingCatchment } from './catchment';
import { distToRect } from './world';

// ============================================================================ optional primitives (feature-detected)

interface PlanLike { ok: boolean; error?: string; cost: number }
interface ConnPlan extends PlanLike { proposal: Proposal | null; turnouts: { edge: number; s: number; x: number; z: number }[] }
interface OnTrackPlanLike extends PlanLike { station: { x: number; z: number; angle: number; length: number } | null }
interface FinishLike { signals: number; crossovers: number; cost: number; error?: string }
/** Track and station operations of trackops.ts / stations.ts this module uses when they are there. */
interface NetOps {
  pairAsDoubleTrack?: (g: Game, a: number[], b: number[], owner: number, opts?: Trackops.FinishOpts) => FinishLike;
  planConnection?: (g: Game, ea: number, sa: number, eb: number, sb: number, owner: number, o?: { search?: number; dirA?: 1 | -1; dirB?: 1 | -1 }) => ConnPlan;
  commitConnection?: (g: Game, plan: ConnPlan, opts?: { signals?: boolean }) => { error: string | null; edges: number[]; signals: number };
  connectStationThroat?: (g: Game, stationId: number, owner: number) => { connected: number; failed: string[] };
  planStationOnTrack?: (g: Game, edgeId: number, s: number, o: Record<string, unknown>, owner: number) => OnTrackPlanLike;
  commitStationOnTrack?: (g: Game, plan: OnTrackPlanLike) => { error: string | null; station: number };
  canMerge?: (g: Game, a: number, b: number) => { ok: boolean; kind: 'rebuild' | 'complex' | null; reason: string };
  mergeStations?: (g: Game, a: number, b: number) => { error: string | null; kind: string | null; station: number };
  normaliseCrossovers?: (g: Game, edgeIds: number[], owner: number) => unknown;
  normalizeCrossovers?: (g: Game, edgeIds: number[], owner: number) => unknown;
  planRelevel?: (g: Game, edgeIds: number[], level: 'elevated' | 'underground' | 'ground', owner: number) => PlanLike;
  commitRelevel?: (g: Game, plan: PlanLike) => unknown;
  mergeStops?: (g: Game, a: number, b: number) => unknown;
}
const OPS: NetOps = { ...(StationsMod as unknown as NetOps), ...(Trackops as unknown as NetOps) };
interface PatternOps {
  canonicalizeLines?: (g: Game, lineId?: number, opts?: { sameOwnerOnly?: boolean }) => { from: number; into: number; text: string }[];
  subsetOf?: (g: Game, l: Line) => Line | null;
  linePatterns?: (l: Line) => { id: number; kind: string; stops: boolean[] }[];
  patternHeadways?: (g: Game, l: Line) => { headway: number; cycle: number; vehicles: number }[];
  canJoinLines?: (g: Game, a: Line | number, b: Line | number) =>
    { ok: false; reason: string } | { ok: true; junction: number; route: number[]; into: number; from: number };
  joinLines?: (g: Game, a: Line | number, b: Line | number, opts?: { notify?: boolean }) =>
    string | { from: number; into: number; line: Line; text: string };
}
const PAT = Patterns as unknown as PatternOps;

/** Error text of a primitive's result (a string, an object with `error`, or null / undefined for success). */
function errorOf(r: unknown): string | null {
  if (r === null || r === undefined || r === true) return null;
  if (typeof r === 'string') return r;
  if (r === false) return 'failed';
  const e = (r as { error?: unknown }).error;
  return typeof e === 'string' && e ? e : null;
}

/** What the AI controller keeps about its lines (ai.ts LineInfo; read, and a line closed here removed). */
interface ManagedLine { kind: string; towns: number[]; depot: number; maxVehicles: number; opened: number; shared?: number; joined?: boolean; urban?: string; double?: boolean; across?: boolean }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ============================================================================ tasks

type Task = 'lines' | 'decommission' | 'capacity' | 'pair' | 'crossovers' | 'connect' | 'midconnect' | 'roads' | 'join' | 'insert' | 'interchange' | 'consolidate' | 'stops' | 'tidy' | 'relevel' | 'xlink' | 'citylink';

/** Tasks in priority order: how often (days) and whether they spend money (then only with money to spare). */
const TASKS: { id: Task; period: number; spend: boolean }[] = [
  { id: 'lines', period: 30, spend: false },
  { id: 'decommission', period: 30, spend: false },
  { id: 'capacity', period: 30, spend: true },
  { id: 'roads', period: 120, spend: true },
  { id: 'join', period: 90, spend: false },
  { id: 'pair', period: 90, spend: true },
  { id: 'tidy', period: 120, spend: false },
  { id: 'connect', period: 120, spend: true },
  { id: 'insert', period: 120, spend: true },
  { id: 'interchange', period: 150, spend: true },
  { id: 'consolidate', period: 120, spend: true },
  { id: 'crossovers', period: 180, spend: false },
  { id: 'stops', period: 180, spend: false },
  { id: 'relevel', period: 360, spend: true },
  { id: 'midconnect', period: 150, spend: true },
  { id: 'xlink', period: 120, spend: true },
  // (last: the others keep their slots and first runs; it spends only on a stop, checked there)
  { id: 'citylink', period: 120, spend: false },
];

/** Fixed work allowance per daily call. Timing is profiling only; load never changes the amount of work. */
export const NETWORK_WORK_UNITS = 4;

/** Spacing of stations along a line by mode (units): no station inserted closer to another one. */
const MIN_SPACING: Record<string, number> = { mainline: Math.max(30, CATCHMENT_RADIUS.rail * 1.1), metro: 18, lightrail: 15 };
/** The AI adds entrances to a station up to this many in all. */
const ENTRANCE_MAX = 6;
/** Candidate entrance places valued (walking catchments) per work unit; the winner is built in the unit after the last. */
const ENTRANCE_VALUATIONS = 4;
/** Residents a new station must newly cover (beyond the other stations' catchment) to be inserted. */
const INSERT_POP: Record<string, number> = { mainline: 650, metro: 900, lightrail: 450 };

/** Counters (in AIController.stats, saved with it): the ones ai.ts declares and this module's own. */
type NetStat = 'grown' | 'merged' | 'paired' | 'connections' | 'stubs' | 'netDecommissioned' | 'netRetired' | 'netInserted' | 'netInterchanges'
  | 'netLinesMerged' | 'netRestyled' | 'netConsolidated' | 'netStopsMerged' | 'netThrough' | 'netMidConnections' | 'netRelevelled' | 'netCrossovers' | 'netGraded' | 'netDemolished' | 'netJoined' | 'netRoads' | 'netRoadUnitsSaved'
  | 'netEntrances' | 'netXLinks' | 'netXServices' | 'netXPartner' | 'netXComplex' | 'netXLoops' | 'netCityLinks' | 'netCityStops';

/** Frame cost of the daily network work over all companies (tests / profiling). */
export const networkProfile = { calls: 0, steps: 0, maxSteps: 0, ms: 0, max: 0, slow: 0, decisions: {} as Record<string, number>,
  tasks: {} as Record<string, { steps: number; ms: number; max: number }> };
/**
 * Settings: the switch (tests: the AI without its network work), trips a month a through connection from a
 * terminus and an interchange station must newly connect, and a factor on the residents an inserted station
 * must newly cover.
 */
// These gates were calibrated at the old passenger rate. Money limits remain in game money.
export const networkOptions = { enabled: true, throughTrips: 25 * PASSENGER_RATE_SCALE, interchangeTrips: 45 * PASSENGER_RATE_SCALE, insertPop: PASSENGER_RATE_SCALE,
  /** trips a month a cross-company direct service must carry (xlink) */
  xlinkTrips: 10 * PASSENGER_RATE_SCALE,
  /** tests and calibration: link the best curve found whatever its economics or the partner's view (as AIController.forceBuild) */
  xlinkForce: false,
  /** trips a month two lines' stations in one town must newly allow to be linked into one interchange (citylink) */
  cityLinkTrips: 2 * PASSENGER_RATE_SCALE };

/** Two companies' lines whose stations or tracks come this close (units) are neighbours a curve may link (xlink). */
export const XLINK_REACH = 30;
/**
 * citylink: two lines whose stations in one town come within this walking gap (units) are offered an interchange: a
 * link when within walking range (Stations.linkRange), else a stop of ours beside the other line's station. Years its
 * revenue has to repay such a stop (as an inserted station's), and how far the stop may lie from that station.
 */
export const CITY_LINK_REACH = 40, CITY_LINK_YEARS = 8, CITY_LINK_GAP = 12;
/**
 * Share of the regional trips between two towns (townTrips, all modes) a direct rail service attracts at a typical
 * trip factor (xlinkValue; as the road shortcuts' estimate): stations' walking catchments cover only part of a town.
 */
const XLINK_CAPTURE = 0.65;
/**
 * On single track a direct train holds the whole stretch from its last stop before the curve to its first stop
 * after it: the curve must lie within this distance (units) of a passing stop on each single-track side, or the
 * train blocks both lines' sections at once (measured: a direct train bypassing both termini halved the partner's
 * single-track service and carried almost nobody).
 */
const XLINK_SPAN = 35;
/** A passing loop laid for a link on a single-track side (units of second track). */
const XLINK_LOOP = 40;
/** Line pairs looked at per xlink job, sites kept per pair after the survey, curves planned per work unit. */
const XLINK_PAIRS = 4, XLINK_SITES = 8, XLINK_PLANS = 2;

/** Closest distance between two straight segments p0-p1 and q0-q1 (0 when they cross). */
function segmentGap(p0: { x: number; z: number }, p1: { x: number; z: number }, q0: { x: number; z: number }, q1: { x: number; z: number }): number {
  const cross = (o: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => (a.x - o.x) * (b.z - o.z) - (a.z - o.z) * (b.x - o.x);
  const d1 = cross(q0, q1, p0), d2 = cross(q0, q1, p1), d3 = cross(p0, p1, q0), d4 = cross(p0, p1, q1);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0;
  const pt = (c: { x: number; z: number }, a: { x: number; z: number }, b: { x: number; z: number }) => {
    const dx = b.x - a.x, dz = b.z - a.z, l2 = dx * dx + dz * dz;
    const t = l2 > 0 ? Math.max(0, Math.min(1, ((c.x - a.x) * dx + (c.z - a.z) * dz) / l2)) : 0;
    return Math.hypot(c.x - a.x - dx * t, c.z - a.z - dz * t);
  };
  return Math.min(pt(p0, q0, q1), pt(p1, q0, q1), pt(q0, p0, p1), pt(q1, p0, p1));
}

const planners = new WeakMap<AIController, NetPlanner>();

interface RoadChoice { ax: number; az: number; bx: number; bz: number; crossing: 'auto' | 'over' | 'under'; cost: number; demolish: boolean }
interface WorkItem {
  ids: number[]; retire?: 'stations' | 'depots' | 'track' | 'all'; road?: { at: number; best?: RoadChoice };
  style?: { at: number; best?: { style: string; gain: number } };
  /** an extra entrance being valued: the next candidate place, and the best so far (its kind, point and value) */
  entrance?: { at: number; best?: { kind: EntranceKind; x: number; z: number; gain: number } };
  /** a cross-company link being planned (xlink): the candidate sites and services valued, the next one, the best */
  xlink?: XLinkCursor;
}
/**
 * A candidate connecting curve between two companies' lines: the turnout points on our track (a) and theirs (b), each
 * with the direction trains travel there (towards the curve on ours, away from it on theirs), the chord, the stations
 * of the direct service (ours up to the curve, theirs from it) and its value (annual, see xlinkValue).
 */
interface XLinkSite { ax: number; az: number; atx: number; atz: number; bx: number; bz: number; btx: number; btz: number; d: number; left: number[]; right: number[]; value: number;
  /** a passing loop is laid beside the junction on our single track (la) / the partner's (lb) */
  la: boolean; lb: boolean }
/** at: 0 survey, 1..sites: the next site to plan, beyond: build; best: the site planned best so far (index, cost, score). */
interface XLinkCursor { at: number; sites?: XLinkSite[]; best?: { site: number; cost: number; score: number } }
interface NetworkJob { task: Task; items: WorkItem[] | null; cursor: number; done: number }
const copyXLink = (x: XLinkCursor): XLinkCursor => ({ ...x,
  ...(x.sites ? { sites: x.sites.map((s) => ({ ...s, left: [...s.left], right: [...s.right] })) } : {}),
  ...(x.best ? { best: { ...x.best } } : {}) });
const copyWorkItem = (i: WorkItem): WorkItem => ({ ...i, ids: [...i.ids],
  ...(i.xlink ? { xlink: copyXLink(i.xlink) } : {}),
  ...(i.style ? { style: { ...i.style, ...(i.style.best ? { best: { ...i.style.best } } : {}) } } : {}),
  ...(i.entrance ? { entrance: { ...i.entrance, ...(i.entrance.best ? { best: { ...i.entrance.best } } : {}) } } : {}),
  ...(i.road ? { road: { ...i.road, ...(i.road.best ? { best: { ...i.road.best } } : {}) } } : {}) });

/** Durable deadlines and candidate cursors. Geometry and routes never survive a work unit. */
export interface NetworkPlannerState {
  next: [Task, number][];
  care: [string, number][];
  sizes: [number, { key: string; day: number }][];
  retire: [string, number][];
  /** This cache has a game-day expiry; keeping its exact doubles avoids changing a pending value estimate. */
  demand?: { day: number; nt: number; P: number[] } | null;
  job?: NetworkJob | null;
  scans?: [string, number][];
}
interface NetworkSave {
  version: 1; companies: [number, NetworkPlannerState][];
  /** Construction can buy several trains with one mutable consist array. A terminus reverses that array;
   * preserve its identity groups as well as its saved contents, without changing the vehicle/save modules. */
  sharedConsists?: number[][];
  /** JSON drops unset optional fields. Retain their slots in AI line metadata so later assignments have
   * the same property order in the original and loaded controller's serialized state. */
  lineFields?: [number, [number, string[]][]][];
  /** Pending building upgrades can fill previously unset forecourt fields. Preserve their property slots too. */
  stationFields?: [number, string[]][];
  /** Busy station upgrades hold approaches for a fixed number of simulation days. */
  stationWorks?: ReturnType<Game['stations']['saveWorks']>;
  /** Vehicles may still occupy a lane/connector made before a junction changed. Save only shapes
   * which cannot be rebuilt from today's network; replacing them early changes the next tick. */
  roadShapes?: { id: number; ambient: boolean; refs: (RoadRef | null)[]; trail: number; shapes: [number, RoadShape][] }[];
}

type RoadRef = [number, number, number, number, number, number, number | null];
interface RoadShape {
  pts: number[]; cum: number[]; curveLen: number; radius: number | null;
  len: number; limit: number; tunnels: RSeg['tunnels']; crossings: RSeg['crossings'];
  depot?: boolean; slow?: RSeg['slow'];
}
const roadRef = (s: RSeg): RoadRef => [s.kind === 'lane' ? 0 : 1, s.e, s.dir, s.node, s.from, s.fromDir, s.stopAt ?? null];
function roadFromRef(g: Game, r: RoadRef): RSeg | null {
  const net = g.world.net, e = net.edges.get(r[1]);
  if (!e) return null;
  const lane = makeLaneSeg(g, e, r[2]);
  if (r[0] === 0) { if (r[6] !== null) lane.stopAt = r[6]; return lane; }
  const from = net.edges.get(r[4]);
  return from ? makeConn(makeLaneSeg(g, from, r[5]), lane, r[3]) ?? lane : null;
}
function sameRoadShape(a: RSeg, b: RSeg | null): boolean {
  if (!b || a.kind !== b.kind || a.len !== b.len || a.limit !== b.limit || a.curve.len !== b.curve.len
    || a.curve.minRadius !== b.curve.minRadius) return false;
  if (a.curve !== b.curve) for (const key of ['pts', 'cum'] as const) {
    const x = a.curve[key], y = b.curve[key];
    if (x.length !== y.length || x.some((v, i) => v !== y[i])) return false;
  }
  return JSON.stringify([a.tunnels, a.crossings, a.depot, a.slow]) === JSON.stringify([b.tunnels, b.crossings, b.depot, b.slow]);
}
function saveRoadShapes(g: Game): NonNullable<NetworkSave['roadShapes']> {
  const result: NonNullable<NetworkSave['roadShapes']> = [], fresh = new Map<string, RSeg | null>();
  const vehicles = [...g.vehicles.map.values()].filter((v): v is RoadVehicle => v.kind === 'road').concat(g.vehicles.ambient);
  for (const v of vehicles) {
    const segments = [v.seg, ...v.trail, ...v.ahead], shapes: [number, RoadShape][] = [];
    for (let i = 0; i < segments.length; i++) {
      const s = segments[i]; if (!s) continue;
      const r = roadRef(s), key = r.slice(0, 6).join(',');
      if (!fresh.has(key)) fresh.set(key, roadFromRef(g, r));
      if (sameRoadShape(s, fresh.get(key)!)) continue;
      shapes.push([i, { pts: [...s.curve.pts], cum: [...s.curve.cum], curveLen: s.curve.len,
        radius: Number.isFinite(s.curve.minRadius) ? s.curve.minRadius : null, len: s.len, limit: s.limit,
        tunnels: s.tunnels.map(([a, b]) => [a, b]), crossings: s.crossings.map((c) => ({ ...c })),
        ...(s.depot !== undefined ? { depot: s.depot } : {}), ...(s.slow ? { slow: s.slow.map(([a, b, c]) => [a, b, c]) } : {}) }]);
    }
    if (shapes.length) result.push({ id: v.id, ambient: v.ambient, refs: segments.map((s) => s ? roadRef(s) : null), trail: v.trail.length, shapes });
  }
  return result;
}
function loadRoadShapes(g: Game, records: NonNullable<NetworkSave['roadShapes']>): void {
  for (const record of records) {
    const v = (record.ambient ? g.vehicles.ambient.find((v) => v.id === record.id) : g.vehicles.get(record.id)) as RoadVehicle | undefined;
    if (v?.kind !== 'road') continue;
    const shapes = new Map(record.shapes);
    const segments = record.refs.map((r, i): RSeg | null => {
      if (!r) return null;
      const s = shapes.get(i);
      if (!s) return roadFromRef(g, r);
      return { kind: r[0] === 0 ? 'lane' : 'conn', e: r[1], dir: r[2], node: r[3], from: r[4], fromDir: r[5],
        curve: { pts: new Float32Array(s.pts), cum: new Float32Array(s.cum), len: s.curveLen, minRadius: s.radius ?? Infinity },
        len: s.len, limit: s.limit, tunnels: s.tunnels.map(([a, b]) => [a, b]), crossings: s.crossings.map((c) => ({ ...c })),
        ...(r[6] !== null ? { stopAt: r[6] } : {}), ...(s.depot !== undefined ? { depot: s.depot } : {}),
        ...(s.slow ? { slow: s.slow.map(([a, b, c]) => [a, b, c]) } : {}) };
    });
    v.seg = segments[0];
    v.trail = segments.slice(1, record.trail + 1).filter((s): s is RSeg => !!s);
    v.ahead = segments.slice(record.trail + 1).filter((s): s is RSeg => !!s);
  }
}

/** The save hook deliberately does not create planners for companies which have never done network work. */
export function saveNetwork(g: Game): NetworkSave {
  const companies: NetworkSave['companies'] = [];
  for (const ai of g.ais) { const p = planners.get(ai); if (p) companies.push([ai.companyId, p.save()]); }
  companies.sort((a, b) => a[0] - b[0]);
  const consists = new Map<Train['cars'], number[]>();
  for (const v of g.vehicles.map.values()) if (v.kind === 'train') {
    const cars = (v as Train).cars, group = consists.get(cars) ?? [];
    group.push(v.id); consists.set(cars, group);
  }
  const sharedConsists = [...consists.values()].filter((ids) => ids.length > 1).map((ids) => ids.sort((a, b) => a - b)).sort((a, b) => a[0] - b[0]);
  const lineFields: NonNullable<NetworkSave['lineFields']> = [];
  for (const ai of g.ais) {
    const fields: [number, string[]][] = [];
    const lines = (ai as unknown as { lines?: Map<number, ManagedLine> }).lines;
    for (const [id, info] of lines ?? []) {
      const record = info as unknown as Record<string, unknown>, keys = Object.keys(record);
      if (keys.some((key) => record[key] === undefined)) fields.push([id, keys]);
    }
    if (fields.length) lineFields.push([ai.companyId, fields.sort((a, b) => a[0] - b[0])]);
  }
  lineFields.sort((a, b) => a[0] - b[0]);
  const stationFields: NonNullable<NetworkSave['stationFields']> = [];
  for (const st of g.stations.map.values()) if (st.rail) {
    const record = st.rail as unknown as Record<string, unknown>, keys = Object.keys(record);
    if (keys.some((key) => record[key] === undefined)) stationFields.push([st.id, keys]);
  }
  stationFields.sort((a, b) => a[0] - b[0]);
  const roadShapes = saveRoadShapes(g);
  const stationWorks = g.stations.saveWorks();
  return { version: 1, companies, ...(sharedConsists.length ? { sharedConsists } : {}), ...(lineFields.length ? { lineFields } : {}),
    ...(stationFields.length ? { stationFields } : {}),
    ...(stationWorks.length ? { stationWorks } : {}),
    ...(roadShapes.length ? { roadShapes } : {}) };
}

/** Old saves have no aiNetwork field and keep the initial, company-staggered schedule. */
export function loadNetwork(g: Game, data?: NetworkSave): void {
  if (data?.version !== 1 || !Array.isArray(data.companies)) return;
  if (data.stationWorks) g.stations.loadWorks(data.stationWorks);
  for (const [sid, keys] of data.stationFields ?? []) {
    const st = g.stations.get(sid), r = st?.rail;
    if (st && r) {
      const record = r as unknown as Record<string, unknown>;
      st.rail = Object.fromEntries(keys.map((key) => [key, record[key]])) as unknown as NonNullable<Station['rail']>;
    }
  }
  // Road-change detection compares warm walking entries with later street edits. Rebuild those derived
  // entries now, so a loaded AI world notices the same next edit as the original (no populations changed).
  if (g.ais.length) for (const st of g.stations.map.values()) walkingCatchment(g, st);
  loadRoadShapes(g, data.roadShapes ?? []);
  for (const ids of data.sharedConsists ?? []) {
    const first = g.vehicles.get(ids[0]) as Train | undefined;
    if (first?.kind !== 'train') continue;
    for (const id of ids.slice(1)) {
      const v = g.vehicles.get(id) as Train | undefined;
      if (v?.kind === 'train' && v.cars.map((c) => c.id).join(',') === first.cars.map((c) => c.id).join(',')) v.cars = first.cars;
    }
  }
  for (const [owner, fields] of data.lineFields ?? []) {
    const ai = g.ais.find((a) => a.companyId === owner);
    const lines = (ai as unknown as { lines?: Map<number, ManagedLine> } | undefined)?.lines;
    for (const [id, keys] of fields) {
      const info = lines?.get(id);
      if (!info) continue;
      const record = info as unknown as Record<string, unknown>;
      lines!.set(id, { ...Object.fromEntries(keys.map((key) => [key, record[key]])), ...info } as unknown as ManagedLine);
    }
  }
  for (const [id, state] of data.companies) {
    const ai = g.ais.find((a) => a.companyId === id);
    if (!ai) continue;
    const p = new NetPlanner(ai);
    p.load(state);
    planners.set(ai, p);
  }
}

/**
 * The AI controller's daily hook (ai.ts daily(), while no project runs): a network task's next steps within
 * a few milliseconds. Never throws.
 */
export function networkDaily(ai: AIController): void {
  if (ai.disposed || !networkOptions.enabled) return;
  let p = planners.get(ai);
  if (!p) { p = new NetPlanner(ai); planners.set(ai, p); }
  p.daily();
}

/** Bring a network task forward (ai.ts: a new line beside another company's network): never later than it was planned. */
export function scheduleNetworkTask(ai: AIController, task: string, inDays: number): void {
  if (ai.disposed || !TASKS.some((t) => t.id === task)) return;
  let p = planners.get(ai);
  if (!p) { p = new NetPlanner(ai); planners.set(ai, p); }
  p.soon(task as Task, inDays);
}

/** The planner of a company (tests): its current task and per-company frame cost. */
export function networkPlanner(ai: AIController): { task: string | null; prof: { calls: number; ms: number; max: number } } | null {
  const p = planners.get(ai);
  return p ? { task: p.task, prof: p.prof } : null;
}

/** Start a task now (tests); false while another task runs. */
export function runNetworkTask(ai: AIController, task: Task, steps = 100000): boolean {
  let p = planners.get(ai);
  if (!p) { p = new NetPlanner(ai); planners.set(ai, p); }
  if (p.job) return false;
  p.start(task);
  for (let i = 0; i < steps && p.job; i++) p.work();
  return true;
}

// ============================================================================ shared geometry helpers (also used by tests)

/** The best route (edge ids, the target's platform edge last) from station a's platforms to station b, or null. */
export function routeBetween(g: Game, a: number, b: number, owner: number, maxExpand = 15000): number[] | null {
  const net = g.world.net;
  const sa = g.stations.get(a), sb = g.stations.get(b);
  if (!sa?.rail || !sb?.rail || a === b) return null;
  let best: { ids: number[]; cost: number } | null = null;
  for (const eid of sa.rail.edges) {
    const e = net.edges.get(eid);
    if (!e) continue;
    for (const d of [1, -1]) {
      const r = findRailRoute(g, railNext(g, e, d, owner), b, owner, -1, maxExpand);
      if (r && (!best || r.cost < best.cost)) best = { ids: r.conts.map((c) => c.edge.id), cost: r.cost };
    }
  }
  return best ? best.ids : null;
}

export interface RoadHop { length: number; seconds: number; edges: number[] }
/** Stop-to-stop lane distance, including junction curves and partial stop edges, using the vehicle's router. */
export function roadRouteBetween(g: Game, a: number, b: number, owner: number, tram = false, kmh = 90, loop = false): RoadHop | null {
  const net = g.world.net, A = g.stations.get(a), B = g.stations.get(b);
  if (!A?.stops.length || !B?.stops.length || a === b) return null;
  const allow = (e: NEdge) => e.kind === 'road' && (!tram || tramUsable(g, e, owner));
  const pos = (s: RSeg, st: Station): number => {
    let at = -1;
    for (const p of st.stops) if (p.edge === s.e) {
      const q = closestOnPolyline(p.x, p.z, s.curve.pts, 3, s.curve.cum.length);
      const v = s.curve.cum[q.i] + (s.curve.cum[Math.min(q.i + 1, s.curve.cum.length - 1)] - s.curve.cum[q.i]) * q.f;
      if (at < 0 || v < at) at = v;
    }
    return at;
  };
  const time = (s: RSeg, from: number, to: number) => {
    const cap = Math.min(s.limit, Math.max(8, kmh) / 36);
    let t = Math.max(0, to - from) / cap;
    for (const [x, y, v] of s.slow ?? []) t += Math.max(0, Math.min(to, y) - Math.max(from, x)) * (1 / Math.min(cap, v) - 1 / cap);
    return t;
  };
  let best: RoadHop | null = null;
  const seen = new Set<number>();
  for (const p of A.stops) {
    if (seen.has(p.edge)) continue;
    seen.add(p.edge);
    const e = net.edges.get(p.edge);
    if (!e || !allow(e)) continue;
    for (const dir of [1, -1]) {
      let lane = makeLaneSeg(g, e, dir), start = pos(lane, A), end = pos(lane, B);
      if (start < 0) continue;
      let length = 0, seconds = 0;
      const edges = [e.id];
      if (end > start + 0.15) { length = end - start; seconds = time(lane, start, end); }
      else {
        const r = findRoadRoute(g, e, dir, b, 15000, allow, loop ? 600 : 40);
        if (!r) continue;
        length = lane.len - start; seconds = time(lane, start, lane.len);
        let prev = e;
        for (const c of r) {
          const next = net.edges.get(c.edge)!;
          const seg = makeLaneSeg(g, next, c.dir), conn = makeConn(lane, seg, lane.dir > 0 ? prev.b : prev.a);
          if (conn) { length += conn.len; seconds += time(conn, 0, conn.len); }
          end = pos(seg, B);
          const len = end >= 0 ? end : seg.len;
          length += len; seconds += time(seg, 0, len); edges.push(next.id);
          lane = seg; prev = next;
          if (end >= 0) break;
        }
      }
      if (!best || seconds < best.seconds) best = { length, seconds, edges };
    }
  }
  return best;
}

interface RoadService {
  line: Line; vehicles: RoadVehicle[];
  legs: { a: number; b: number; before: RoadHop }[];
  cycle: number; kmh: number;
}

/** Is rail edge `e` a crossover leg: a short link between two parallel tracks, branching off each of them? */
function crossoverLeg(g: Game, e: NEdge): { a: NNode; b: NNode; ta: NEdge[]; tb: NEdge[] } | null {
  const net = g.world.net;
  if (e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || e.len > 16) return null;
  const na = net.nodes.get(e.a), nb = net.nodes.get(e.b);
  if (!na || !nb || na.edges.length !== 3 || nb.edges.length !== 3) return null;
  const through = (n: NNode): NEdge[] | null => {
    const o = n.edges.filter((id) => id !== e.id).map((id) => net.edges.get(id)).filter((x): x is NEdge => !!x && x.kind === 'rail');
    if (o.length !== 2) return null;
    const d0 = net.leaveDir(o[0], n.id), d1 = net.leaveDir(o[1], n.id);
    return d0.x * d1.x + d0.z * d1.z < -0.95 ? o : null;
  };
  const ta = through(na), tb = through(nb);
  if (!ta || !tb || ta.some((x) => tb.includes(x))) return null;
  const dl = Math.hypot(na.dx, na.dz) || 1, dx = na.dx / dl, dz = na.dz / dl;
  const lat = Math.abs((nb.x - na.x) * dz - (nb.z - na.z) * dx);
  if (lat < 0.25 || lat > 1.8 || Math.abs(dx * nb.dx + dz * nb.dz) / (Math.hypot(nb.dx, nb.dz) || 1) < 0.97) return null;
  return { a: na, b: nb, ta, tb };
}

/** Is there a rail track (not `skip`) running beside point (x, z) heading (tx, tz), 0.25-1.8 units off? */
function trackBeside(g: Game, x: number, z: number, tx: number, tz: number, skip: Set<number>): boolean {
  const net = g.world.net, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  for (const e of net.edgesNear(x - 2, z - 2, x + 2, z + 2)) {
    if (e.kind !== 'rail' || skip.has(e.id)) continue;
    const ne = net.nearestEdge(x, z, 1.9, 'rail', (q) => q.id === e.id);
    if (!ne || ne.d < 0.25 || ne.d > 1.8) continue;
    net.pointAt(e, ne.s, p, d);
    const l = Math.hypot(d.x, d.z) || 1;
    if (Math.abs((d.x * tx + d.z * tz) / l) > 0.95) return true;
  }
  return false;
}

/** Point `dist` units on along the track from node n (leaving on edge e), the straightest way; with its direction. */
function pointOn(g: Game, n: NNode, e: NEdge, dist: number): { x: number; z: number; tx: number; tz: number; edges: number[] } | null {
  const net = g.world.net, p = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 };
  let cur = e, at = n.id, acc = 0;
  const edges: number[] = [];
  for (let k = 0; k < 30; k++) {
    edges.push(cur.id);
    const fromA = cur.a === at;
    if (acc + cur.len >= dist) {
      const s = fromA ? dist - acc : cur.len - (dist - acc);
      net.pointAt(cur, s, p, t);
      const l = Math.hypot(t.x, t.z) || 1, sg = fromA ? 1 : -1;
      return { x: p.x, z: p.z, tx: (t.x / l) * sg, tz: (t.z / l) * sg, edges };
    }
    acc += cur.len;
    const dir = fromA ? 1 : -1;
    const conts = net.nextRail(cur, dir);
    if (!conts.length) return null;
    const geo = net.geo(cur), i = dir > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * dir, tz = geo.tan[i * 2 + 1] * dir;
    let best = conts[0], bd = -Infinity;
    for (const c of conts) { const ld = net.leaveDir(c.edge, c.node.id), dot = ld.x * tx + ld.z * tz; if (dot > bd) { bd = dot; best = c; } }
    at = best.node.id;
    cur = best.edge;
  }
  return null;
}

/**
 * Crossovers on plain line between stations (UPDATE 9k: crossovers belong right outside the stations, at
 * junctions and depot access): legs between two parallel tracks with no station or depot within 40 units, no
 * other junction within 30, and the double track going on at least 30 units both ways. `owner`: only that
 * company's track.
 */
export function midLineCrossovers(g: Game, owner?: number): { edge: number; x: number; z: number; owner: number }[] {
  const net = g.world.net, out: { edge: number; x: number; z: number; owner: number }[] = [];
  const stations = [...g.stations.map.values()].filter((s) => s.rail);
  const depots = [...g.depots.map.values()].filter((d) => d.kind === 'rail');
  for (const e of net.edges.values()) {
    if (owner !== undefined && e.owner !== owner) continue;
    const leg = crossoverLeg(g, e);
    if (!leg) continue;
    const mx = (leg.a.x + leg.b.x) / 2, mz = (leg.a.z + leg.b.z) / 2;
    if (stations.some((s) => Math.hypot(s.rail!.x - mx, s.rail!.z - mz) < 40 + s.rail!.length / 2)) continue;
    if (depots.some((d) => Math.hypot(d.x - mx, d.z - mz) < 30)) continue;
    // other junctions near (a branch, not another crossover leg): a junction's crossovers
    let junction = false;
    for (const id of net.nodeGrid.query(mx - 30, mz - 30, mx + 30, mz + 30)) {
      const n = net.nodes.get(id);
      if (!n || n.kind !== 'rail' || n.edges.length < 3 || n === leg.a || n === leg.b || Math.hypot(n.x - mx, n.z - mz) > 30) continue;
      if (n.edges.length > 3 || !n.edges.some((x) => { const q = net.edges.get(x); return !!q && !!crossoverLeg(g, q); })) { junction = true; break; }
    }
    if (junction) continue;
    // the double track goes on both ways (not where two lines' paired tracks part)
    const skip = new Set<number>([e.id]);
    let goesOn = true;
    for (const t of leg.ta) {
      const q = pointOn(g, leg.a, t, 30);
      if (!q) { goesOn = false; break; }
      for (const id of q.edges) skip.add(id);
      if (!trackBeside(g, q.x, q.z, q.tx, q.tz, skip)) { goesOn = false; break; }
    }
    if (!goesOn) continue;
    out.push({ edge: e.id, x: mx, z: mz, owner: e.owner });
  }
  return out;
}

/** Pairs of lines where one's stops are a subset of the other's route (UPDATE 9k: should be 0). */
export function subsetLinePairs(g: Game): [number, number][] {
  if (!PAT.subsetOf) return [];
  const out: [number, number][] = [];
  for (const l of g.lines.map.values()) { const s = PAT.subsetOf(g, l); if (s && s.id !== l.id) out.push([l.id, s.id]); }
  return out;
}

// ============================================================================ the planner

class NetPlanner {
  readonly g: Game;
  readonly me: number;
  job: NetworkJob | null = null;
  get task(): Task | null { return this.job?.task ?? null; }
  private scans = new Map<string, number>();
  /** day each task may run next */
  private next = new Map<Task, number>();
  /** per-object cool-down: key -> day it may be looked at again */
  private care = new Map<string, number>();
  /** station sizes seen (tracks / through / length / style) and the day they last changed */
  private sizes = new Map<number, { key: string; day: number }>();
  /** things of ours nobody uses: key -> day they may be taken up */
  private retire = new Map<string, number>();
  private dem: { day: number; nt: number; P: Float64Array } | null = null;
  private errLogged = false;
  prof = { calls: 0, ms: 0, max: 0 };

  constructor(public ai: AIController) {
    this.g = ai.game;
    this.me = ai.companyId;
    // first looks spread over the first months, differently per company
    TASKS.forEach((t, i) => this.next.set(t.id, this.g.day + 15 + ((this.me * 17 + i * 23) % Math.max(30, Math.min(120, t.period)))));
  }

  save(): NetworkPlannerState {
    const strings = (a: [string, unknown], b: [string, unknown]) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0;
    return {
      next: [...this.next].sort(strings), care: [...this.care].sort(strings),
      sizes: [...this.sizes].sort((a, b) => a[0] - b[0]).map(([id, s]) => [id, { ...s }]),
      retire: [...this.retire].sort(strings),
      demand: this.dem ? { day: this.dem.day, nt: this.dem.nt, P: Array.from(this.dem.P) } : null,
      job: this.job ? { ...this.job, items: this.job.items?.map(copyWorkItem) ?? null } : null,
      scans: [...this.scans].sort(strings),
    };
  }

  load(s: NetworkPlannerState): void {
    if (Array.isArray(s.next)) for (const [id, day] of s.next) if (TASKS.some((t) => t.id === id) && Number.isFinite(day)) this.next.set(id, day);
    if (Array.isArray(s.care)) this.care = new Map(s.care.map(([k, d]) => [k, d]));
    if (Array.isArray(s.sizes)) this.sizes = new Map(s.sizes.map(([id, v]) => [id, { ...v }]));
    if (Array.isArray(s.retire)) this.retire = new Map(s.retire.map(([k, d]) => [k, d]));
    if (s.demand && Array.isArray(s.demand.P) && s.demand.P.length === s.demand.nt * s.demand.nt) this.dem = { ...s.demand, P: new Float64Array(s.demand.P) };
    if (Array.isArray(s.scans)) this.scans = new Map(s.scans);
    if (s.job && TASKS.some((t) => t.id === s.job!.task)) this.job = { ...s.job, items: s.job.items?.map(copyWorkItem) ?? null };
  }

  private get eco(): Economy { return this.g.company(this.me).economy; }
  private get name(): string { return this.g.company(this.me).name; }
  private managed(): Map<number, ManagedLine> | null { return (this.ai as unknown as { lines?: Map<number, ManagedLine> }).lines ?? null; }

  daily() {
    const t0 = now();
    let units = 0;
    try {
      const g = this.g;
      for (const [key, day] of this.care) if (day <= g.day) this.care.delete(key);
      if (!this.job) {
        const t = TASKS.find((x) => (this.next.get(x.id) ?? 0) <= g.day && (x.id !== 'midconnect' || this.midLines().length >= 2)
          && (x.id !== 'xlink' || this.xlinkPartners()));
        if (!t) return;
        this.next.set(t.id, g.day + t.period + ((this.me * 7 + g.day) % 13));
        this.considered(t.id + '.scheduled');
        if (t.spend && !this.mayBuild()) { this.considered(t.id + '.funds'); return; }
        this.start(t.id);
      }
      while (this.job && units < NETWORK_WORK_UNITS) {
        const t1 = now(), task = this.task ?? '?', prepared = !!this.job.items;
        this.work();
        units++;
        const dt = now() - t1, tp = (networkProfile.tasks[task] ??= { steps: 0, ms: 0, max: 0 });
        tp.steps++; tp.ms += dt; tp.max = Math.max(tp.max, dt);
        if (!this.job) break;
        // Expensive proposal work gets one prepared item per day; timing never changes that allowance.
        if (['roads', 'capacity', 'midconnect', 'xlink'].includes(task) && prepared) break;
      }
    } catch (e) {
      this.note(`network work (${this.task}) failed: ${String((e as Error)?.message ?? e)}`);
      if (!this.errLogged) { this.errLogged = true; console.warn(`AI network ${this.name}:`, e); }
      this.job = null;
    } finally {
      // ai.ts freezes network work during construction. Finish this bounded job before starting a project.
      if (this.job) this.ai.state.cooldown = Math.max(1, this.ai.state.cooldown);
      const dt = now() - t0;
      this.prof.calls++; this.prof.ms += dt; this.prof.max = Math.max(this.prof.max, dt);
      networkProfile.calls++; networkProfile.ms += dt; networkProfile.max = Math.max(networkProfile.max, dt);
      networkProfile.steps += units; networkProfile.maxSteps = Math.max(networkProfile.maxSteps, units);
      if (dt > 15) networkProfile.slow++;
    }
  }

  start(task: Task): void { this.job = { task, items: null, cursor: 0, done: 0 }; }

  /** The task's next run within `days` (or sooner, as planned). */
  soon(task: Task, days: number): void { this.next.set(task, Math.min(this.next.get(task) ?? Infinity, this.g.day + days)); }

  /** A local generator is fully drained in this call. No references or generator frames cross a tick. */
  private drain<T>(gen: Generator<void, T>): T {
    let r = gen.next();
    while (!r.done) r = gen.next();
    return r.value;
  }

  /** Bounded, rotating inventories keep large networks fair without saving geometry or whole scans. */
  private inventory(key: string, ids: number[], batch = 8, limit = 64): WorkItem[] {
    ids.sort((a, b) => a - b);
    if (!ids.length) return [];
    const at = (this.scans.get(key) ?? 0) % ids.length, n = Math.min(limit, ids.length);
    const selected = Array.from({ length: n }, (_, i) => ids[(at + i) % ids.length]);
    this.scans.set(key, (at + n) % ids.length);
    const out: WorkItem[] = [];
    for (let i = 0; i < n; i += batch) out.push({ ids: selected.slice(i, i + batch) });
    return out;
  }

  private prepare(task: Task): WorkItem[] {
    const g = this.g, me = this.me;
    const ownLines = g.lines.all().filter((l) => l.owner === me);
    const ownStations = g.stations.all().filter((s) => s.owner === me);
    switch (task) {
      case 'pair': return this.drain(this.sideBySide()).slice(0, 8).map((c) => ({ ids: [c.a, c.b, c.len] }));
      case 'roads': {
        const lines = g.lines.all().filter((l) => l.kind !== 'rail' && this.fleet(l).ours.length);
        const selected = this.inventory('roadServices', lines.map((l) => l.id), 1, 1).flatMap((i) => i.ids);
        return this.roadCandidates(this.drain(this.roadServices(undefined, selected))).slice(0, 2)
          .map((c) => ({ ids: [c.a, c.b, Number(c.tram)] }));
      }
      case 'join': {
        // Index only authorised termini. Unrelated companies' pairs consume no work units.
        const ends = new Map<string, number[]>(), pairs = new Map<string, WorkItem>();
        for (const l of g.lines.all()) {
          const path = this.pathOf(l);
          if (!path || !l.vehicles.length || !this.joinAllowed(l)) continue;
          for (const sid of [path[0], path[path.length - 1]]) {
            const key = `${l.kind}:${sid}`, list = ends.get(key) ?? [];
            for (const id of list) {
              const a = g.lines.get(id)!;
              if (!this.fleet(a).ours.length && !this.fleet(l).ours.length) continue;
              const ids = [id, l.id].sort((a, b) => a - b), pair = `join${ids[0]}:${ids[1]}`;
              if (!this.cared(pair)) pairs.set(pair, { ids });
            }
            list.push(l.id); ends.set(key, list);
          }
        }
        const candidates = [...pairs.values()];
        const indexes = this.inventory(task, candidates.map((_, i) => i), 1, 8);
        return indexes.map((i) => candidates[i.ids[0]]);
      }
      case 'midconnect': {
        const lines = this.midLines();
        const pairs: WorkItem[] = [];
        for (const a of lines) for (const b of lines) {
          if (a.id >= b.id || a.owner !== me && b.owner !== me || this.cared(`mid${a.id}:${b.id}`)) continue;
          pairs.push({ ids: [a.id, b.id] });
        }
        return this.inventory(task, pairs.map((_, i) => i), 1, 8).map((i) => pairs[i.ids[0]]);
      }
      case 'xlink': {
        const pairs = this.xlinkPairs();
        return this.inventory(task, pairs.map((_, i) => i), 1, XLINK_PAIRS).map((i) => pairs[i.ids[0]]);
      }
      case 'citylink': {
        const pairs = this.cityLinkPairs();
        return this.inventory(task, pairs.map((_, i) => i), 1, 6).map((i) => pairs[i.ids[0]]);
      }
      case 'decommission': {
        const ids = this.inventory(task, ownLines.map((l) => l.id)).flatMap((i) => i.ids)
          .sort((a, b) => this.ai.railPolicy.lossOrder(a, b));
        const items: WorkItem[] = [];
        for (let i = 0; i < ids.length; i += 8) items.push({ ids: ids.slice(i, i + 8) });
        return [...items, { ids: [], retire: 'all' }];
      }
      case 'lines': case 'crossovers': return this.inventory(task, ownLines.map((l) => l.id));
      case 'insert': case 'interchange': return this.inventory(task, ownLines.filter((l) => l.kind === 'rail' && this.fleet(l).ours.length).map((l) => l.id), 1, 8);
      case 'capacity': return this.inventory(task, ownStations.filter((s) => s.rail).map((s) => s.id), 1, 32);
      case 'connect': case 'consolidate': case 'relevel': return this.inventory(task, ownStations.filter((s) => s.rail).map((s) => s.id), 1, 8);
      case 'stops': return this.inventory(task, ownStations.filter((s) => !s.rail && s.stops.length).map((s) => s.id));
      case 'tidy': return this.inventory(task, [...g.world.net.nodes.values()].filter((n) => n.edges.length === 1 && g.world.net.edges.get(n.edges[0])?.owner === me).map((n) => n.id));
    }
  }

  work(): void {
    const job = this.job;
    if (!job) return;
    if (!job.items) job.items = this.prepare(job.task);
    else {
      const item = job.items[job.cursor];
      if (item) this.drain(this.run(job.task, item));
      if (!item?.road && !item?.style && !item?.entrance && !item?.xlink) job.cursor++;
    }
    const limit = job.task === 'pair' ? 2 : ['roads', 'join', 'connect', 'midconnect', 'insert', 'interchange', 'relevel', 'xlink', 'citylink'].includes(job.task) ? 1 : Infinity;
    if (job.cursor >= job.items.length || job.done >= limit) this.job = null;
  }

  private selected<T extends { id: number }>(values: Iterable<T>, ids: number[]): T[] {
    // Preserve the saved candidate order, even if another company's work has changed map insertion order.
    const map = new Map([...values].map((v) => [v.id, v]));
    return ids.map((id) => map.get(id)).filter((v): v is T => !!v);
  }

  run(task: Task, item: WorkItem): Generator<void, void> {
    const ids = item.ids;
    switch (task) {
      case 'lines': return this.linesTask(ids);
      case 'decommission': return item.retire ? this.retireUnused(item) : this.decommissionTask(ids);
      case 'capacity': return this.capacityTask(item);
      case 'pair': return this.pairTask(ids);
      case 'crossovers': return this.crossoversTask(ids);
      case 'connect': return this.connectTask(ids);
      case 'midconnect': return this.midconnectTask(ids);
      case 'roads': return this.roadsTask(item);
      case 'join': return this.joinTask(ids);
      case 'insert': return this.insertTask(ids);
      case 'interchange': return this.interchangeTask(ids);
      case 'consolidate': return this.consolidateTask(ids);
      case 'stops': return this.stopsTask(ids);
      case 'tidy': return this.tidyTask(ids);
      case 'relevel': return this.relevelTask(ids);
      case 'xlink': return this.xlinkTask(item);
      case 'citylink': return this.cityLinkTask(ids);
    }
  }

  // ---------------------------------------------------------------- small helpers
  private note(s: string) {
    const log = this.ai.log;
    log.push(`${this.g.dateString()}: ${s}`);
    if (log.length > 40) log.shift();
  }
  private bump(k: NetStat, n = 1) {
    const s = this.ai.stats as unknown as Record<string, number>; s[k] = (s[k] ?? 0) + n;
    const success: Partial<Record<Task, NetStat>> = { capacity: 'grown', roads: 'netRoads', join: 'netJoined', pair: 'paired', connect: 'netThrough', midconnect: 'netMidConnections', insert: 'netInserted', interchange: 'netInterchanges', relevel: 'netRelevelled', xlink: 'netXLinks', citylink: 'netCityLinks' };
    if (this.job && success[this.job.task] === k) this.job.done += n;
  }
  private considered(k: string) { networkProfile.decisions[k] = (networkProfile.decisions[k] ?? 0) + 1; }
  private news(text: string, x?: number, z?: number) { this.g.postNews(`${this.name} ${text}`, 'ai', x, z); }
  private cared(key: string): boolean { return (this.care.get(key) ?? -1) > this.g.day; }
  private careFor(key: string, days: number) { this.care.set(key, this.g.day + days); }

  /** Improvements use the same debt ceiling as mayBuild. available() reserves credit for opening whole
   * new lines at the lower appetite, which otherwise bars even small repairs once that appetite is used. */
  private networkBudget(): number {
    const e = this.eco;
    return this.ai.available() + Math.max(0, e.maxLoan * Math.min(0.97, this.ai.loanAppetite + 0.2) - e.loan)
      - Math.max(0, e.maxLoan * this.ai.loanAppetite - e.loan);
  }

  /** May the company spend on its network now? (its money rules: cash plus credit, loan and losses in bounds) */
  private mayBuild(): boolean {
    const why = this.buildBar();
    if (why && why !== 'trouble') this.considered('build.' + why);
    return !why;
  }
  /** What bars spending on the network now, if anything (mayBuild without its diagnostics). */
  private buildBar(): 'trouble' | 'cash' | 'loan' | 'loss' | null {
    if (this.ai.railPolicy.deepTrouble) return 'trouble';
    const e = this.eco, c = this.ai.config;
    if (this.networkBudget() < 750_000) return 'cash';
    if (e.loan > e.maxLoan * Math.min(0.97, this.ai.loanAppetite + 0.2)) return 'loan';
    // Opening a railway is a capital outlay, not a recurring loss that should bar useful improvements.
    const v = e.yearTotals[e.yearTotals.length - 1]?.v;
    if (v && e.lastYearProfit - v.construction - v.vehicles < -1_500_000 * (0.5 + c.risk)) return 'loss';
    return null;
  }
  /** Borrow in steps (as ai.ts) until `amount` is there. */
  private borrowFor(amount: number): boolean {
    const e = this.eco;
    while (e.money < amount + 300_000 && e.loan + e.loanStep <= e.maxLoan * Math.min(0.97, this.ai.loanAppetite + 0.2) && e.borrow()) { /* borrow in steps */ }
    return e.money >= amount;
  }
  /** A spend of `cost` within `share` of what the company can commit; borrows for it. */
  private canSpend(cost: number, share = 0.3): boolean {
    if (!(cost >= 0)) return false;
    return cost <= Math.max(0, this.networkBudget()) * share && this.borrowFor(cost);
  }

  /** Edges a vehicle stands on now. */
  private busyEdges(): Set<number> {
    const out = new Set<number>();
    for (const v of this.g.vehicles.map.values()) {
      const o = v as unknown as { occupiedEdges?: () => number[]; seg?: unknown; kind: string };
      if (!o.occupiedEdges || (o.kind !== 'train' && !o.seg)) continue;
      for (const id of o.occupiedEdges()) out.add(id);
    }
    return out;
  }

  /** Fresh route: access permissions and train reservations can change without net.version changing. */
  private route(a: number, b: number, owner = this.me): number[] | null {
    return routeBetween(this.g, a, b, owner);
  }

  /** Consecutive station pairs of a line (out-and-back: along its path; else round its stops). */
  private pairsOf(l: Line): [number, number][] {
    const path = linearStops(l.stops), out: [number, number][] = [];
    if (path) { for (let i = 0; i + 1 < path.length; i++) out.push([path[i], path[i + 1]]); return out; }
    const n = l.stops.length;
    for (let i = 0; i < n; i++) { const a = l.stops[i], b = l.stops[(i + 1) % n]; if (a !== b && !out.some(([x, y]) => x === a && y === b)) out.push([a, b]); }
    return out;
  }

  /** Does every consecutive pair of the lines still have a route both ways? */
  private linesRoute(ids: Iterable<number>): boolean {
    for (const id of ids) {
      const l = this.g.lines.get(id);
      if (!l || l.kind !== 'rail') continue;
      for (const owner of this.g.lines.operatorsOf(l)) for (const [a, b] of this.pairsOf(l))
        if (!routeBetween(this.g, a, b, owner) || !routeBetween(this.g, b, a, owner)) return false;
    }
    return true;
  }

  private signal(lineId: number): number {
    try {
      // Most headless AI worlds have no unauthorised rail nodes; avoid planning the signals twice there.
      if (![...this.g.world.net.nodes.values()].some((n) => n.kind === 'rail' && !this.agrees(n.owner)))
        return autoSignalLine(this.g, lineId, this.me).placed;
      const plan = autoSignalLine(this.g, lineId, this.me, { preview: true });
      if (plan.signals.some((s) => s.action !== 'keep' && (s.node >= 0
        ? !this.agrees(this.g.world.net.nodes.get(s.node)?.owner ?? 0) : !this.mayAlter([s.edge])))) return 0;
      return autoSignalLine(this.g, lineId, this.me).placed;
    } catch (e) { this.note('signalling failed: ' + String((e as Error)?.message ?? e)); return 0; }
  }

  /** Lines (all companies) stopping at a station. */
  private linesAt(stationId: number): Line[] { return this.g.lines.linesAt(stationId); }

  /** Change a line's stops; its vehicles keep heading for the stop they were heading for. */
  private setStops(l: Line, stops: number[]) {
    const g = this.g, old = [...l.stops];
    l.stops = stops;
    for (const vid of l.vehicles) {
      const v = g.vehicles.get(vid);
      if (!v) continue;
      const target = old[v.stopIndex] ?? old[0];
      let k = 0;
      for (let i = 0; i < Math.min(v.stopIndex, old.length); i++) if (old[i] === target) k++;
      let idx = -1, seen = 0;
      for (let i = 0; i < stops.length; i++) if (stops[i] === target) { idx = i; if (seen++ === k) break; }
      v.stopIndex = idx >= 0 ? idx : 0;
    }
    g.lines.rebuild();
    for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
  }

  /** Insert station `s` into a line between its consecutive stops x and y (either way round). */
  private insertStop(l: Line, x: number, y: number, s: number): boolean {
    if (l.stops.includes(s)) return false;
    const path = linearStops(l.stops);
    if (path) {
      for (let i = 0; i + 1 < path.length; i++) {
        if ((path[i] === x && path[i + 1] === y) || (path[i] === y && path[i + 1] === x)) {
          const np = [...path.slice(0, i + 1), s, ...path.slice(i + 1)];
          this.setStops(l, outAndBack(np));
          return true;
        }
      }
      return false;
    }
    const n = l.stops.length;
    for (let i = 0; i < n; i++) {
      const a = l.stops[i], b = l.stops[(i + 1) % n];
      if ((a === x && b === y) || (a === y && b === x)) { const st = [...l.stops]; st.splice(i + 1, 0, s); this.setStops(l, st); return true; }
    }
    return false;
  }

  /** Express / rapid patterns of a line pass a small new station (the locals stop there). */
  private localOnly(l: Line, stationId: number) {
    if (!PAT.linePatterns || !l.patterns || l.patterns.length < 2) return;
    for (const p of PAT.linePatterns(l)) {
      if (p.kind === 'local') continue;
      l.stops.forEach((s, i) => { if (s === stationId) p.stops[i] = false; });
    }
  }

  /** One line per route (UPDATE 9k): merge a line we changed with a subset / superset line. */
  private canon(lineId: number) {
    if (!PAT.canonicalizeLines) return;
    if (this.g.lines.get(lineId)?.owner !== this.me) return;
    try {
      for (const nt of PAT.canonicalizeLines(this.g, lineId, { sameOwnerOnly: true })) { this.note(nt.text); this.bump('netLinesMerged'); this.forget(nt.from); }
    } catch (e) { this.note('line merge failed: ' + String((e as Error)?.message ?? e)); }
  }

  /** A line that no longer exists: out of its company's controller (ai.ts would otherwise follow the merged id). */
  private forget(lineId: number) {
    for (const ai of this.g.ais) (ai as unknown as { lines?: Map<number, ManagedLine> }).lines?.delete(lineId);
  }

  /** Mutual open access is the companies' standing consent to joint network improvements. */
  private agrees(other: number): boolean {
    const g = this.g;
    return other === this.me || (other > 0 && !!g.companies[other] && !g.companies[other].defunct && g.accessPolicy(this.me) === 'open'
      && g.accessPolicy(other) === 'open' && g.canUse(this.me, other) && g.canUse(other, this.me));
  }

  private mayAlter(ids: Iterable<number>): boolean {
    const net = this.g.world.net;
    for (const id of ids) {
      const e = net.edges.get(id);
      if (!e || !this.agrees(e.owner) || [e.a, e.b].some((n) => !this.agrees(net.nodes.get(n)?.owner ?? 0))) return false;
    }
    return true;
  }

  /** A crossing beneath existing ground infrastructure can rebuild it as a bridge. Public streets
   * are available for junctions; company infrastructure needs its owner's consent, including taps. */
  private proposalConsent(p: Proposal, planned = false): boolean {
    const net = this.g.world.net;
    const node = (id: number) => {
      const n = net.nodes.get(id);
      // (`planned`: a plan's own nodes, not built yet, need no one's consent)
      if (!n) return planned;
      return n.kind === 'road' && n.owner < 0 || this.agrees(n.owner);
    };
    const edge = (id: number) => {
      const e = net.edges.get(id);
      return !!e && (e.kind === 'road' && e.owner < 0 || this.agrees(e.owner)) && node(e.a) && node(e.b);
    };
    for (const t of p.tracks) for (const s of [t.start, t.end]) {
      if (s.kind === 'node' && !node(s.node!) || s.kind === 'edge' && !edge(s.edge!)) return false;
    }
    for (const c of p.crossings) {
      if (c.mode === 'over') continue;
      if (c.mode === 'under') {
        const e = net.edges.get(c.edge);
        if (!e) return false;
        if (net.sectionAt(e, c.sOld) !== 'ground'
          || p.tracks[c.track].sections.some((s) => s.type === 'tunnel' && c.sNew >= s.s0 - 0.5 && c.sNew <= s.s1 + 0.5)) continue;
      }
      if (!edge(c.edge)) return false;
    }
    return true;
  }

  // ================================================================ road shortcuts
  private *roadServices(corridor?: number[], lineIds?: number[]): Generator<void, RoadService[]> {
    const g = this.g, out: RoadService[] = [];
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'road' && l.kind !== 'tram') continue;
      if (lineIds && !lineIds.includes(l.id)) continue;
      if (corridor && (!l.stops.includes(corridor[0]) || !l.stops.includes(corridor[1]) || Number(l.kind === 'tram') !== corridor[2])) continue;
      const fleet = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is RoadVehicle => v?.kind === 'road' && v.owner === this.me && !!(v as RoadVehicle).model);
      if (!fleet.length) continue;
      const ps = PAT.linePatterns?.(l) ?? [{ id: 0, kind: 'local', stops: l.stops.map(() => true) }];
      for (const p of ps) {
        const vs = fleet.filter((v) => (ps.some((q) => q.id === v.pattern) ? v.pattern : ps[0].id) === p.id);
        if (!vs.length) continue;
        const stops = l.stops.filter((_, i) => p.stops[i] !== false);
        if (new Set(stops).size < 2) continue;
        const kmh = Math.min(...vs.map((v) => v.maxSpeedKmh));
        const legs: RoadService['legs'] = [];
        for (let i = 0; i < stops.length; i++) {
          const a = stops[i], b = stops[(i + 1) % stops.length];
          if (a === b) continue;
          const before = roadRouteBetween(g, a, b, this.me, l.kind === 'tram', kmh, g.lines.isLoop(l));
          yield;
          if (!before) { legs.length = 0; break; }
          legs.push({ a, b, before });
        }
        if (legs.length) out.push({ line: l, vehicles: vs, legs, cycle: legs.reduce((s, h) => s + h.before.seconds + 5, 0), kmh });
      }
    }
    return out;
  }

  private denseRoadPoint(x: number, z: number): boolean {
    const g = this.g;
    for (const t of g.towns.list) {
      if (Math.hypot(t.x - x, t.z - z) > Math.min(16, t.radius * 0.35)) continue;
      let buildings = 0;
      for (const id of g.world.bgrid.query(x - 6, z - 6, x + 6, z + 6)) {
        const b = g.world.buildings.get(id);
        if (!b || Math.hypot(b.x - x, b.z - z) > 6) continue;
        if (b.floors >= 4 || b.type >= BT_TOWER) return true;
        buildings++;
      }
      if (buildings >= 6) return true;
    }
    return false;
  }

  private safeRoadPlan(p: Proposal): boolean {
    if (!p.ok || !this.proposalConsent(p) || !this.demolitionOk(p.demolish)) return false;
    if (p.demolish.some((id) => { const b = this.g.world.buildings.get(id); return b && this.denseRoadPoint(b.x, b.z); })) return false;
    for (const t of p.tracks) {
      const b = t.bez, n = Math.max(1, Math.ceil(t.len / 2));
      for (let i = 0; i <= n; i++) {
        const v = i / n, u = 1 - v;
        if (this.denseRoadPoint(u ** 3 * b.x0 + 3 * u * u * v * b.x1 + 3 * u * v * v * b.x2 + v ** 3 * b.x3,
          u ** 3 * b.z0 + 3 * u * u * v * b.z1 + 3 * u * v * v * b.z2 + v ** 3 * b.z3)) return false;
      }
    }
    return true;
  }
  private roadOutlay(p: Proposal): number {
    return p.cost + p.demolish.reduce((s, id) => { const b = this.g.world.buildings.get(id); return s + (b ? 3000 + b.pop * 1250 : 0); }, 0);
  }

  /** Facing nodes / edge taps, reached along the stop's own street network rather than an isolated nearby road. */
  private *roadEndpoints(st: Station, toward: Station, tram: boolean): Generator<void, Snap[]> {
    const net = this.g.world.net, d = Math.hypot(toward.x - st.x, toward.z - st.z) || 1;
    const ux = (toward.x - st.x) / d, uz = (toward.z - st.z) / d, R = Math.min(45, Math.max(12, d * 0.3));
    const seen = new Set<number>(), queue = st.stops.map((p) => p.edge), points = new Map<string, Snap>();
    const add = (p: Snap) => {
      const dx = p.x - st.x, dz = p.z - st.z;
      if (Math.hypot(dx, dz) > R || dx * ux + dz * uz < -2 || this.denseRoadPoint(p.x, p.z)) return;
      points.set(p.kind === 'node' ? 'n' + p.node : `e${p.edge}:${p.s!.toFixed(2)}`, p);
    };
    let work = 0;
    while (queue.length && seen.size < 256) {
      const id = queue.shift()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e || e.kind !== 'road' || e.depot >= 0 || (tram && !tramUsable(this.g, e, this.me))) continue;
      const p = { x: 0, y: 0, z: 0 };
      for (let s = 2; s < e.len - 2; s += 5) { net.pointAt(e, s, p); add({ ...p, kind: 'edge', edge: e.id, s }); if (++work % 32 === 0) yield; }
      for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid);
        if (!n) continue;
        add({ kind: 'node', node: nid, x: n.x, y: n.y, z: n.z });
        if (Math.hypot(n.x - st.x, n.z - st.z) <= R) queue.push(...n.edges.filter((x) => !seen.has(x)));
      }
      if (++work % 32 === 0) yield;
    }
    const score = (p: Snap) => Math.hypot(p.x - toward.x, p.z - toward.z) + 0.35 * Math.hypot(p.x - st.x, p.z - st.z);
    // Keep spatially different alternatives: neighbouring taps often fail for the same crossing or building.
    const out: Snap[] = [];
    for (const p of [...points.values()].sort((a, b) => score(a) - score(b))) {
      if (out.every((q) => Math.hypot(q.x - p.x, q.z - p.z) >= 8)) out.push(p);
      if (out.length === 4) break;
    }
    return out;
  }

  /** Copy roads once for this atomic candidate, then undo only each plan's taps/junctions between previews. */
  private roadSandbox() {
    const g = this.g, source = g.world.net, preview = Object.create(g) as Game;
    preview.world = Object.create(g.world);
    preview.world.markObjArea = () => {};
    const net = new Network(preview.world);
    preview.world.net = net;
    preview.stations = Object.create(g.stations);
    preview.stations.map = new Map([...g.stations.map].map(([id, st]) => [id, { ...st, stops: st.stops.map((s) => ({ ...s })) }]));
    for (const n of source.nodes.values()) if (n.kind === 'road') net.nodes.set(n.id, { ...n, edges: [...n.edges] });
    for (const e of source.edges.values()) if (e.kind === 'road') net.edges.set(e.id, { ...e, bez: { ...e.bez }, sections: e.sections.map((s) => ({ ...s })) });
    net.nextNode = source.nextNode; net.nextEdge = source.nextEdge;
    const firstNode = net.nextNode, firstEdge = net.nextEdge;
    const nodes = new Map<number, NNode>(), edges = new Map<number, NEdge>();
    const stops = new Map<Station['stops'][number], { edge: number; s: number }>();
    const rememberNode = (id: number) => {
      const n = net.nodes.get(id);
      if (n && id < firstNode && !nodes.has(id)) nodes.set(id, { ...n, edges: [...n.edges] });
    };
    const rememberEdge = (id: number) => {
      const e = net.edges.get(id);
      if (e && id < firstEdge && !edges.has(id)) edges.set(id, { ...e, bez: { ...e.bez }, sections: e.sections.map((s) => ({ ...s })) });
    };
    const reset = () => {
      // No listeners on the isolated network refer to the real game.
      for (let id = firstEdge; id < net.nextEdge; id++) if (net.edges.has(id)) net.removeEdge(id);
      for (let id = firstNode; id < net.nextNode; id++) if (net.nodes.has(id)) net.removeNode(id);
      for (const [id, n] of nodes) net.nodes.set(id, n);
      for (const [id, e] of edges) net.edges.set(id, e);
      for (const [stop, old] of stops) Object.assign(stop, old);
      nodes.clear(); edges.clear(); stops.clear(); net.clearCaches();
      // Monotonic preview IDs also prevent the private Bezier table cache from reusing a previous plan.
    };
    const apply = (p: Proposal): boolean => {
      const remap = new Map<number, { a: number; b: number; s: number }>();
      const locate = (id: number, s: number): { id: number; s: number } => {
        for (let k = 0; k < 32; k++) { const r = remap.get(id); if (!r) break; if (s < r.s) id = r.a; else { id = r.b; s -= r.s; } }
        return { id, s };
      };
      const split = (id: number, s: number) => {
        const e = net.edges.get(id);
        if (!e) return null;
        rememberEdge(id); rememberNode(e.a); rememberNode(e.b);
        const q = net.splitEdge(id, s);
        if (q) {
          remap.set(id, { a: q.e1.id, b: q.e2.id, s });
          for (const st of preview.stations.map.values()) for (const stop of st.stops) if (stop.edge === id) {
            if (!stops.has(stop)) stops.set(stop, { edge: stop.edge, s: stop.s });
            if (stop.s < s) stop.edge = q.e1.id; else { stop.edge = q.e2.id; stop.s -= s; }
          }
        }
        return q;
      };
      const resolve = (s: Snap): number | null => {
        if (s.kind === 'node') { rememberNode(s.node!); return net.nodes.has(s.node!) ? s.node! : null; }
        if (s.kind !== 'edge') return null;
        const q = locate(s.edge!, s.s!), e = net.edges.get(q.id);
        if (!e) return null;
        const cut = split(q.id, q.s);
        const node = cut?.node.id ?? (q.s <= 0.05 ? e.a : q.s >= e.len - 0.05 ? e.b : null);
        if (node !== null) rememberNode(node);
        return node;
      };
      const created: number[] = [];
      for (const tp of p.tracks) {
        const a = resolve(tp.start), b = resolve(tp.end);
        if (a === null || b === null) return false;
        created.push(net.addEdge('road', a, b, { ...tp.bez }, tp.prof, tp.sections, 'road', this.me, p.opts.tram ? { tram: true, tramOwner: this.me } : {}).id);
      }
      for (const c of p.crossings) if (c.mode === 'junction' && source.edges.get(c.edge)?.kind === 'road') {
        const a = locate(c.edge, c.sOld), b = locate(created[c.track], c.sNew);
        if (!net.edges.has(a.id) || !net.edges.has(b.id)) return false;
        const na = split(a.id, a.s), nb = split(b.id, b.s);
        if (na && nb) {
          rememberNode(na.node.id); rememberNode(nb.node.id);
          for (const id of [...na.node.edges, ...nb.node.edges]) rememberEdge(id);
          net.mergeNodes(na.node.id, nb.node.id);
        }
      }
      return true;
    };
    return { preview, apply, reset };
  }

  /** Passenger revenue only: faster fares and the extra ridership attracted at the new frequency. */
  private *roadBenefit(preview: Game, services: RoadService[]): Generator<void, number> {
    let value = 0;
    const demandKey = (a: number, b: number) => {
      const x = this.g.stations.get(a)?.townId ?? -1, y = this.g.stations.get(b)?.townId ?? -1;
      return `${Math.min(x, y)}:${Math.max(x, y)}`;
    };
    const frequency = new Map<string, number>();
    for (const s of services) for (const h of s.legs) {
      const key = demandKey(h.a, h.b);
      frequency.set(key, (frequency.get(key) ?? 0) + YEAR_S * s.vehicles.length / Math.max(1, s.cycle));
    }
    for (const service of services) {
      const { line: l, vehicles: vs, legs, kmh, cycle } = service;
      const after: RoadHop[] = [];
      for (const h of legs) {
        const r = roadRouteBetween(preview, h.a, h.b, this.me, l.kind === 'tram', kmh, this.g.lines.isLoop(l));
        yield;
        if (!r) return 0;
        after.push(r);
      }
      const trips = YEAR_S * vs.length / Math.max(1, cycle), headway = cycle / vs.length;
      const nextHeadway = after.reduce((s, h) => s + h.seconds + 5, 0) / vs.length;
      const capacity = vs.reduce((s, v) => s + v.capacity, 0) / vs.length;
      for (let i = 0; i < legs.length; i++) {
        // Resolve stations in the current work unit, after the saved candidate cursor resumes.
        const h = legs[i], r = after[i], A = this.g.stations.get(h.a), B = this.g.stations.get(h.b);
        if (!A || !B || r.length >= h.before.length - 1 || r.seconds >= h.before.seconds) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        // Share the town-pair forecast among our services and directions, rather than counting all its
        // passengers again for each line using the corridor. Observed boardings can exceed that forecast.
        const demand = this.townTrips(A.townId, B.townId) * 12 * 0.65 * trips / Math.max(1, frequency.get(demandKey(h.a, h.b)) ?? trips);
        const oldTime = h.before.seconds + headway / 2, newTime = r.seconds + nextHeadway / 2;
        const oldFactor = tripFactor(oldTime, refTime(d)), newFactor = tripFactor(newTime, refTime(d));
        const boardings = Math.min(trips * capacity * 0.8, Math.max(demand * oldFactor, l.passLast * 12 / Math.max(1, l.stops.length)));
        const nextBoardings = Math.min(YEAR_S / Math.max(1, nextHeadway) * capacity * 0.8, boardings + demand * Math.max(0, newFactor - oldFactor));
        const ctx = { mode: l.kind === 'tram' ? 'tram' as const : 'bus' as const };
        // (riders of the service itself: direct legs pay the full fare)
        value += fareFor(d, newTime, nextBoardings, ctx) - fareFor(d, oldTime, boardings, ctx);
      }
    }
    return value;
  }

  private roadCandidates(services: RoadService[], pending?: string) {
    const g = this.g;
    const candidates = new Map<string, { a: number; b: number; tram: boolean; before: RoadHop; kmh: number; loop: boolean }>();
    for (const s of services) for (const h of s.legs) {
      const A = g.stations.get(h.a), B = g.stations.get(h.b);
      if (!A || !B) continue;
      const d = Math.hypot(A.x - B.x, A.z - B.z);
      const tram = s.line.kind === 'tram', key = `road${Math.min(h.a, h.b)}:${Math.max(h.a, h.b)}:${tram}`;
      if (d > 1 && h.before.length > d * 1.5 && h.before.length - d > 15 && (key === pending || !this.cared(key)) && !candidates.has(key)) {
        candidates.set(key, { ...h, tram, kmh: s.kmh, loop: g.lines.isLoop(s.line) });
        this.considered('roads.detour');
      }
    }
    return [...candidates.values()].sort((a, b) => b.before.length - a.before.length).slice(0, 6);
  }

  private *roadsTask(item: WorkItem): Generator<void, void> {
    const ids = item.ids;
    if (this.cared('roads:period') || !this.mayBuild()) { delete item.road; return; }
    const g = this.g, services = yield* this.roadServices(ids);
    const pending = item.road ? `road${Math.min(ids[0], ids[1])}:${Math.max(ids[0], ids[1])}:${!!ids[2]}` : undefined;
    const candidates = this.roadCandidates(services, pending).filter((c) => c.a === ids[0] && c.b === ids[1] && Number(c.tram) === ids[2]);
    if (!candidates.length) { delete item.road; return; }
    for (const c of candidates) {
      const key = `road${Math.min(c.a, c.b)}:${Math.max(c.a, c.b)}:${c.tram}`;
      this.careFor(key, 180);
      const A = g.stations.get(c.a), B = g.stations.get(c.b);
      if (!A || !B) { delete item.road; continue; }
      if (!this.townTrips(A.townId, B.townId) && !services.some((s) => s.line.passLast > 0)) { delete item.road; this.considered('roads.noPassengers'); continue; }
      const as = yield* this.roadEndpoints(A, B, c.tram), bs = yield* this.roadEndpoints(B, A, c.tram);
      if (!as.length || !bs.length) { delete item.road; this.considered('roads.noEndpoints'); continue; }
      // Compare a bounded set of short alignments, rather than spending on the first feasible one.
      const alternatives = as.flatMap((a) => bs.map((b) => ({ a, b }))).sort((p, q) =>
        Math.hypot(p.a.x - p.b.x, p.a.z - p.b.z) - Math.hypot(q.a.x - q.b.x, q.a.z - q.b.z)).slice(0, 4);
      const cursor = item.road ??= { at: 0 };
      const comparing = cursor.at < alternatives.length;
      for (const { a, b } of alternatives.slice(cursor.at, cursor.at + 1)) {
        for (const crossing of ['auto', 'over', 'under'] as const) {
          const start = findSnap(g, 'road', a.x, a.z, 0.2), end = findSnap(g, 'road', b.x, b.z, 0.2);
          if (start.kind === 'free' || end.kind === 'free') break;
          const p = planEdge(g, start, end, { kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing, owner: this.me, tram: c.tram, straight: true });
          yield;
          if (!p.ok) { this.considered('roads.plan.' + (p.errors[0] ?? 'unknown').split(':')[0]); continue; }
          // Prefer no demolition, permit only the normal AI's small outskirts clearances, never a dense centre.
          if (!this.safeRoadPlan(p)) { this.considered('roads.buildings'); continue; }
          const choice: RoadChoice = { ax: a.x, az: a.z, bx: b.x, bz: b.z, crossing, cost: this.roadOutlay(p), demolish: !!p.demolish.length };
          if (!cursor.best || Number(choice.demolish) < Number(cursor.best.demolish)
            || (choice.demolish === cursor.best.demolish && choice.cost < cursor.best.cost)) cursor.best = choice;
          // Automatic crossings are cheapest when feasible; alternatives matter when their height fails.
          break;
        }
      }
      // Keep the winning proposal's fresh verification and route valuation on a separate day too.
      if (comparing) { cursor.at++; return; }
      const best = cursor.best;
      delete item.road;
      if (!best) { this.careFor(key, 30); continue; }
      // Only small endpoints/choice metadata survives the day. Re-plan the winner in today's world.
      const start = findSnap(g, 'road', best.ax, best.az, 0.2), end = findSnap(g, 'road', best.bx, best.bz, 0.2);
      if (start.kind === 'free' || end.kind === 'free') { this.careFor(key, 30); continue; }
      const winner = planEdge(g, start, end, { kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing: best.crossing, owner: this.me, tram: c.tram, straight: true });
      if (!this.safeRoadPlan(winner)) { this.careFor(key, 30); continue; }
      // Preview the exact proposal; no cash, ids, terrain or vehicles change until it is justified.
      const sandbox = this.roadSandbox();
      for (const p of [winner]) {
        const version = g.world.net.version;
        sandbox.reset();
        if (!sandbox.apply(p)) { this.considered('roads.stale'); continue; }
        const preview = sandbox.preview;
        const route = roadRouteBetween(preview, c.a, c.b, this.me, c.tram, c.kmh, c.loop);
        yield;
        if (!route || route.length >= c.before.length - 15) continue;
        const upkeep = p.tracks.reduce((s, t) => s + t.len * (ROAD_TYPES.road.maintPerUnit + (c.tram ? TRAM.maintPerUnit : 0))
          + t.sections.reduce((v, q) => v + (q.s1 - q.s0) * ROAD_TYPES.road.maintPerUnit * (q.type === 'tunnel' ? 4 : 3), 0), 0);
        const annual = (yield* this.roadBenefit(preview, services)) - upkeep;
        this.considered('roads.valued');
        if (g.world.net.version !== version) { this.considered('roads.stale'); continue; }
        const outlay = this.roadOutlay(p);
        if (!(annual > 0 && annual * 8 > outlay && outlay / annual <= 6)) { this.considered('roads.payback'); continue; }
        const fresh = p, total = outlay;
        const before = roadRouteBetween(g, c.a, c.b, this.me, c.tram, c.kmh, c.loop);
        if (!before || route.length >= before.length - 15) continue;
        // Match the commit primitive's possession checks before borrowing.
        if (fresh.tracks.some((t) => [t.start, t.end].some((s) => s.kind === 'edge' && g.vehicles.isEdgeBusy(s.edge!)))
          || fresh.crossings.some((x) => (x.mode === 'junction' || (x.mode === 'under'
            && !fresh.tracks[x.track].sections.some((q) => q.type === 'tunnel' && x.sNew >= q.s0 - 0.5 && x.sNew <= q.s1 + 0.5)))
            && g.vehicles.isEdgeBusy(x.edge))) { this.careFor(key, 15); continue; }
        if (!this.canSpend(total)) continue;
        const demolished = fresh.demolish.map((id) => g.world.buildings.get(id)!).filter(Boolean).map((b) => ({ townId: b.townId, pop: b.pop }));
        const money = this.eco.money;
        const built = this.builtEdges(() => commitProposal(g, fresh), 'road');
        if (built.result) {
          for (const id of built.edges) g.world.net.removeEdge(id);
          this.eco.spend(this.eco.money - money, 'construction', true);
          this.compensate(fresh.demolish, demolished.filter((_, i) => !g.world.buildings.has(fresh.demolish[i])));
          this.careFor(key, /way|busy/i.test(built.result) ? 15 : 180); continue;
        }
        const after = roadRouteBetween(g, c.a, c.b, this.me, c.tram, c.kmh, c.loop);
        if (!after || after.length >= before.length - 15) {
          for (const id of built.edges) g.world.net.removeEdge(id);
          this.eco.spend(this.eco.money - money, 'construction', true);
          this.compensate(fresh.demolish, demolished);
          g.onNetworkChanged();
          this.note('road shortcut given up: the driven route did not shorten');
          return;
        }
        this.compensate(fresh.demolish, demolished);
        for (const s of services) for (const v of s.vehicles) if (g.vehicles.get(v.id) === v) v.onLineChanged();
        this.careFor('roads:period', 120);
        this.bump('netRoads'); this.bump('netRoadUnitsSaved', before.length - after.length);
        this.note(`road shortcut ${A.name} – ${B.name}: driven ${Math.round(before.length)} -> ${Math.round(after.length)} u, ${Math.round(total / 1000)}k, ${(total / annual).toFixed(1)} years payback`);
        this.news(`builds a road shortcut between ${A.name} and ${B.name}.`, (A.x + B.x) / 2, (A.z + B.z) / 2);
        return;
      }
    }
  }

  // ================================================================ joining end-to-end services
  private joinAllowed(l: Line): boolean {
    return l.owner !== 0 && this.agrees(l.owner) && (l.owner === this.me || this.g.lines.partnerPolicy(l) === 'open');
  }

  private *joinTask(ids: number[]): Generator<void, void> {
    // Recheck the optional exports each period (old builds / saves can still run the rest of the planner).
    if (!PAT.canJoinLines || !PAT.joinLines || this.cared('join:period')) return;
    const g = this.g, lines = this.selected(g.lines.map.values(), ids).filter((l) => l.vehicles.length && this.pathOf(l));
    let work = 0;
    for (let i = 0; i < lines.length; i++) for (let j = i + 1; j < lines.length; j++) {
      if (++work % 8 === 0) yield;
      const a = lines[i], b = lines[j], key = `join${a.id}:${b.id}`;
      if (!g.lines.map.has(a.id) || !g.lines.map.has(b.id) || a.kind !== b.kind || this.cared(key)
        || (!this.fleet(a).ours.length && !this.fleet(b).ours.length)) continue;
      const pa = this.pathOf(a), pb = this.pathOf(b);
      if (!pa || !pb || !this.joinAllowed(a) || !this.joinAllowed(b)) continue;
      const junction = [pa[0], pa[pa.length - 1]].find((s) => s === pb[0] || s === pb[pb.length - 1]);
      if (junction === undefined) continue;
      this.considered('join.termini');
      this.careFor(key, 180);
      const operators = [...new Set([...g.lines.operatorsOf(a), ...g.lines.operatorsOf(b)])];
      if (operators.some((o) => !this.agrees(o)) || (a.owner !== b.owner && (g.lines.partnerPolicy(a) !== 'open' || g.lines.partnerPolicy(b) !== 'open'))) continue;
      const ah = PAT.patternHeadways?.(g, a) ?? [], bh = PAT.patternHeadways?.(g, b) ?? [];
      // Existing short turns/expresses keep their stock. Estimate the proposed all-through fleet using
      // actual cycles (no 120-second clamp) and count other operators only on their existing sections.
      if (ah.length !== 1 || bh.length !== 1) { this.considered('join.stock'); continue; }
      const ca = ah[0].cycle, cb = bh[0].cycle;
      const own = this.fleet(a).ours.length + this.fleet(b).ours.length;
      const rate = own / Math.max(1, ca + cb);
      const afterA = 1 / (rate + this.fleet(a).others / ca), afterB = 1 / (rate + this.fleet(b).others / cb);
      if (afterA > ah[0].headway * 1.1 || afterB > bh[0].headway * 1.1) { this.considered('join.stock'); continue; }
      const check = PAT.canJoinLines(g, a, b);
      yield;
      if (!check.ok) { this.considered('join.continuity'); continue; }
      let trips = 0;
      // Trips between the two halves already served via a change still benefit; newTrips would discard them.
      const seen = new Set<string>();
      for (const x of pa.filter((s) => s !== junction)) for (const y of pb.filter((s) => s !== junction)) {
        const X = g.stations.get(x), Y = g.stations.get(y);
        if (!X || !Y || X.townId === Y.townId) continue;
        const k = [X.townId, Y.townId].sort((a, b) => a - b).join(':');
        if (seen.has(k)) continue;
        seen.add(k); trips += this.townTrips(X.townId, Y.townId);
      }
      if (trips < 10 * PASSENGER_RATE_SCALE) { this.considered('join.demand'); continue; }
      const infos = g.ais.map((ai) => ({ ai, map: (ai as unknown as { lines?: Map<number, ManagedLine> }).lines })).map((o) => ({ ...o, info: o.map?.get(check.into) ?? o.map?.get(check.from) }));
      const res = PAT.joinLines(g, a, b, { notify: false });
      if (typeof res === 'string') continue;
      const joined = res.line;
      // The general join primitive preserves short turns. The AI's justified through service uses its local.
      const through = joined.patterns?.find((p) => p.kind === 'local' && p.stops.every(Boolean));
      for (const vid of joined.vehicles) { const v = g.vehicles.get(vid); if (v?.owner === this.me && through) { v.pattern = through.id; v.onLineChanged(); } }
      this.forget(res.from);
      for (const o of infos) if (o.info && o.map) {
        o.map.set(res.into, { ...o.info, towns: [...new Set(check.route.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))],
          maxVehicles: Math.max(o.info.maxVehicles, joined.vehicles.filter((id) => g.vehicles.get(id)?.owner === o.ai.companyId).length),
          shared: joined.owner === o.ai.companyId ? undefined : joined.owner });
      }
      g.lines.rebuild();
      if (joined.kind === 'rail' && joined.owner === this.me) this.signal(joined.id);
      this.careFor('dec' + joined.id, 360); this.careFor('join:period', 90);
      this.bump('netJoined');
      this.note(`${res.text}; through running for ${trips.toFixed(1)} trips a month`);
      const st = g.stations.get(junction);
      this.news(`joins two services at ${st?.name ?? 'their terminus'}: ${joined.kind === 'rail' ? 'trains' : 'vehicles'} run through.`, st?.x, st?.z);
      return;
    }
  }

  /** Trips per month between two towns (both ways), from the regional demand model (local and long-distance). */
  private townTrips(a: number, b: number): number {
    const g = this.g, nt = g.towns.list.length;
    if (a < 0 || b < 0 || a >= nt || b >= nt) return 0;
    if (!this.dem || this.dem.nt !== nt || g.day - this.dem.day > 30) {
      const m = g.demand as unknown as { regions: { town: number; produced: number; pop: number }[]; od: Float32Array; ld?: Float32Array };
      const R = m.regions ?? [], n = R.length, P = new Float64Array(nt * nt);
      const ld = m.ld && m.ld.length === n * n ? m.ld : null;
      if (m.od && m.od.length === n * n) for (let r = 0; r < n; r++) {
        const ta = R[r].town;
        if (ta < 0 || ta >= nt) continue;
        for (let q = 0; q < n; q++) {
          const tb = R[q].town;
          if (q === r || tb < 0 || tb >= nt) continue;
          const t = R[r].produced * m.od[r * n + q] + (ld ? R[r].pop * ld[r * n + q] : 0);
          P[ta * nt + tb] += t;
          if (ta !== tb) P[tb * nt + ta] += t;
        }
      }
      this.dem = { day: g.day, nt, P };
    }
    return this.dem.P[a * nt + b];
  }

  /** Monthly trips gained by a new or shorter journey, and their annual revenue at calibrated fares. */
  private newTrips(as: number[], bs: number[], direct = false, headway = 900): { trips: number; revenue: number } {
    const g = this.g;
    let trips = 0, revenue = 0;
    const seen = new Set<string>();
    for (const a of as) for (const b of bs) {
      if (a === b) continue;
      const sa = g.stations.get(a), sb = g.stations.get(b);
      if (!sa || !sb || sa.townId < 0 || sb.townId < 0 || sa.townId === sb.townId) continue;
      const k = sa.townId < sb.townId ? `${sa.townId}:${sb.townId}` : `${sb.townId}:${sa.townId}`;
      if (seen.has(k)) continue;
      const hop = g.lines.nextHop(a, b);
      // A slow bus / transfer path must not suppress a worthwhile rail connection forever.
      const distance = Math.hypot(sa.x - sb.x, sa.z - sb.z);
      const time = estimateLegTime(distance, 70, headway, 1.3) + (direct ? 0 : 360);
      const gain = hop ? hop.cost >= time * 1.4 ? Math.min(0.75, 1 - time / hop.cost) : 0 : 1;
      if (!gain) continue;
      seen.add(k);
      const added = this.townTrips(sa.townId, sb.townId) * gain;
      trips += added;
      revenue += added * 12 * estimateLegFare(distance, 70, headway, 1, 1.3, direct, false, { mode: 'rail' });
    }
    return { trips, revenue };
  }

  /** Judge improvements against the lines' scheduled service rather than a fixed, long wait. */
  private headway(ls: Line[]): number {
    const times = ls.flatMap((l) => PAT.patternHeadways?.(this.g, l).map((p) => p.headway) ?? []).filter((t) => t > 0 && Number.isFinite(t));
    return times.length ? Math.max(120, ...times) : 900;
  }

  /** Path of a line (out and back) or null. */
  private pathOf(l: Line): number[] | null { return linearStops(l.stops); }

  /** Own vehicles of a line, and whether other companies run vehicles on it too. */
  private fleet(l: Line): { ours: number[]; others: number } {
    let others = 0;
    const ours: number[] = [];
    for (const vid of l.vehicles) { const v = this.g.vehicles.get(vid); if (!v) continue; if (v.owner === this.me) ours.push(v.id); else others++; }
    return { ours, others };
  }

  /** Passenger terminus: buffers, short unused stubs or a depot lead; the other end serves the line. */
  private freeEnd(st: Station, end: 'front' | 'back'): boolean {
    const net = this.g.world.net, ends = this.g.stations.trackEnds(st);
    if (!ends.length) return false;
    const platforms = new Set([...st.rail!.edges, ...st.rail!.throughEdges]);
    const terminal = (node: number): boolean => {
      const n = net.nodes.get(node);
      if (!n) return false;
      const seen = new Set(platforms), queue = [...n.edges];
      let length = 0;
      for (let k = 0; queue.length && k < 64; k++) {
        const id = queue.pop()!;
        if (seen.has(id)) continue;
        seen.add(id);
        const e = net.edges.get(id);
        if (!e || e.kind !== 'rail' || e.owner !== this.me || e.station >= 0 || this.g.stations.throughStationOf(e.id) >= 0) return false;
        if (e.depot >= 0) continue;
        length += e.len;
        if (length > 45) return false;
        for (const nid of [e.a, e.b]) for (const eid of net.nodes.get(nid)?.edges ?? []) if (!seen.has(eid)) queue.push(eid);
      }
      return !queue.length;
    };
    if (!ends.every((t) => terminal(t[end]))) return false;
    const other = end === 'front' ? 'back' : 'front';
    return ends.some((t) => (net.nodes.get(t[other])?.edges.length ?? 0) > 1);
  }

  /** Town buildings a plan demolishes: acceptable (few, no landmarks, not the dense centre) and their compensation. */
  private demolitionOk(ids: number[]): boolean {
    const g = this.g, w = g.world;
    if (ids.length > 4) return false;
    let pop = 0;
    for (const id of ids) {
      const b = w.buildings.get(id);
      if (!b) continue;
      if (b.type >= BT_TOWER) return false;
      pop += b.pop;
      const T = g.towns.list[b.townId];
      if (T && Math.hypot(b.x - T.x, b.z - T.z) < T.radius * 0.3 && b.floors >= 4) return false;
    }
    return pop <= 90;
  }
  /** Compensation for demolished town buildings (on top of the demolition in the plan's cost) and a small rating hit. */
  private compensate(ids: number[], residents?: { townId: number; pop: number }[]) {
    if (!ids.length) return;
    const g = this.g, w = g.world;
    let pay = 0;
    const towns = new Set<number>();
    for (const b of residents ?? ids.map((id) => w.buildings.get(id)).filter((b): b is NonNullable<typeof b> => !!b)) { pay += 3000 + b.pop * 1250; towns.add(b.townId); }
    if (pay) this.eco.spend(pay, 'construction', true);
    for (const st of g.stations.map.values()) if (st.owner === this.me && towns.has(st.townId)) st.rating = Math.max(0, st.rating - 0.015 * ids.length);
    this.bump('netDemolished', ids.length);
  }

  /** Rail options for a connecting track of the given type. */
  private railOpts(type: string): BuildOptions { return { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.me }; }

  /** New links only, excluding replacement pieces of existing track split by the operation (safe rollback). */
  private builtEdges<T>(commit: () => T, kind: 'rail' | 'road' = 'rail'): { result: T; edges: number[] } {
    const net = this.g.world.net, first = net.nextEdge, inherited = new Set<number>();
    const split = (old: NEdge, a: NEdge, b: NEdge) => {
      if (old.id < first || inherited.has(old.id)) { inherited.add(a.id); inherited.add(b.id); }
    };
    net.onSplit.push(split);
    try {
      const result = commit();
      const edges = [...net.edges.values()].filter((e) => e.id >= first && e.kind === kind && e.owner === this.me && !inherited.has(e.id)).map((e) => e.id);
      return { result, edges };
    } finally {
      const i = net.onSplit.indexOf(split);
      if (i >= 0) net.onSplit.splice(i, 1);
    }
  }

  /**
   * Take up the plain own track ending at a dead-end node (back to a junction, a station, a depot or another
   * company's track). Returns the length taken up (0 if a vehicle is on it or it is long: an unfinished line).
   */
  private takeUpStub(nodeId: number, maxLen = 140, busy?: Set<number>): number {
    const g = this.g, net = g.world.net;
    const n0 = net.nodes.get(nodeId);
    if (!n0 || n0.kind !== 'rail' || n0.edges.length !== 1) return 0;
    const chain: number[] = [];
    let at = n0.id, len = 0;
    let cur = net.edges.get(n0.edges[0]);
    for (let k = 0; cur && k < 40; k++) {
      if (cur.owner !== this.me || cur.station >= 0 || cur.depot >= 0 || g.stations.throughStationOf(cur.id) >= 0) break;
      chain.push(cur.id);
      len += cur.len;
      const o = cur.a === at ? cur.b : cur.a, on = net.nodes.get(o);
      if (!on || on.edges.length !== 2) break;
      const nx = net.edges.get(on.edges[0] === cur.id ? on.edges[1] : on.edges[0]);
      at = o;
      cur = nx;
    }
    if (!chain.length || len > maxLen) return 0;
    const b = busy ?? this.busyEdges();
    if (chain.some((id) => b.has(id))) return 0;
    removeEdges(g, chain, this.me);
    this.bump('stubs', Math.round(len));
    return len;
  }

  // ================================================================ lines: one line per route (9k)
  private *linesTask(ids: number[]): Generator<void, void> {
    const g = this.g, me = this.me;
    if (!PAT.canonicalizeLines || !PAT.subsetOf) return;
    const todo = new Set<number>();
    for (const l of this.selected(g.lines.map.values(), ids)) {
      const sup = PAT.subsetOf(g, l);
      if (sup && (l.owner === me || sup.owner === me)) todo.add(l.owner === me ? l.id : sup.id);
    }
    yield;
    for (const id of todo) {
      if (!g.lines.map.has(id)) continue;
      this.canon(id);
      yield;
    }
  }

  // ================================================================ decommissioning (9k)
  /** Days a line has run (the controller's opening day, else its oldest vehicle). */
  private lineAge(l: Line): number {
    const info = this.managed()?.get(l.id);
    if (info && typeof info.opened === 'number') return this.g.day - info.opened;
    let age = 0;
    for (const vid of l.vehicles) { const v = this.g.vehicles.get(vid); if (v) age = Math.max(age, v.age * 360); }
    return age;
  }

  /** Yearly upkeep of the line's own infrastructure, shared with the other lines using it (stations; track between consecutive stops). */
  private infraCost(l: Line): number {
    const g = this.g, net = g.world.net, me = this.me;
    const gm = g as unknown as { stationMaintenance?: (st: Station) => number; edgeMaintenance?: (e: NEdge) => number };
    let c = 0;
    for (const sid of new Set(l.stops)) {
      const st = g.stations.get(sid);
      if (!st || st.owner !== me || !gm.stationMaintenance) continue;
      c += gm.stationMaintenance.call(g, st) / Math.max(1, this.linesAt(sid).length);
    }
    if (l.kind === 'rail' && gm.edgeMaintenance) for (const [a, b] of this.pairsOf(l)) {
      const r = this.route(a, b, l.owner);
      if (!r) continue;
      let m = 0;
      for (const id of r) { const e = net.edges.get(id); if (e && e.owner === me && e.station < 0) m += gm.edgeMaintenance.call(g, e); }
      let n = 0;
      for (const o of g.lines.map.values()) if (o.kind === 'rail' && o.stops.includes(a) && o.stops.includes(b)) n++;
      c += m / Math.max(1, n);
    }
    return c;
  }

  private *decommissionTask(ids: number[]): Generator<void, void> {
    const g = this.g, me = this.me;
    const months = g.month;
    const lines = this.selected(g.lines.map.values(), ids).sort((a, b) => this.ai.railPolicy.lossOrder(a.id, b.id));
    for (const l of lines) {
      if (l.owner !== me || !g.lines.map.has(l.id) || l.kind === 'tram' || l.stops.length < 2) continue;
      const f = this.fleet(l);
      if (l.kind === 'rail') {
        if (this.ai.railPolicy.review(l) && !f.others) {
          const s = this.ai.railPolicy.account(l);
          if (!this.joinNeighbour(l)) this.closeLine(l, `${s.lossYears} consecutive losing years after service cuts; ${Math.round(-s.lastProfit / 1000)}k lost a year`);
        }
        yield; continue;
      }
      if (months < 6) continue;
      // partners run it too: they keep it going (and pay their share)
      if (f.others || !f.ours.length) { this.considered('decommission.partnerOrEmpty'); continue; }
      if (this.lineAge(l) < 720) { this.considered('decommission.young'); continue; }
      if (this.cared('dec' + l.id)) continue;
      this.considered('decommission.mature');
      // cheap test first: the vehicles alone lose money both years
      const lastV = l.incomeLast - l.costLast, curV = ((l.incomeYear - l.costYear) * 12) / Math.max(1, months);
      if (lastV > 400_000 && curV > 400_000) continue;
      const infra = this.infraCost(l);
      yield;
      const last = lastV - infra, cur = curV - infra;
      if (!(last < 0 && cur < 0)) { this.considered('decommission.healthy'); this.careFor('dec' + l.id, 90); continue; }
      // a fix first: run through with a neighbouring line of ours (one through line instead of two)
      this.closeLine(l, `${Math.round(-last / 1000)}k lost last year, ${Math.round(-cur / 1000)}k a year now`);
      yield;
    }

  }

  /**
   * A loss-making line ending where another line of ours ends: the two become one through line (the other's
   * path extended; the vehicles move over). True when done.
   */
  private joinNeighbour(l: Line): boolean {
    const g = this.g, me = this.me;
    if (this.cared('join' + l.id)) return false;
    this.careFor('join' + l.id, 720);
    const path = this.pathOf(l);
    if (!path) return false;
    for (const m of g.lines.map.values()) {
      if (m === l || m.owner !== me || m.kind !== l.kind || this.fleet(m).others || (m.operators?.length ?? 0) > 0) continue;
      const pm = this.pathOf(m);
      if (!pm) continue;
      let np: number[] | null = null;
      if (pm[pm.length - 1] === path[0]) np = [...pm, ...path.slice(1)];
      else if (pm[pm.length - 1] === path[path.length - 1]) np = [...pm, ...path.slice(0, -1).reverse()];
      else if (pm[0] === path[path.length - 1]) np = [...path, ...pm.slice(1)];
      else if (pm[0] === path[0]) np = [...path.slice(1).reverse(), ...pm];
      if (!np || new Set(np).size !== np.length || np.length > 7) continue;
      const moved = this.fleet(l).ours;
      this.setStops(m, outAndBack(np));
      for (const vid of moved) g.vehicles.get(vid)?.setLine(m.id);
      g.lines.delete(l.id);
      this.forget(l.id);
      const info = this.managed()?.get(m.id);
      if (info) { info.maxVehicles = Math.max(info.maxVehicles, m.vehicles.length); info.towns = [...new Set(np.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))]; }
      this.signal(m.id);
      this.careFor('dec' + m.id, 720);
      this.canon(m.id);
      this.bump('netJoined');
      this.note(`${l.name} lost money: runs on as part of ${m.name}`);
      this.news(`merges ${l.name} into ${m.name} (through trains).`);
      return true;
    }
    return false;
  }

  /** Close a route: our vehicles sold, the line deleted, its stations left for the unused-infrastructure sweep. */
  private closeLine(l: Line, why: string) {
    const g = this.g;
    if (l.kind === 'rail') {
      if (!this.ai.railPolicy.canClose(l)) return;
      this.ai.railPolicy.event(l, 'closed', why);
    }
    const stops = [...new Set(l.stops)];
    for (const vid of this.fleet(l).ours) g.vehicles.sell(vid);
    const name = l.name;
    g.lines.delete(l.id);
    this.forget(l.id);
    for (const sid of stops) if (g.stations.get(sid)?.owner === this.me && !this.linesAt(sid).length) this.retire.set('st' + sid, g.day + 180);
    this.bump('netDecommissioned');
    this.note(`closed ${name} (${why})`);
    const st = g.stations.get(stops[0]);
    this.news(`closes ${name}: the route did not pay.`, st?.x, st?.z);
  }

  /**
   * Infrastructure of ours nobody uses, taken up after a grace period: stations no line (of any company) stops
   * at, depots no vehicle belongs to, and track with no station, depot or other company's track attached.
   */
  private *retireUnused(item?: WorkItem): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const due = (k: string, wait: number): boolean => {
      const d = this.retire.get(k);
      if (d === undefined) { this.retire.set(k, g.day + wait); return false; }
      return d <= g.day;
    };
    for (const st of !item || item.retire === 'all' ? [...g.stations.map.values()] : item.retire === 'stations' ? this.selected(g.stations.map.values(), item.ids) : []) {
      if (st.owner !== me) continue;
      const k = 'st' + st.id;
      if (this.linesAt(st.id).length) { this.retire.delete(k); continue; }
      // (long unused: after a while; just left by a line: after its grace period)
      if (!due(k, g.day - st.built > 360 && g.day - st.lastPickup > 360 ? 60 : 360)) continue;
      const ends = st.rail ? g.stations.trackEnds(st, true).flatMap((t) => [t.front, t.back]) : [];
      const name = st.name;
      if (g.stations.removeStation(st.id)) continue;
      this.retire.delete(k);
      const busy = this.busyEdges();
      for (const nid of ends) this.takeUpStub(nid, 200, busy);
      this.bump('netRetired');
      this.note(`took up ${name} (no line stops there)`);
      yield;
    }
    // depots no vehicle of ours belongs to (and no line of ours buys at)
    const used = new Set<number>();
    for (const v of g.vehicles.map.values()) { const d = (v as unknown as { depotId?: number }).depotId; if (typeof d === 'number') used.add(d); }
    for (const info of this.managed()?.values() ?? []) used.add(info.depot);
    for (const d of !item || item.retire === 'all' ? [...g.depots.map.values()] : item.retire === 'depots' ? this.selected(g.depots.map.values(), item.ids) : []) {
      const k = 'dp' + d.id;
      if (d.owner !== me || used.has(d.id)) { this.retire.delete(k); continue; }
      if (!due(k, 360)) continue;
      const exit = d.node;
      if (g.depots.remove(d.id)) continue;
      this.retire.delete(k);
      this.takeUpStub(exit, 200);
      this.bump('netRetired');
      this.note('took up an unused depot');
      yield;
    }
    // own track nothing can use: no station, depot or other company's track attached to it
    const seen = new Set<number>();
    for (const e0 of !item || item.retire === 'track' || item.retire === 'all' ? [...net.edges.values()] : []) {
      if (e0.kind !== 'rail' || e0.owner !== me || seen.has(e0.id) || e0.station >= 0 || e0.depot >= 0) continue;
      const comp: number[] = [];
      let anchored = false;
      const queue = [e0.id];
      seen.add(e0.id);
      while (queue.length && comp.length < 4000) {
        const e = net.edges.get(queue.pop()!)!;
        comp.push(e.id);
        for (const nid of [e.a, e.b]) for (const id of net.nodes.get(nid)?.edges ?? []) {
          if (seen.has(id)) continue;
          const f = net.edges.get(id);
          if (!f || f.kind !== 'rail') continue;
          if (f.owner !== me || f.station >= 0 || f.depot >= 0 || g.stations.throughStationOf(f.id) >= 0) { anchored = true; continue; }
          seen.add(id);
          queue.push(id);
        }
      }
      const k = 'trk' + Math.min(...comp);
      if (anchored) { this.retire.delete(k); continue; }
      if (!due(k, 180)) continue;
      const busy = this.busyEdges();
      if (comp.some((id) => busy.has(id))) continue;
      const len = comp.reduce((s, id) => s + (net.edges.get(id)?.len ?? 0), 0);
      removeEdges(g, comp, me);
      this.retire.delete(k);
      this.bump('stubs', Math.round(len));
      this.note(`took up ${Math.round(len)} u of track no line uses`);
      yield;
    }
  }

  // ================================================================ station capacity and buildings (9f, 9m)
  /** Stations whose size changed lately (grown by ai.ts or here): left alone for a while. */
  private recentlyChanged(st: Station, days: number): boolean {
    const r = st.rail!;
    const key = `${r.tracks}/${r.through ?? 0}/${r.length}/${r.style ?? ''}/${r.level ?? 'ground'}`;
    const s = this.sizes.get(st.id);
    if (!s) { this.sizes.set(st.id, { key, day: -1e9 }); return false; }
    if (s.key !== key) { this.sizes.set(st.id, { key, day: this.g.day }); return true; }
    return this.g.day - s.day < days;
  }

  /**
   * Yearly revenue a station's building would add: residents its wider catchment (catchBonus) newly reaches
   * (outside every other rail station's circles), times the trips a resident makes a year and the fare the
   * station's lines take a trip.
   */
  private buildingValue(st: Station, style: string): number {
    const g = this.g, w = g.world, r = st.rail;
    if (!r) return 0;
    const b0 = styleOf(r.style).catchBonus ?? 0, b1 = styleOf(style).catchBonus ?? 0;
    if (!(b1 > b0)) return 0;
    // (one walking reach for every rail station, whatever its track type; half of it at an in-city metro / light-rail station)
    const k = railWalkScale(st);
    const shapes = (b: number) => (r.level ?? 'ground') === 'ground' ? railCatchShapes(r.x, r.z, r.angle, r.length, true, 'rail', b, k)
      : r.entrances.map((e) => ({ x: e.x, z: e.z, r: CATCHMENT_RADIUS.rail * (1 + b) * k, mode: 'rail' as const, active: true }));
    const inner = shapes(b0), outer = shapes(b1);
    const others = [...g.stations.map.values()].filter((o) => o !== st && o.rail && Math.hypot(o.x - st.x, o.z - st.z) < 160).flatMap((o) => g.stations.catchmentShapes(o, true));
    let extra = 0;
    const seen = new Set<number>();
    for (const c of outer) for (const id of w.bgrid.query(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r)) {
      if (seen.has(id)) continue;
      const b = w.buildings.get(id);
      if (!b || (b.x - c.x) ** 2 + (b.z - c.z) ** 2 > c.r * c.r) continue;
      seen.add(id);
      if (inner.some((q) => (b.x - q.x) ** 2 + (b.z - q.z) ** 2 <= q.r * q.r)) continue;
      if (others.some((q) => (b.x - q.x) ** 2 + (b.z - q.z) ** 2 <= q.r * q.r)) continue;
      extra += b.pop;
    }
    if (!extra) return 0;
    return extra * this.residentValue(st);
  }

  /** A footbridge can improve access without a larger radius. Count residents its planned entrances
   * newly reach, discount street detours and overlapping services, and keep an upkeep allowance. */
  private accessBuildingValue(st: Station, plan: StationPlan): number {
    const g = this.g, w = g.world;
    const current = new Set(g.stations.catchmentBuildings(st)), removed = new Set(plan.demolish);
    const shapes = g.stations.planCatchShapes(plan).filter((c) => c.active);
    // Merged road stops still give access to the platforms after a building change.
    for (const p of st.stops) shapes.push({ x: p.x, z: p.z, r: g.stations.catchmentRadius(st), mode: 'rail', active: true });
    const seen = new Set<number>();
    let pop = 0;
    for (const c of shapes) {
      for (const id of w.bgrid.query(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r)) {
        if (seen.has(id) || current.has(id) || removed.has(id)) continue;
        const b = w.buildings.get(id);
        if (!b || Math.hypot(b.x - c.x, b.z - c.z) > c.r) continue;
        seen.add(id);
        const others = g.stations.stationsForBuilding(id).st.filter((s) => s !== st.id && g.lines.stationServed(s)).length;
        pop += b.pop * 0.5 / (1 + others);
      }
    }
    // Relocating an entrance can also lose passengers: include those losses in the same value estimate.
    for (const id of current) {
      const b = w.buildings.get(id);
      if (!b || (!removed.has(id) && shapes.some((c) => Math.hypot(b.x - c.x, b.z - c.z) <= c.r))) continue;
      const others = g.stations.stationsForBuilding(id).st.filter((s) => s !== st.id && g.lines.stationServed(s)).length;
      pop -= b.pop / (1 + others);
    }
    return Math.max(0, pop * this.residentValue(st) - 5000);
  }

  /** Annual revenue per newly covered resident; observations already include the passenger calibration. */
  private residentValue(st: Station): number {
    const perRes = st.catchPop > 20 && st.pickupLast > 0 ? Math.min(6 * PASSENGER_RATE_SCALE, (12 * st.pickupLast) / st.catchPop) : 2 * PASSENGER_RATE_SCALE;
    let inc = 0, pax = 0;
    for (const l of this.linesAt(st.id)) { inc += l.incomeLast; pax += l.passLast * 12; }
    const fare = pax > 5 && inc > 0 ? Math.min(2000 / PASSENGER_RATE_SCALE, inc / pax) : 300 * PASSENGER_FARE_SCALE;
    // (arrivals: people living there come back by train too)
    return perRes * fare * 1.5;
  }

  /** Planned growth of a station (smaller steps when the full one does not fit); null when it cannot grow now. */
  private grow(st: Station, want: { tracks: number; through: number; length: number }, why: string, demolish = true): 'done' | 'busy' | 'no' {
    const g = this.g, r = st.rail!;
    if (!this.mayAlter([...r.edges, ...r.throughEdges, ...this.approachOf(st, 80)])) return 'no';
    const now0 = { tracks: r.tracks, through: r.through ?? 0, length: r.length };
    if (railPartMode(r) !== 'mainline') want = { ...now0, length: want.length };
    const same = (q: typeof now0) => q.tracks === now0.tracks && q.through === now0.through && q.length === now0.length;
    const steps = [{ ...want, tracks: Math.min(want.tracks, now0.tracks + 1) }, want, { ...want, through: now0.through },
      { ...now0, length: want.length }, { ...now0, tracks: Math.min(want.tracks, now0.tracks + 1) }]
      .filter((q, i, all) => !same(q) && all.findIndex((o) => o.tracks === q.tracks && o.through === q.through && o.length === q.length) === i);
    let graded = false;
    for (let i = 0; i < steps.length; i++) {
      const q = steps[i];
      let plan = planStationUpgrade(g, st.id, { ...q, side: 'auto' });
      // uneven ground beside the station: graded to the platform level once, then planned again (9i)
      // (not where nothing may be demolished: grading clears the ground)
      if (!plan.ok && demolish && !graded && /uneven/i.test(plan.error ?? '')) { graded = true; if (this.grade(st)) { plan = planStationUpgrade(g, st.id, { ...q, side: 'auto' }); } }
      if (!plan.ok) { this.considered('grow.site'); continue; }
      if (plan.plan && (demolish ? !this.demolitionOk(plan.plan.demolish) : plan.plan.demolish.length > 0)) continue;
      if (!this.canSpend(plan.cost * 1.2 + 300_000, 0.4)) { this.considered('grow.funds'); continue; }
      const dem = plan.plan ? [...plan.plan.demolish] : [];
      const err = commitStationUpgrade(g, plan);
      if (err === 'busy') return 'busy';
      if (err) continue;
      this.compensate(dem);
      for (const l of this.linesAt(st.id)) if (l.owner === this.me && l.kind === 'rail') this.signal(l.id);
      this.bump('grown');
      const what = [q.tracks !== now0.tracks ? `${q.tracks} platform tracks` : '', q.through !== now0.through ? `${q.through} through tracks` : '', q.length !== now0.length ? `${Math.round(q.length * 10)} m platforms` : ''].filter(Boolean).join(', ');
      this.note(`rebuilt ${st.name}: ${what} (${why})`);
      this.news(`rebuilds ${st.name} station: ${what}.`, st.x, st.z);
      this.recentlyChanged(st, 0);
      return 'done';
    }
    return 'no';
  }

  /** Grade the ground on both sides of a ground station to its formation (station growth on a slope). */
  private grade(st: Station): boolean {
    const g = this.g, r = st.rail!;
    if ((r.level ?? 'ground') !== 'ground') return false;
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const half = (r.width || 1.6) / 2;
    let cost = 0;
    const spots: { x: number; z: number }[] = [];
    for (const side of [1, -1]) for (let a = -r.length / 2; a <= r.length / 2 + 1e-6; a += 2.5) for (const off of [half + 0.9, half + 2.2]) {
      spots.push({ x: r.x + fx * a + rx * off * side, z: r.z + fz * a + rz * off * side });
    }
    if (!this.canSpend(spots.length * 6000, 0.1)) return false;
    for (const p of spots) {
      if (!g.world.inside(p.x, p.z, 3)) continue;
      const res = terraformBrush(g, p.x, p.z, 1.4, 'level', r.y - 0.1, this.me);
      if (res.error) break;
      cost += res.cost;
    }
    if (cost > 0) { this.bump('netGraded'); this.note(`graded the ground beside ${st.name}`); }
    return cost > 0;
  }

  private *capacityTask(item: WorkItem): Generator<void, void> {
    const g = this.g, me = this.me;
    const waits = platformWaits(g, 30);
    const stations = this.selected(g.stations.map.values(), item.ids).filter((s) => s.owner === me && s.rail);
    if (!stations.length) { delete item.style; delete item.entrance; return; }
    let grown = this.job?.done ?? 0;
    for (const st of stations) {
      if (item.style) {
        // (a style valued in full that did not rebuild the station: an extra entrance next, one change per pass)
        if (!this.restyle(st, g.stations.capacity(st.id)?.terminus ?? false, item) && !item.style) this.entranceNext(st, item);
        yield;
        continue;
      }
      if (item.entrance) { this.entrance(st, item); yield; continue; }
      if (!g.stations.get(st.id)?.rail || this.cared('cap' + st.id)) continue;
      if (this.recentlyChanged(st, 90)) continue;
      const r = st.rail!, cap = g.stations.capacity(st.id);
      if (!cap) continue;
      const lines = this.linesAt(st.id);
      // ai.ts also grows its managed lines; the size cooldown prevents duplicate work here.
      const mainline = railPartMode(r) === 'mainline';
      let want: { tracks: number; through: number; length: number } | null = null, why = '';
      if (cap.recommended) { want = { ...cap.recommended }; why = cap.reason; }
      // trains of any company held for a platform here
      const w = waits.get(st.id);
      if (w && w.trains >= 1 && mainline && r.tracks < 8) { want = { tracks: Math.max(want?.tracks ?? 0, Math.min(8, r.tracks + Math.min(2, w.trains))), through: want?.through ?? r.through ?? 0, length: want?.length ?? r.length }; why = `${w.trains} trains waiting for a platform`; }
      // junctions: lines of two operators meeting (through services), or a hub of three lines or more
      const ops = new Set<number>();
      for (const l of lines) { ops.add(l.owner); for (const o of l.operators ?? []) ops.add(o); }
      if (mainline && r.tracks < 3 && (ops.size >= 2 || lines.length >= 3)) {
        const t = lines.length >= 4 ? 4 : 3;
        want = { tracks: Math.max(want?.tracks ?? 0, t), through: want?.through ?? r.through ?? 0, length: want?.length ?? r.length };
        why = ops.size >= 2 ? `junction of ${ops.size} operators` : `${lines.length} lines`;
      }
      if (want && grown < 2) {
        this.considered('grow.needed');
        const res = this.grow(st, want, why);
        if (res === 'done') grown++;
        this.careFor('cap' + st.id, res === 'busy' ? 20 : res === 'done' ? 90 : 360);
        if (res === 'busy') {
          this.considered('grow.busy');
          // One retry within the primitive's 30-day possession; repeated weekly possessions impede
          // service, so limit this extra attempt to once per station in three months.
          if (!this.cared('capRetry' + st.id)) {
            this.careFor('capRetry' + st.id, 90); this.careFor('cap' + st.id, 10);
            this.next.set('capacity', Math.min(this.next.get('capacity') ?? Infinity, g.day + 12));
          }
        }
        // A blocked throat need not prevent a worthwhile building upgrade on the existing platforms, nor an extra
        // entrance (one change per station per pass: the entrance is valued after a restyle that did not rebuild).
        if (res !== 'done') this.nextChange(st, item);
        yield;
        continue;
      }
      if (!want) this.considered('grow.enoughRoom');
      // a station building where its wider catchment pays for it (9m), halts stay halts; else an extra entrance where
      // the residents it newly reaches pay for it (one change per station per pass)
      if (this.nextChange(st, item)) yield;
    }
  }

  /**
   * The station's next building change this pass, valued over the coming work units (its cursor saved in the work
   * item): a new building style when its cooldown allows, else an extra entrance. False when neither is due.
   */
  private nextChange(st: Station, item: WorkItem): boolean {
    if (!this.cared('sty' + st.id)) { item.style = { at: 0 }; return true; }
    return this.entranceNext(st, item);
  }

  /** An extra entrance for the station, valued next (its cooldown allowing). */
  private entranceNext(st: Station, item: WorkItem): boolean {
    if (this.cared('ent' + st.id) || !this.g.stations.get(st.id)?.rail) return false;
    item.entrance = { at: 0 };
    return true;
  }

  /**
   * Upgrade a station's building when the catchment it adds pays for it within a few years (or take a useless one
   * down at a quiet halt). True when rebuilt.
   */
  private restyle(st: Station, terminus: boolean, item: WorkItem): boolean {
    const g = this.g, r = st.rail!;
    if (!this.mayAlter([...r.edges, ...r.throughEdges])) { delete item.style; return false; }
    const mode = railPartMode(r), T = g.towns.list[st.townId], pop = T?.pop ?? 0;
    const cur = styleOf(r.style).id;
    const avail = new Set(stylesFor(r.level ?? 'ground', r.tracks, g.year).map((s) => s.id));
    const cands: string[] = [];
    const base = defaultStationStyle(g.year, Math.max(2, r.tracks), r.level ?? 'ground', mode, Math.max(pop, 1500));
    if (base !== 'none' && base !== 'shelter') cands.push(base);
    if (terminus && r.tracks >= 4 && pop >= 5000) cands.push('terminal');
    // A second entrance across the tracks also helps a small town's poorly reached station. Requiring
    // a larger catchment bonus used to suppress this even when its present entrance reached nobody.
    if (r.tracks >= 2 && (pop >= 6000 || (st.catchPop < pop * 0.2 && this.linesAt(st.id).some((l) => this.fleet(l).ours.length)))) cands.push('concourse');
    cands.push('modern', 'classic');
    const years = 5 + 5 * this.ai.config.risk;
    const cursor = item.style ??= { at: 0 }, choices = [...new Set(cands)];
    for (const s of choices.slice(cursor.at, cursor.at + 1)) {
      if (s === cur || !avail.has(s) || (s !== 'concourse' && (styleOf(s).catchBonus ?? 0) <= (styleOf(cur).catchBonus ?? 0))) continue;
      const plan = planStationUpgrade(g, st.id, { style: s });
      if (!plan.ok || (plan.plan && !this.demolitionOk(plan.plan.demolish))) continue;
      const annual = Math.max(this.buildingValue(st, s), s === 'concourse' && plan.plan ? this.accessBuildingValue(st, plan.plan) : 0);
      const gain = annual * years - plan.cost;
      if (gain > 0 && (!cursor.best || gain > cursor.best.gain)) cursor.best = { style: s, gain };
    }
    // Only a style id and its value survive the tick. Re-plan and re-value the winner in today's world.
    if (cursor.at < choices.length) { cursor.at++; return false; }
    const best = cursor.best;
    delete item.style;
    this.careFor('sty' + st.id, 360);
    if (!best || best.style === cur || !avail.has(best.style)) return false;
    const plan = planStationUpgrade(g, st.id, { style: best.style });
    if (!plan.ok || (plan.plan && !this.demolitionOk(plan.plan.demolish))) return false;
    const annual = Math.max(this.buildingValue(st, best.style), best.style === 'concourse' && plan.plan ? this.accessBuildingValue(st, plan.plan) : 0);
    if (annual * years <= plan.cost || !this.canSpend(plan.cost, 0.15)) return false;
    const dem = plan.plan ? [...plan.plan.demolish] : [];
    const err = commitStationUpgrade(g, plan);
    if (err) { if (err === 'busy') this.careFor('sty' + st.id, 10); return false; }
    this.compensate(dem);
    this.bump('netRestyled');
    this.note(`${st.name}: ${styleOf(best.style).name.toLowerCase()} (its catchment pays for it)`);
    this.recentlyChanged(st, 0);
    return true;
  }

  /**
   * An extra entrance where the residents it newly brings within walking reach pay for it within a few years, as a
   * station building does (restyle): at a ground station a footbridge or underpass to both sides of the tracks, a
   * side hall or a platform-end gate (with an access street where no road passes), else a pavilion / stair tower
   * beside a street. Valued over work units as a restyle is: each unit values the next ENTRANCE_VALUATIONS candidate
   * places in their fixed order (a street still to be built: estimated from the nearest road), and only the best
   * one's kind, point and value survive the tick (item.entrance, saved with the job). The unit after the last plans
   * the winner in full in today's world (with its access street), values it again and builds it. Once a year per
   * station at most (cooldown 'ent<id>', saved with the planner); residents summed by building id. True when built.
   */
  private entrance(st: Station, item: WorkItem): boolean {
    const g = this.g, r = st.rail;
    const cursor = item.entrance ??= { at: 0 };
    const finish = (why?: string) => { delete item.entrance; this.careFor('ent' + st.id, 360); if (why) this.considered(why); return false; };
    if (!r) return finish();
    // one change per station a year: none within a year of its last rebuild or new building
    if (r.entrances.length >= ENTRANCE_MAX || this.recentlyChanged(st, 360)) return finish();
    if (!this.linesAt(st.id).some((l) => this.fleet(l).ours.length)) return finish('ent.unserved');
    const covered = walkingCatchment(g, st).buildings;
    const perRes = this.residentValue(st), years = 5 + 5 * this.ai.config.risk;
    /**
     * residents a catchment newly brings to this station, counted as the share-out counts them (Stations.computeShares):
     * beyond FULL_COVER_WALK only partly (fewer walk that far), shared with the other served stations reaching them
     */
    const newly = (walk: WalkingCatchment) => {
      let pop = 0;
      for (const [id, at] of [...walk.buildings].sort((a, b) => a[0] - b[0])) {
        if (covered.has(id)) continue;
        const b = g.world.buildings.get(id);
        if (!b || b.pop <= 0) continue;
        const weight = walkWeight(at.distance);
        let sum = weight, best = weight;
        for (const sid of g.stations.stationsForBuilding(id).st) {
          if (sid === st.id || !g.lines.stationServed(sid)) continue;
          const other = g.stations.get(sid), reach = other && walkingCatchment(g, other).buildings.get(id);
          if (!reach) continue;
          const w = walkWeight(reach.distance); sum += w; best = Math.max(best, w);
        }
        pop += b.pop * weight / sum * coverOf(best);
      }
      return pop;
    };
    const gain = (pop: number, kind: EntranceKind, outlay: number) => (pop * perRes - ENTRANCE_TYPES[kind].upkeep) * years - outlay;
    const spots = this.entranceSpots(st);
    if (cursor.at < spots.length) {
      // the next candidate places (those that fit: each valued by the walking catchment it would add)
      for (let n = 0; cursor.at < spots.length && n < ENTRANCE_VALUATIONS;) {
        const spot = spots[cursor.at++];
        let pl = g.stations.planEntrance(st.id, spot.x, spot.z, this.me, spot.kind, { street: false });
        if (!pl.entrance && spot.alt) pl = g.stations.planEntrance(st.id, spot.x, spot.z, this.me, spot.alt, { street: false });
        if (!pl.entrance) continue;
        let walk: WalkingCatchment, outlay = pl.cost;
        if (pl.ok) walk = entrancePlanCatchment(g, st, pl);
        else if (pl.door) {
          // a street still to be built: from the door to the nearest road on its side, a little longer than straight
          const q = g.stations.sideRoad(st.id, pl.door.x, pl.door.z, entranceSide(r, pl.entrance), 12);
          if (!q) continue;
          walk = extraAccessCatchment(g, st, [{ x: q.x, z: q.z, reach: 0.3, leg: q.d * 1.3 }]);
          outlay += q.d * 1.3 * (ROAD_TYPES.street?.costPerUnit ?? 3500) + 20_000;
        } else continue;
        n++;
        const v = gain(newly(walk), pl.kind, outlay);
        if (v > 0 && (!cursor.best || v > cursor.best.gain)) cursor.best = { kind: pl.kind, x: spot.x, z: spot.z, gain: v };
      }
      return false;
    }
    // Only the winner's kind, point and value survive the tick: planned in full in today's world and valued again.
    const best = cursor.best;
    finish();
    if (!best) { this.considered('ent.none'); return false; }
    const plan = g.stations.planEntrance(st.id, best.x, best.z, this.me, best.kind);
    if (!plan.ok || (plan.access && !this.safeRoadPlan(plan.access))) { this.considered('ent.street'); return false; }
    /** residents of the station lost with the buildings an access street demolishes (they are no forecast gain either) */
    let lost = 0;
    for (const id of [...(plan.access?.demolish ?? [])].sort((a, b) => a - b)) {
      const b = g.world.buildings.get(id);
      if (!b || !covered.has(id)) continue;
      // (the station's share of them now, partial coverage included; before the next share-out an equal split)
      const sf = g.stations.stationsForBuilding(id), k = sf.st.indexOf(st.id);
      lost += k >= 0 ? b.pop * sf.w[k] : b.pop / (1 + sf.st.filter((s) => s !== st.id && g.lines.stationServed(s)).length);
    }
    // (the forecast leaves out what its street demolishes; residents the station reaches there are lost)
    const pop = newly(entrancePlanCatchment(g, st, plan)) - lost;
    const outlay = plan.access ? plan.cost - plan.access.cost + this.roadOutlay(plan.access) : plan.cost;
    if (gain(pop, plan.kind, outlay) <= 0) { this.considered('ent.street'); return false; }
    if (!this.canSpend(plan.cost, 0.15)) { this.considered('ent.funds'); return false; }
    const dem = plan.access ? [...plan.access.demolish] : [];
    // their residents before they go (building the entrance demolishes them: compensation reads these)
    const residents = dem.map((id) => g.world.buildings.get(id)).filter((b): b is NonNullable<typeof b> => !!b).map((b) => ({ townId: b.townId, pop: b.pop }));
    if (g.stations.commitEntrance(st.id, plan, this.me)) return false;
    this.compensate(dem, residents);
    this.bump('netEntrances');
    this.careFor('sty' + st.id, 360);
    this.note(`${st.name}: ${ENTRANCE_TYPES[plan.kind].name.toLowerCase()} (${Math.round(pop)} residents newly within walking reach)`);
    return true;
  }

  /** Candidate places for an extra entrance, in a fixed order (kind, a point to plan it near; `alt`: the kind to try where it does not fit). */
  private entranceSpots(st: Station): { kind?: EntranceKind; alt?: EntranceKind; x: number; z: number }[] {
    const g = this.g, r = st.rail!, net = g.world.net;
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx, L = r.length, half = railWidth(r) / 2 + 1;
    const at = (side: number, a: number) => ({ x: r.x + rx * side * half + fx * a, z: r.z + rz * side * half + fz * a });
    if ((r.level ?? 'ground') === 'ground') {
      const out: { kind?: EntranceKind; alt?: EntranceKind; x: number; z: number }[] = [];
      for (const a of L >= 6 ? [0, -0.3 * L, 0.3 * L] : [0]) for (const side of [1, -1]) {
        out.push({ kind: 'footbridge', alt: 'underpass', ...at(side, a) }, { kind: 'hall', ...at(side, a) });
      }
      for (const end of [1, -1]) for (const side of [1, -1]) out.push({ kind: 'gate', ...at(side, end * L / 2) });
      return out;
    }
    // below / above the street: beside the streets around the platforms, far from the entrances it has
    const fp = g.stations.platformRect(st)!, R = L / 2 + 16;
    const pts: { x: number; z: number; d: number }[] = [];
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    for (const e of net.edgesNear(r.x - R, r.z - R, r.x + R, r.z + R)) {
      if (!pedestrianRoad(e)) continue;
      for (let s = 2; s < e.len - 2; s += 5) {
        net.pointAt(e, s, p, d);
        if (distToRect(p.x, p.z, fp.x, fp.z, fp.angle, fp.w / 2, fp.d / 2) > 14) continue;
        const l = Math.hypot(d.x, d.z) || 1, off = net.halfWidth(e) + 0.5;
        for (const sd of [1, -1]) {
          const x = p.x - (d.z / l) * off * sd, z = p.z + (d.x / l) * off * sd;
          pts.push({ x, z, d: r.entrances.reduce((m, q) => Math.min(m, Math.hypot(q.x - x, q.z - z)), Infinity) });
        }
      }
    }
    pts.sort((a, b) => b.d - a.d || a.x - b.x || a.z - b.z);
    const out: { x: number; z: number }[] = [];
    for (const q of pts) {
      if (q.d < 6 || out.length >= 8) break;
      if (out.every((o) => Math.hypot(o.x - q.x, o.z - q.z) >= 5)) out.push({ x: q.x, z: q.z });
    }
    return out;
  }

  // ================================================================ pairing single tracks (9g)
  private turnbackStations(): Set<number> {
    const out = new Set<number>();
    for (const l of this.g.lines.map.values()) if (l.kind === 'rail') for (const p of Patterns.linePatterns(l))
      for (const i of Patterns.patternTermini(l, p.id)) out.add(l.stops[i]);
    return out;
  }

  /** Straight continuations on each strand, including passage through platforms and past junctions. */
  private plainChain(e: NEdge, cap = 60): number[] {
    const g = this.g, net = g.world.net, out = [e.id], turns = this.turnbackStations();
    for (const start of [e.a, e.b]) {
      let at = start, cur: NEdge = e;
      for (let k = 0; k < cap; k++) {
        const n = net.nodes.get(at);
        if (!n) break;
        const incoming = net.leaveDir(cur, at);
        const candidates = n.edges.filter((id) => id !== cur.id && !out.includes(id)).map((id) => net.edges.get(id))
          .filter((nx): nx is NEdge => !!nx && nx.kind === 'rail' && nx.depot < 0 && this.agrees(nx.owner))
          // Keep a turning station at the end of the work: the primitive's end crossovers are mandatory.
          .filter((nx) => nx.station < 0 || (!turns.has(nx.station) && (g.stations.get(nx.station)?.rail?.tracks ?? 0) >= 2))
          .map((nx) => ({ nx, dot: -(net.leaveDir(nx, at).x * incoming.x + net.leaveDir(nx, at).z * incoming.z) }))
          .filter((q) => q.dot > 0.97).sort((a, b) => b.dot - a.dot || a.nx.id - b.nx.id);
        const nx = candidates[0]?.nx;
        if (!nx) break;
        out.push(nx.id);
        at = nx.a === at ? nx.b : nx.a;
        cur = nx;
      }
    }
    return out.filter((id) => { const e = net.edges.get(id)!; return e.station < 0 && g.stations.throughStationOf(id) < 0; });
  }

  /** Own plain single tracks running side by side (0.3-1.7 apart, parallel, 15+ units): edge pairs with the length. */
  private *sideBySide(): Generator<void, { a: number; b: number; len: number }[]> {
    const g = this.g, net = g.world.net;
    const C = 4, cells = new Map<number, number[]>(), key = (x: number, z: number) => Math.floor(x / C) * 65536 + Math.floor(z / C);
    const P: { e: number; x: number; z: number; tx: number; tz: number }[] = [];
    let work = 0;
    for (const e of net.edges.values()) {
      if (e.kind !== 'rail' || !this.agrees(e.owner) || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) continue;
      const geo = net.geo(e);
      let last = -Infinity;
      for (let i = 0; i < geo.n; i++) {
        if (geo.cum[i] - last < 1 && i < geo.n - 1) continue;
        last = geo.cum[i];
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2], k = key(x, z);
        let a = cells.get(k);
        if (!a) cells.set(k, a = []);
        a.push(P.length);
        P.push({ e: e.id, x, z, tx: geo.tan[i * 2], tz: geo.tan[i * 2 + 1] });
        if (++work % 256 === 0) yield;
      }
    }
    const len = new Map<string, number>();
    work = 0;
    for (const p of P) {
      if (++work % 128 === 0) yield;
      for (let cx = Math.floor((p.x - 2) / C); cx <= Math.floor((p.x + 2) / C); cx++) for (let cz = Math.floor((p.z - 2) / C); cz <= Math.floor((p.z + 2) / C); cz++) {
        for (const i of cells.get(cx * 65536 + cz) ?? []) {
          const q = P[i];
          if (q.e <= p.e || Math.abs(q.tx * p.tx + q.tz * p.tz) < 0.97) continue;
          const dx = q.x - p.x, dz = q.z - p.z, along = Math.abs(dx * p.tx + dz * p.tz), off = Math.abs(dx * p.tz - dz * p.tx);
          if (along > 0.55 || off < 0.3 || off > 1.7) continue;
          const k = `${p.e}:${q.e}`;
          len.set(k, (len.get(k) ?? 0) + 1);
        }
      }
    }
    // per pair of plain chains (an edge pair is one piece of a stretch)
    const chainOf = new Map<number, number>(), chains: number[][] = [];
    const chainId = (id: number) => {
      let c = chainOf.get(id);
      if (c !== undefined) return c;
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail' || !this.agrees(e.owner) || e.station >= 0 || e.depot >= 0) return -1;
      const ch = this.plainChain(e);
      c = chains.length;
      chains.push(ch);
      for (const x of ch) chainOf.set(x, c);
      return c;
    };
    const agg = new Map<string, { a: number; b: number; len: number }>();
    for (const [k, n] of len) {
      const [ea, eb] = k.split(':').map(Number);
      const ca = chainId(ea), cb = chainId(eb);
      if (ca < 0 || cb < 0 || ca === cb) continue;
      const kk = ca < cb ? `${ca}:${cb}` : `${cb}:${ca}`;
      const o = agg.get(kk);
      if (o) o.len += n; else agg.set(kk, { a: ea, b: eb, len: n });
    }
    return [...agg.values()].filter((p) => p.len >= 15).sort((p, q) => q.len - p.len);
  }

  /** The primitive accepts one owner. Apply jointly authorised works synchronously and restore all titles,
   * including descendants of split edges. New crossovers belong to the company paying for the work. */
  private pairTracks(A: number[], B: number[]): FinishLike {
    const g = this.g, net = g.world.net, owners = new Map<number, number>(), nodes = new Map<number, number>(), stations = new Map<number, number>();
    const set = new Set([...A, ...B]);
    for (const st of g.stations.map.values()) if (st.rail && this.agrees(st.owner)
      && st.rail.edges.some((id) => { const e = net.edges.get(id); return e && [e.a, e.b].some((n) => net.nodes.get(n)?.edges.some((x) => set.has(x))); })) {
      stations.set(st.id, st.owner);
      for (const id of [...st.rail.edges, ...st.rail.throughEdges]) set.add(id);
    }
    for (const id of set) {
      const e = net.edges.get(id);
      if (!e || !this.agrees(e.owner)) return { signals: 0, crossovers: 0, cost: 0, error: 'Joint track works need mutual open access' };
      if ([e.a, e.b].some((id) => !this.agrees(net.nodes.get(id)!.owner))) return { signals: 0, crossovers: 0, cost: 0, error: 'Junction owner has not agreed to joint works' };
      owners.set(id, e.owner);
    }
    for (const id of set) {
      const e = net.edges.get(id)!;
      for (const nid of [e.a, e.b]) { const n = net.nodes.get(nid)!; if (!nodes.has(nid)) nodes.set(nid, n.owner); n.owner = this.me; }
      e.owner = this.me;
    }
    for (const id of stations.keys()) g.stations.get(id)!.owner = this.me;
    const split = (old: NEdge, a: NEdge, b: NEdge) => {
      const owner = owners.get(old.id);
      if (owner === undefined) return;
      owners.set(a.id, owner); owners.set(b.id, owner);
      const n = a.a === old.a ? a.b : a.a;
      nodes.set(n, owner);
    };
    net.onSplit.push(split);
    try {
      const turnbackStations = this.turnbackStations();
      let ladder = 0;
      for (const id of stations.keys()) {
        const st = g.stations.get(id)!;
        const heads = g.stations.trackEnds(st, true).flatMap((t) => [t.front, t.back]);
        for (const eid of this.approachOf(st, 60)) {
          const e = net.edges.get(eid);
          if (!e || !set.has(eid)) continue;
          for (const nid of [e.a, e.b]) {
            const n = net.nodes.get(nid)!;
            if (n.edges.length < 3 || !n.edges.some((x) => !set.has(x) && !crossoverLeg(g, net.edges.get(x)!))) continue;
            const d = Math.min(...heads.map((h) => { const q = net.nodes.get(h)!; return Math.hypot(n.x - q.x, n.z - q.z); }));
            if (d < 60) ladder = Math.max(ladder, d);
          }
        }
      }
      return OPS.pairAsDoubleTrack!(g, A, B, this.me, { throatLength: ladder + 1.5, turnbackStations: [...turnbackStations] });
    }
    finally {
      net.onSplit.splice(net.onSplit.indexOf(split), 1);
      for (const [id, owner] of owners) { const e = net.edges.get(id); if (e) e.owner = owner; }
      for (const [id, owner] of nodes) { const n = net.nodes.get(id); if (n) n.owner = owner; }
      for (const [id, owner] of stations) { const st = g.stations.get(id); if (st) st.owner = owner; }
      net.version++; g.onNetworkChanged();
    }
  }

  /** Lines (any company) whose route between consecutive stops runs over these edges (routes are evaluated in the current world). */
  private linesOver(edges: Set<number>): number[] {
    const out: number[] = [];
    for (const l of this.g.lines.map.values()) {
      if (l.kind !== 'rail') continue;
      if (this.g.lines.operatorsOf(l).some((owner) => this.pairsOf(l).some(([a, b]) =>
        [this.route(a, b, owner), this.route(b, a, owner)].some((r) => r?.some((id) => edges.has(id)))))) out.push(l.id);
    }
    return out;
  }

  /** A turnback must work from the platform and direction reached by the arriving service, including
   * short-turn patterns and trains already at a platform. Starting afresh on any platform is insufficient. */
  private turnbacksRoute(ids: number[]): boolean {
    const g = this.g, net = g.world.net;
    for (const id of ids) {
      const l = g.lines.get(id);
      if (!l || l.kind !== 'rail') continue;
      for (const p of Patterns.linePatterns(l)) for (const idx of Patterns.patternTermini(l, p.id)) {
        const sid = l.stops[idx], next = l.stops[Patterns.nextStopIndex(l, p.id, idx)];
        let previous = sid;
        for (let k = 1; k < l.stops.length; k++) {
          const i = (idx - k + l.stops.length) % l.stops.length;
          if (p.stops[i] && l.stops[i] !== sid) { previous = l.stops[i]; break; }
        }
        const st = g.stations.get(previous);
        if (!st?.rail) continue;
        for (const owner of g.lines.operatorsOf(l)) {
          const arrivals: { edge: NEdge; dir: number }[] = [];
          for (const eid of st.rail.edges) {
            const e = net.edges.get(eid);
            if (!e) continue;
            for (const d of [1, -1]) {
              const r = findRailRoute(g, railNext(g, e, d, owner), sid, owner, -1, 15000);
              const last = r?.conts.at(-1);
              if (last) arrivals.push(last);
            }
          }
          for (const vid of l.vehicles) {
            const v = g.vehicles.get(vid) as Train | undefined;
            if (!v || v.owner !== owner || v.pattern !== p.id) continue;
            const seg = v.segs[v.headSeg], e = seg && net.edges.get(seg.e);
            if (e?.station === sid) arrivals.push({ edge: e, dir: seg.dir });
          }
          for (const arrival of arrivals) {
            const back = railNext(g, arrival.edge, -arrival.dir, owner, false, null, true);
            if (!findRailRoute(g, back, next, owner, -1, 15000)
              && !findRailRoute(g, railNext(g, arrival.edge, arrival.dir, owner), next, owner, -1, 15000)) return false;
          }
        }
      }
    }
    return true;
  }

  private *pairTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.pairAsDoubleTrack) return;
    const cands = [{ a: ids[0], b: ids[1], len: ids[2] }];
    yield;
    let done = this.job?.done ?? 0;
    for (const c of cands.slice(0, 8)) {
      if (done >= 2) break;
      const ea = net.edges.get(c.a), eb = net.edges.get(c.b);
      if (!ea || !eb) continue;
      const key = `pair${Math.min(c.a, c.b)}:${Math.max(c.a, c.b)}`;
      if (this.cared(key)) continue;
      if (ea.owner !== me && eb.owner !== me) continue;
      const ca = this.plainChain(ea), cb = this.plainChain(eb);
      const A = ca.filter((id) => !cb.includes(id)), B = cb.filter((id) => !ca.includes(id));
      if (!A.length || !B.length) continue;
      // A connection alone is not directional double track: platforms and ordinary junctions may connect
      // two single tracks. Only existing direction restrictions on both strands make this redundant.
      if (this.oneWayAround(ea) && this.oneWayAround(eb)) { this.careFor(key, 720); continue; }
      yield;
      const busy = this.busyEdges();
      if ([...A, ...B].some((id) => busy.has(id))) { this.careFor(key, 20); continue; }
      const lines = this.linesOver(new Set([...A, ...B]));
      yield;
      if (!lines.length || !this.linesRoute(lines)) continue;
      if (!this.canSpend(150_000, 0.3)) return;
      const signals = new Map([...net.nodes].map(([id, n]) => [id, { signal: n.signal, kind: n.signalKind, pass: n.signalPass }]));
      const money = this.eco.money;
      const built = this.builtEdges(() => {
        try { return this.pairTracks(A, B); }
        catch (e) { return { signals: 0, crossovers: 0, cost: 0, error: String((e as Error).message ?? e) }; }
      });
      const res = built.result;
      let failure = res.error;
      try {
        const depotsRoute = lines.every((id) => {
          const l = g.lines.get(id);
          return !l || l.vehicles.every((id) => {
            const v = g.vehicles.get(id) as Train | undefined, dp = v && g.depots.get(v.depotId);
            return !v || !dp || [...new Set(l.stops)].some((sid) => depotReaches(g, dp, sid, v.cars));
          });
        });
        if (!this.linesRoute(lines) || !depotsRoute || !this.turnbacksRoute(lines)) failure ||= 'a service cannot return from its arrival platform';
      } catch (e) { failure = String((e as Error).message ?? e); }
      if (failure) {
        // Automatic rollback has no removal fee. Replacement pieces of existing track remain two-way.
        for (const id of built.edges) net.removeEdge(id);
        for (const [id, n] of net.nodes) { const old = signals.get(id); n.signal = old?.signal ?? 0; n.signalKind = old?.kind; n.signalPass = old?.pass; }
        this.eco.spend(this.eco.money - money, 'construction', true);
        net.version++; g.onNetworkChanged();
        this.careFor(key, /busy|changed|consent|agreed|access/i.test(failure) ? 20 : 180);
        this.note(`could not pair two tracks: ${failure}; works refunded, tracks stay two-way`);
        continue;
      }
      if (!res.signals && !res.crossovers) continue;
      // pairAsDoubleTrack placed the directional blocks and platform starters; re-signalling each line
      // independently here would turn a shared strand back into two-way track.
      this.careFor(key, 720);
      this.bump('paired');
      done++;
      this.note(`paired two single tracks into a double track (${Math.round(c.len)} u side by side, ${res.crossovers} crossovers, ${res.signals} signals)`);
      yield;
    }
  }

  // ================================================================ crossovers at the stations (9k)
  private *crossoversTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const norm = OPS.normaliseCrossovers ?? OPS.normalizeCrossovers;
    if (!norm) return;
    const mid = midLineCrossovers(g, me);
    if (!mid.length) return;
    yield;
    // the lines whose double track has them: normalised as a whole (both tracks, between their stations)
    const legs = new Map<number, { x: number; z: number }>(mid.map((c) => [c.edge, c]));
    const near = new Set<number>();
    for (const id of legs.keys()) { const e = net.edges.get(id); if (e) for (const nid of [e.a, e.b]) for (const x of net.nodes.get(nid)?.edges ?? []) near.add(x); }
    for (const l of this.selected(g.lines.map.values(), ids)) {
      if (l.owner !== me || l.kind !== 'rail' || !g.lines.map.has(l.id)) continue;
      const E = new Set<number>();
      for (const [a, b] of this.pairsOf(l)) for (const r of [this.route(a, b), this.route(b, a)]) for (const id of r ?? []) { const e = net.edges.get(id); if (e && e.owner === me && e.station < 0) E.add(id); }
      yield;
      if (![...E].some((id) => near.has(id))) continue;
      for (const id of legs.keys()) E.add(id);
      for (const st of g.stations.map.values()) if (st.owner === me && st.rail
        && [...st.rail.edges, ...st.rail.throughEdges].some((id) => {
          const e = net.edges.get(id);
          return e && [e.a, e.b].some((n) => net.nodes.get(n)?.edges.some((x) => E.has(x)));
        })) for (const id of [...st.rail.edges, ...st.rail.throughEdges]) E.add(id);
      if (!this.mayAlter(E)) continue;
      const before = midLineCrossovers(g, me).length;
      const res = norm(g, [...E], me);
      const after = midLineCrossovers(g, me).length;
      if (!errorOf(res)) this.signal(l.id);
      if (after < before) { this.bump('netCrossovers', before - after); this.note(`${l.name}: crossovers moved to the stations (${before - after} taken out)`); }
      else if (errorOf(res)) this.note(`${l.name}: crossovers stay (${errorOf(res)})`);
      yield;
    }
  }

  // ================================================================ through connections at termini (9g)
  /** The first station along the track from edge e (at s, travelling dir), signals obeyed, within maxDist. */
  private stationAlong(e: NEdge, s: number, dir: 1 | -1, maxDist: number, skip: number): { station: number; dist: number } | null {
    const g = this.g, net = g.world.net;
    let cur = e, d: number = dir, dist = dir > 0 ? e.len - s : s;
    for (let k = 0; k < 80 && dist < maxDist; k++) {
      const conts = railNext(g, cur, d, this.me);
      if (!conts.length) return null;
      const geo = net.geo(cur), i = d > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * d, tz = geo.tan[i * 2 + 1] * d;
      const nid = d > 0 ? cur.b : cur.a;
      let best = conts[0], bd = -Infinity;
      for (const c of conts) { const ld = net.leaveDir(c.edge, nid), dot = ld.x * tx + ld.z * tz; if (dot > bd) { bd = dot; best = c; } }
      cur = best.edge; d = best.dir;
      const sid = cur.station >= 0 ? cur.station : g.stations.throughStationOf(cur.id);
      if (sid >= 0 && sid !== skip) return { station: sid, dist };
      dist += cur.len;
    }
    return null;
  }

  /** Does a track carry one-way signals around this edge (a directional double track)? */
  private oneWayAround(e: NEdge): boolean {
    const net = this.g.world.net;
    const nodes = new Set<number>([e.a, e.b]);
    for (const start of [e.a, e.b]) {
      let at = start, cur: NEdge = e;
      for (let k = 0; k < 12; k++) {
        const n = net.nodes.get(at);
        if (!n || n.edges.length !== 2) break;
        const nx = net.edges.get(n.edges[0] === cur.id ? n.edges[1] : n.edges[0]);
        if (!nx) break;
        at = nx.a === at ? nx.b : nx.a;
        nodes.add(at);
        cur = nx;
      }
    }
    for (const id of nodes) { const n = net.nodes.get(id); if (n && (n.signal === 2 || n.signal === 3) && !n.signalPass) return true; }
    return false;
  }

  /** Track reachable from a station's connected end within `reach` units (its own approach). */
  private approachOf(st: Station, reach: number): Set<number> {
    const g = this.g, net = g.world.net, out = new Set<number>();
    const own = new Set([...st.rail!.edges, ...st.rail!.throughEdges]);
    const queue: { n: number; d: number }[] = [];
    for (const t of g.stations.trackEnds(st, true)) for (const n of [t.front, t.back]) queue.push({ n, d: 0 });
    const best = new Map<number, number>();
    while (queue.length) {
      const { n, d } = queue.pop()!;
      for (const id of net.nodes.get(n)?.edges ?? []) {
        if (own.has(id)) continue;
        const e = net.edges.get(id);
        if (!e || e.kind !== 'rail') continue;
        out.add(id);
        const o = e.a === n ? e.b : e.a, nd = d + e.len;
        if (nd > reach || (best.get(o) ?? Infinity) <= nd) continue;
        best.set(o, nd);
        queue.push({ n: o, d: nd });
      }
    }
    return out;
  }

  /** A branch into directional double track needs the return track too; a crossover belongs at this junction. */
  private junctionCrossover(c: { x: number; z: number; e: NEdge; s: number; dir: 1 | -1 }): void {
    if (!OPS.planConnection || !OPS.commitConnection) return;
    const g = this.g, net = g.world.net, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(c.e, c.s, p, d);
    const len = Math.hypot(d.x, d.z) || 1, tx = d.x / len * c.dir, tz = d.z / len * c.dir;
    for (const ahead of [8, 14, 20]) {
      const x = c.x + tx * ahead, z = c.z + tz * ahead;
      const a = net.nearestEdge(x, z, 2, 'rail', (e) => e.station < 0 && e.depot < 0 && e.type === c.e.type
        && this.mayAlter([e.id]));
      if (!a) continue;
      net.pointAt(a.edge, a.s, p, d);
      const b = net.nearestEdge(p.x, p.z, 1.8, 'rail', (e) => e.id !== a.edge.id && e.station < 0 && e.depot < 0
        && e.type === a.edge.type && this.mayAlter([e.id]));
      if (!b || b.d < 0.25) continue;
      net.pointAt(b.edge, b.s, p, d);
      const dl = Math.hypot(d.x, d.z) || 1, dot = (d.x * tx + d.z * tz) / dl;
      if (Math.abs(dot) < 0.97) continue;
      const sb = b.s + (dot > 0 ? 8 : -8);
      if (sb < 1 || sb > b.edge.len - 1) continue;
      const plan = OPS.planConnection(g, a.edge.id, a.s, b.edge.id, sb, this.me, { search: 2 });
      if (!plan.ok || !this.eco.canAfford(plan.cost)) continue;
      if (!OPS.commitConnection(g, plan, { signals: false }).error) return;
    }
  }

  private midLines(): Line[] {
    return this.g.lines.all().filter((l) => l.kind === 'rail' && this.agrees(l.owner) && this.pathOf(l) && l.vehicles.length
      && l.stops.every((sid) => { const r = this.g.stations.get(sid)?.rail; return !r || railPartMode(r) === 'mainline'; }));
  }

  /** Directed plain-track pieces, retaining the stop interval for selecting the two far-end halves. */
  private lineLegs(l: Line): { edge: NEdge; dir: 1 | -1; leg: number }[] {
    const g = this.g, net = g.world.net, path = this.pathOf(l), out: ReturnType<NetPlanner['lineLegs']> = [];
    if (!path) return out;
    for (let i = 0; i + 1 < path.length; i++) {
      const st = g.stations.get(path[i]);
      let best: ReturnType<typeof findRailRoute> = null;
      for (const eid of st?.rail?.edges ?? []) {
        const e = net.edges.get(eid); if (!e) continue;
        for (const d of [1, -1]) {
          const r = findRailRoute(g, railNext(g, e, d, this.me), path[i + 1], this.me, -1, 15000);
          if (r && (!best || r.cost < best.cost)) best = r;
        }
      }
      if (!best) return [];
      for (const c of best.conts) if (c.edge.station < 0 && c.edge.depot < 0 && g.stations.throughStationOf(c.edge.id) < 0)
        out.push({ edge: c.edge, dir: c.dir as 1 | -1, leg: i });
    }
    return out;
  }

  /** Connecting curves between the interiors of two authorised routes, followed by a new through service. */
  private *midconnectTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const a = g.lines.map.get(ids[0]), b = g.lines.map.get(ids[1]);
    if (!a || !b || a.kind !== 'rail' || b.kind !== 'rail' || !this.agrees(a.owner) || !this.agrees(b.owner)) return;
    if (a.owner !== me && b.owner !== me || this.ai.railPolicy.deepTrouble) return;
    const key = `mid${a.id}:${b.id}`;
    if (this.cared(key)) return;
    this.careFor(key, 180);
    this.considered('midconnect.pair');
    if (lineCongestion(g, a.id).level || lineCongestion(g, b.id).level) { this.considered('midconnect.congestion'); return; }
    const pa = this.pathOf(a), pb = this.pathOf(b);
    if (!pa || !pb) return;
    if ([a, b].some((l) => !this.managed()?.get(l.id)?.double
      && !l.stops.some((sid) => (g.stations.get(sid)?.rail?.tracks ?? 0) >= 2))) {
      this.considered('midconnect.capacity'); return;
    }
    const A = this.lineLegs(a), B = this.lineLegs(b), bEdges = new Map(B.map((p) => [p.edge.id, p]));
    if (!A.length || !B.length) return;
    const q = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    const sites: { a: (typeof A)[number]; b: (typeof B)[number]; sa: number; sb: number; distance: number }[] = [];
    const seen = new Set<string>();
    for (const p of A.slice(0, 256)) {
      if (!this.mayAlter([p.edge.id]) || p.edge.len < 3 || railModeOf(p.edge.type) !== 'mainline') continue;
      for (const sa of [p.edge.len * 0.25, p.edge.len * 0.5, p.edge.len * 0.75]) {
        net.pointAt(p.edge, sa, q);
        for (const e of net.edgesNear(q.x - 90, q.z - 90, q.x + 90, q.z + 90)) {
          const r = bEdges.get(e.id);
          if (!r || e.id === p.edge.id || !this.mayAlter([e.id]) || e.len < 3 || railModeOf(e.type) !== 'mainline') continue;
          if (e.a === p.edge.a || e.a === p.edge.b || e.b === p.edge.a || e.b === p.edge.b) continue;
          for (const sb of [e.len * 0.25, e.len * 0.5, e.len * 0.75]) {
            net.pointAt(e, sb, d);
            const distance = Math.hypot(q.x - d.x, q.z - d.z);
            if (distance < 14 || distance > 90 || Math.abs(q.y - d.y) > distance * 0.035) continue;
            const k = `${p.edge.id}:${e.id}:${sa}:${sb}`;
            if (!seen.has(k)) { seen.add(k); sites.push({ a: p, b: r, sa, sb, distance }); }
          }
        }
      }
    }
    sites.sort((a, b) => a.distance - b.distance || a.a.edge.id - b.a.edge.id || a.b.edge.id - b.b.edge.id);
    const stock = [...this.ai.railPolicy.fleet(a), ...this.ai.railPolicy.fleet(b)].sort((x, y) => x.value - y.value || x.id - y.id);
    if (!stock.length) return;
    let tested = 0;
    for (const c of sites) {
      // Each saved pair is a bounded planning unit; no curve or generator is retained across saves.
      if (tested >= 24) break;
      for (const forwardA of [true, false]) for (const forwardB of [true, false]) {
        const left = forwardA ? pa.slice(0, c.a.leg + 1) : pa.slice(c.a.leg + 1).reverse();
        const right = forwardB ? pb.slice(c.b.leg + 1) : pb.slice(0, c.b.leg + 1).reverse();
        const path = [...left, ...right];
        if (new Set(path).size !== path.length || !path.some((sid) => g.stations.get(sid)?.owner === me)) continue;
        // Existing direct services already meet this demand; transfers avoided justify a modest gain too.
        if (g.lines.all().some((l) => l.kind === 'rail' && l.stops.includes(path[0]) && l.stops.includes(path[path.length - 1]))) continue;
        const t = stock.find((t) => t.length <= Math.min(...path.map((sid) => g.stations.get(sid)?.rail?.length ?? 0))
          && [...A, ...B].every((p) => trackAllows(t.cars, p.edge))
          && [...pa, ...pb].every((sid) => (g.stations.get(sid)?.rail?.edges ?? []).some((id) => {
            const e = net.edges.get(id); return e && trackAllows(t.cars, e);
          })));
        if (!t) { this.considered('midconnect.stock'); continue; }
        const length = [...A, ...B].reduce((s, p) => s + p.edge.len, 0) / 2 + c.distance;
        const kmh = Math.min(90, t.maxSpeedKmh), headway = Math.max(180, 2 * length * 10 / (kmh / 3.6) + path.length * 35);
        let trips = 0, revenue = 0;
        const towns = new Set<string>();
        for (const x of left) for (const y of right) {
          const X = g.stations.get(x), Y = g.stations.get(y);
          if (!X || !Y || X.townId < 0 || Y.townId < 0 || X.townId === Y.townId) continue;
          const pair = [X.townId, Y.townId].sort((a, b) => a - b).join(':');
          if (towns.has(pair)) continue;
          towns.add(pair);
          const hop = g.lines.nextHop(x, y), distance = Math.hypot(X.x - Y.x, X.z - Y.z);
          const time = estimateLegTime(distance, kmh, headway, 1.3);
          const gain = hop ? Math.max(0, Math.min(0.6, (hop.cost - time + 360) / Math.max(1, hop.cost))) : 1;
          const added = this.townTrips(X.townId, Y.townId) * gain;
          trips += added; revenue += added * 12 * estimateLegFare(distance, kmh, headway, 1, 1.3, true, false, { mode: 'rail' });
        }
        if (trips < networkOptions.throughTrips || trips <= 0) continue;
        this.considered('midconnect.demand');
        // Keep spare room on single-track corridors and use the existing congestion report above.
        if ([a, b].some((l) => l.vehicles.length >= 3 && !this.managed()?.get(l.id)?.double)) {
          this.considered('midconnect.capacity'); return;
        }
        const dirA = (forwardA ? c.a.dir : -c.a.dir) as 1 | -1, dirB = (forwardB ? c.b.dir : -c.b.dir) as 1 | -1;
        tested++;
        const plan = Trackops.planConnection(g, c.a.edge.id, c.sa, c.b.edge.id, c.sb, me, { dirA, dirB, search: 2 });
        if (!plan.ok || !this.mayAlter(plan.turnouts.map((t) => t.edge))) continue;
        if (plan.proposal && (!this.proposalConsent(plan.proposal) || !this.demolitionOk(plan.proposal.demolish))) continue;
        // Incremental income pays for the curve, its upkeep and a real compatible train within our horizon.
        const running = estimateVehicleYear(t.cars, length / Math.max(1, path.length - 1), g.year, 0.4, kmh).total;
        const upkeep = plan.length * (TRACK_TYPES[c.a.edge.type]?.maintPerUnit ?? 300);
        const foreign = [...A, ...B].filter((p) => p.edge.owner !== me).reduce((n, p) => n + g.edgeMaintenance(p.edge) * g.accessMultiplier(p.edge.owner), 0);
        const netIncome = revenue - running - upkeep - foreign;
        const capital = plan.cost + t.cars.reduce((n, m) => n + m.cost, 0), horizon = 8 + 12 * this.ai.config.risk;
        if (netIncome <= 0 || capital > netIncome * horizon) { this.considered('midconnect.payback'); continue; }
        const depot = g.depots.get(t.depotId);
        if (!depot || !left.concat(right).some((sid) => depotReaches(g, depot, sid, t.cars))) continue;
        if (!this.canSpend(capital * 1.2 + 150_000, 0.35)) return;
        // Split descendants are still the original lines. A rejected service removes only the new curve.
        const firstEdge = net.nextEdge, descendants = new Set<number>(net.edges.keys());
        const split = (old: NEdge, x: NEdge, y: NEdge) => { if (descendants.has(old.id)) { descendants.add(x.id); descendants.add(y.id); } };
        net.onSplit.push(split);
        let result: ReturnType<typeof Trackops.commitConnection>;
        try {
          result = Trackops.commitConnection(g, plan);
          if (!result.error) {
            // Split edges have their own local arc lengths. Find the actual turnout position again rather
            // than using the pre-split length on an arbitrary edge near the junction.
            for (const turnout of plan.turnouts) {
              const hit = net.nearestEdge(turnout.x, turnout.z, 2, 'rail', (e) => descendants.has(e.id)
                && e.station < 0 && e.depot < 0 && this.mayAlter([e.id]));
              if (hit && this.oneWayAround(hit.edge)) this.junctionCrossover({ e: hit.edge, s: hit.s,
                x: turnout.x, z: turnout.z, dir: turnout === plan.turnouts[0] ? plan.dirA : plan.dirB });
            }
          }
        } finally {
          net.onSplit.splice(net.onSplit.indexOf(split), 1);
        }
        const curve = [...net.edges.values()].filter((e) => e.id >= firstEdge && e.owner === me
          && e.kind === 'rail' && !descendants.has(e.id)).map((e) => e.id);
        if (result.error) { removeEdges(g, curve, me); this.considered('midconnect.buildFailed'); continue; }
        const l = g.lines.create('rail', me); l.stops = outAndBack(path);
        g.lines.rebuild();
        const compatible = !lineCompatibility(g, l.id, t.cars) && path.slice(1).every((sid, i) => routeBetween(g, path[i], sid, me) && routeBetween(g, sid, path[i], me));
        const train = compatible ? g.vehicles.buyTrain(depot.id, [...t.cars].sort((a, b) => Number(b.kind === 'loco') - Number(a.kind === 'loco')), l.id) : 'no return route';
        if (typeof train === 'string') {
          g.lines.delete(l.id); removeEdges(g, curve, me);
          this.note(`mid-line connection deferred: ${train}`); continue;
        }
        this.managed()?.set(l.id, { kind: 'rail', towns: [...new Set(path.map((sid) => g.stations.get(sid)?.townId ?? -1).filter((id) => id >= 0))],
          depot: depot.id, maxVehicles: 2, opened: g.day });
        for (const owner of new Set([me, a.owner, b.owner])) {
          const edges = [...new Set([...[a, b, l].flatMap((l) => this.lineLegs(l).map((p) => p.edge.id)),
            ...[...pa, ...pb, ...path].flatMap((sid) => g.stations.get(sid)?.rail?.edges ?? [])])];
          const preview = autoSignalLine(g, edges, owner, { preview: true });
          if (preview.signals.every((s) => s.action === 'keep' || (s.node >= 0 ? this.agrees(net.nodes.get(s.node)?.owner ?? 0) : this.mayAlter([s.edge]))))
            this.ai.stats.signals += autoSignalLine(g, edges, owner).placed;
        }
        this.ai.stats.lines++; this.ai.stats.vehicles++;
        this.bump('connections'); this.bump('netThrough'); this.bump('netMidConnections');
        this.ai.railPolicy.event(l, 'connection', `mid-line curve between ${a.name} and ${b.name}`);
        this.note(`${l.name}: mid-line connection between ${a.name} and ${b.name}, ${Math.round(trips)} through trips a month`);
        this.news(`connects ${a.name} and ${b.name} mid-route: ${l.name} runs end to end.`, plan.turnouts[0].x, plan.turnouts[0].z);
        this.canon(l.id);
        yield; return;
      }
    }
  }

  // ================================================================ cross-company links (xlink, 2.6.x)
  /** Another AI company's served rail line that agrees to joint works, and one of ours with our trains: anything to link? */
  private xlinkPartners(): boolean {
    const g = this.g;
    let ours = false, theirs = false;
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || !l.vehicles.length) continue;
      if (l.owner === this.me) ours = true;
      else if (l.owner > 0 && g.company(l.owner).ai && this.agrees(l.owner)) theirs = true;
      if (ours && theirs) return true;
    }
    return false;
  }

  /** A main-line railway running out and back with vehicles (what a direct service can continue along). */
  private xlinkLine(l: Line): boolean {
    const g = this.g;
    return l.kind === 'rail' && l.vehicles.length > 0 && !!this.pathOf(l)
      && l.stops.every((sid) => { const r = g.stations.get(sid)?.rail; return !r || railPartMode(r) === 'mainline'; });
  }

  /** Our line `a` (our trains on it) and another AI company's line `b`: linkable under mutual open access, never the player's. */
  private xlinkPair(a: Line, b: Line): boolean {
    const g = this.g, co = g.companies[b.owner];
    return a.owner === this.me && b.owner !== this.me && b.owner > 0 && !!co?.ai && !co.defunct && this.agrees(b.owner)
      && this.xlinkLine(a) && this.xlinkLine(b) && this.fleet(a).ours.length > 0;
  }

  /** Cheap neighbourhood test of two lines: stations within XLINK_REACH (platform gap), or their routes (straight between consecutive stops) passing within twice that. */
  private xlinkNear(a: Line, b: Line): boolean {
    const g = this.g, pa = this.pathOf(a), pb = this.pathOf(b);
    if (!pa || !pb) return false;
    const A = pa.map((id) => g.stations.get(id)).filter((s): s is Station => !!s), B = pb.map((id) => g.stations.get(id)).filter((s): s is Station => !!s);
    for (const x of A) for (const y of B) if (Math.hypot(x.x - y.x, x.z - y.z) < 200 && g.stations.gap(x, y) <= XLINK_REACH) return true;
    for (let i = 0; i + 1 < A.length; i++) for (let j = 0; j + 1 < B.length; j++)
      if (segmentGap(A[i], A[i + 1], B[j], B[j + 1]) <= XLINK_REACH * 2) return true;
    return false;
  }

  private xlinkPairs(): WorkItem[] {
    const g = this.g, me = this.me, out: WorkItem[] = [];
    const ours = g.lines.all().filter((l) => l.owner === me && this.xlinkLine(l) && this.fleet(l).ours.length);
    if (!ours.length) return out;
    const theirs = g.lines.all().filter((l) => l.owner !== me && l.owner > 0 && !!g.companies[l.owner]?.ai && !g.companies[l.owner].defunct
      && this.agrees(l.owner) && this.xlinkLine(l));
    for (const a of ours) for (const b of theirs) if (!this.cared(`xl${a.id}:${b.id}`) && this.xlinkNear(a, b)) out.push({ ids: [a.id, b.id] });
    return out;
  }

  /**
   * Track beyond a line's terminus that leads only to depots (a depot lead: never a free end the line could grow
   * from): its pieces, travelling into the terminus, as legs before the first stop (-1) or after the last (path length).
   */
  private xlinkThroats(path: number[]): { edge: NEdge; dir: 1 | -1; leg: number }[] {
    const g = this.g, net = g.world.net, out: { edge: NEdge; dir: 1 | -1; leg: number }[] = [];
    for (const [sid, leg] of [[path[0], -1], [path[path.length - 1], path.length - 1]] as [number, number][]) {
      const st = g.stations.get(sid), r = st?.rail;
      if (!st || !r) continue;
      const own = new Set([...r.edges, ...r.throughEdges]);
      for (const end of ['front', 'back'] as const) {
        const heads = g.stations.trackEnds(st, true).map((t) => t[end]);
        // a lead: plain track from the platform ends to depots only, no other station, no dead end, within 60 units
        const pieces: { edge: NEdge; dir: 1 | -1 }[] = [];
        let lead = true, depot = false, length = 0;
        const seen = new Set<number>(own), stack = heads.map((n) => ({ node: n }));
        for (let k = 0; stack.length && k < 64 && lead; k++) {
          const { node } = stack.pop()!;
          const n = net.nodes.get(node);
          if (!n) { lead = false; break; }
          const next = n.edges.filter((id) => !seen.has(id));
          if (!next.length && !heads.includes(node)) { lead = false; break; }
          for (const id of next) {
            seen.add(id);
            const e = net.edges.get(id);
            if (!e || e.kind !== 'rail' || e.station >= 0 || g.stations.throughStationOf(e.id) >= 0) { lead = false; break; }
            if (e.depot >= 0) { depot = true; continue; }
            length += e.len;
            if (length > 60) { lead = false; break; }
            const far = e.a === node ? e.b : e.a;
            // travelling into the terminus: from the far node towards this one
            pieces.push({ edge: e, dir: e.a === node ? -1 : 1 });
            stack.push({ node: far });
          }
        }
        // (the line's own end: its track leads on to the next stop, never only to depots)
        if (lead && depot && pieces.length) for (const p of pieces) out.push({ ...p, leg });
      }
    }
    return out;
  }

  /**
   * The value of a direct service from our stations `left` (in travel order, the curve after the last) to the
   * partner's stations `right` (the curve before the first; the curve at (jx, jz)), at `kmh` and `headway`: for each
   * pair of towns across, the monthly trips of the regional demand model (townTrips, both ways) and the share a direct
   * rail service attracts (XLINK_CAPTURE at a typical trip factor, scaled by its own: tripFactor elasticity, as the
   * demand model's service factor scales a station's trips), against today's routed journey (its expected time with
   * waits, rides, walks and the routing's transfer penalty) and its fares: a change between the networks, its legs
   * split by distance at the curve, both at TRANSFER_FARE_FACTOR (the leg ending in the change and the one after it).
   * Journeys a single ride already serves, or
   * that are no quicker direct, stay as they are. Returns the direct riders a month, their annual revenue, and
   * today's revenue of those journeys on our trains and on the partner's (what each company stops carrying).
   *
   * (The demand model's line forecast is not used here: it shares a station's trips among the line's own stops only,
   * so for two stations that already reach other destinations it counts most of their trips as new. Measured in a
   * natural world, a direct service it valued at 313k a year earned 27k.)
   */
  private xlinkValue(left: number[], right: number[], kmh: number, headway: number, jx?: number, jz?: number): { trips: number; revenue: number; ourLeg: number; theirLeg: number } {
    const g = this.g;
    let trips = 0, revenue = 0, ourLeg = 0, theirLeg = 0;
    const sts = (ids: number[]) => ids.map((id) => g.stations.get(id)).filter((st): st is Station => !!st?.rail);
    const L = sts(left), R = sts(right);
    if (!L.length || !R.length || L.length !== left.length || R.length !== right.length) return { trips, revenue, ourLeg, theirLeg };
    const x0 = jx ?? (L[L.length - 1].x + R[0].x) / 2, z0 = jz ?? (L[L.length - 1].z + R[0].z) / 2;
    const seen = new Set<string>();
    for (const X of L) for (const Y of R) {
      if (X.townId < 0 || Y.townId < 0 || X.townId === Y.townId) continue;
      const pair = X.townId < Y.townId ? `${X.townId}:${Y.townId}` : `${Y.townId}:${X.townId}`;
      if (seen.has(pair)) continue;
      seen.add(pair);
      const D = this.townTrips(X.townId, Y.townId);
      if (!(D > 0)) continue;
      const d = Math.hypot(X.x - Y.x, X.z - Y.z), ref = refTime(d);
      const time = estimateLegTime(d, kmh, headway, 1.3), hop = g.lines.nextHop(X.id, Y.id);
      // a single ride to that town today, or a journey no slower: those riders stay where they are
      if (hop && (hop.alight === Y.id || g.stations.get(hop.alight)?.townId === Y.townId || hop.cost <= time)) continue;
      const riders = D * XLINK_CAPTURE * tripFactor(time, ref) / TF_TYPICAL;
      trips += riders;
      revenue += 12 * riders * fareFor(d, time, 1, { mode: 'rail' });
      if (!hop) continue;
      // today's journey: a change between the networks
      const was = D * XLINK_CAPTURE * tripFactor(hop.cost, ref) / TF_TYPICAL;
      const fare = 12 * was * fareFor(d, Math.max(1, hop.cost - TRANSFER_PENALTY_S - PLATFORM_CHANGE_S), 1, { mode: 'rail' });
      const l1 = Math.hypot(X.x - x0, X.z - z0), l2 = Math.hypot(x0 - Y.x, z0 - Y.z), s1 = l1 / Math.max(1, l1 + l2);
      ourLeg += fare * s1 * TRANSFER_FARE_FACTOR; theirLeg += fare * (1 - s1) * TRANSFER_FARE_FACTOR;
    }
    return { trips, revenue, ourLeg, theirLeg };
  }

  /** Annual access fees for `trains` trains of `user` (by count) running over `owner`'s stations and track `edges`: its usage share of their upkeep. */
  private xlinkFees(owner: number, stations: number[], edges: Iterable<NEdge>, trains: number, ownerTrains: number): number {
    const g = this.g, m = g.accessMultiplier(owner);
    if (!(trains > 0) || m <= 0) return 0;
    let upkeep = 0;
    for (const sid of new Set(stations)) { const st = g.stations.get(sid); if (st?.owner === owner) upkeep += g.stationMaintenance(st); }
    for (const e of edges) if (e.owner === owner) upkeep += g.edgeMaintenance(e);
    return upkeep * m * trains / (Math.max(1, ownerTrains) + m * trains);
  }

  /** A consist for a direct service over these legs and stations: one of the operators' consists that fits, else the year's train. */
  private xlinkStock(lines: Line[], path: number[], legs: { edge: NEdge }[]): VehicleModel[] | null {
    const g = this.g, net = g.world.net;
    const platform = Math.min(...path.map((sid) => g.stations.get(sid)?.rail?.length ?? 0));
    const fits = (cars: VehicleModel[]) => cars.reduce((s, m) => s + m.length, 0) <= platform - 0.4 && legs.every((p) => trackAllows(cars, p.edge))
      && path.every((sid) => (g.stations.get(sid)?.rail?.edges ?? []).some((id) => { const e = net.edges.get(id); return !!e && trackAllows(cars, e); }));
    const options: VehicleModel[][] = [];
    for (const l of lines) for (const vid of l.vehicles) {
      const v = g.vehicles.get(vid);
      if (v?.kind !== 'train') continue;
      const cars = (v as Train).cars;
      if (!options.some((o) => o.map((m) => m.id).join() === cars.map((m) => m.id).join())) options.push([...cars]);
    }
    options.sort((x, y) => x.reduce((s, m) => s + m.cost, 0) - y.reduce((s, m) => s + m.cost, 0) || x.map((m) => m.id).join().localeCompare(y.map((m) => m.id).join()));
    const own = options.find(fits);
    if (own) return own.sort((p, q) => Number(q.kind === 'loco') - Number(p.kind === 'loco'));
    const year = pickTrain(g.year, platform - 0.4, legs.reduce((s, p) => s + p.edge.len, 0) / 2, 2);
    return year && fits(year) ? year : null;
  }

  /**
   * The economics of one direct service (`left` ours, `right` theirs, a curve of chord `d`): its route length and
   * average speed for the consist, then for one or two trains of ours the riders' value (xlinkValue), our running
   * costs, the curve's upkeep and the fees for the partner's stations and track; the better fleet. `owner`: the
   * partner's view under open access, its fee income less the later legs it stops carrying, plus the best of its
   * mutual option (one through train of its own: a share of the riders, its running costs, our fees) where it could
   * run one: room left on both lines' track beside our trains (`maxTrains`: the room less one), and the partner's
   * money rules, a consist and a depot of its own for the route (throughTrainPossible).
   */
  private xlinkEconomics(a: Line, b: Line, left: number[], right: number[], d: number, cars: VehicleModel[], A: { edge: NEdge; leg: number }[], B: { edge: NEdge; leg: number }[], maxTrains = 2, jx?: number, jz?: number) {
    const g = this.g, pa = this.pathOf(a)!, pb = this.pathOf(b)!;
    const on = (path: number[], part: number[], legs: { edge: NEdge; leg: number }[]) => legs.filter((p) => p.leg >= 0 && p.leg + 1 < path.length && part.includes(path[p.leg]) && part.includes(path[p.leg + 1]));
    const aLegs = on(pa, left, A), bLegs = on(pb, right, B);
    // (the pieces from the curve to the nearest stop on either side: about half a leg each)
    const length = aLegs.reduce((s, p) => s + p.edge.len, 0) + bLegs.reduce((s, p) => s + p.edge.len, 0) + d * 1.25
      + (A.reduce((s, p) => s + p.edge.len, 0) / Math.max(1, pa.length - 1) + B.reduce((s, p) => s + p.edge.len, 0) / Math.max(1, pb.length - 1)) / 2;
    const stops = left.length + right.length, hop = length / Math.max(1, stops - 1);
    const year = estimateVehicleYear(cars, hop, g.year, 0.4);
    const kmh = Math.max(20, year.km / (YEAR_S / 3600));
    const cycle = 2 * length * UNIT_M / (kmh / 3.6);
    const upkeep = d * 1.25 * (TRACK_TYPES.standard?.maintPerUnit ?? 300);
    const trainCost = cars.reduce((s, m) => s + m.cost, 0);
    // riders a train carries a year: both ways, four fifths of its seats each run (more riders wait for later trains)
    const perTrain = cars.reduce((s, m) => s + m.capacity, 0) * 0.8 * 2 * YEAR_S / Math.max(1, cycle);
    let best: { trains: number; net: number; value: ReturnType<NetPlanner['xlinkValue']>; revenue: number; carried: number; fees: number; running: number; owner: number; headway: number } | null = null;
    const partner = this.plannerOf(b.owner), partnerTrain = !!partner && partner.throughTrainPossible([...left, ...right], [...aLegs, ...bLegs]);
    for (const trains of [1, 2].filter((n) => n <= Math.max(1, maxTrains))) {
      const headway = cycle / trains, value = this.xlinkValue(left, right, kmh, headway, jx, jz);
      // (riders beyond the trains' seats stay with today's journeys)
      const riders = value.trips * 12, carried = riders > 0 ? Math.min(1, perTrain * trains / riders) : 0;
      const revenue = value.revenue * carried;
      const fees = this.xlinkFees(b.owner, right, bLegs.map((p) => p.edge), trains, this.fleet(b).others + this.fleet(b).ours.length);
      const running = year.total * trains;
      const net = revenue - value.ourLeg * carried - running - upkeep - fees;
      // the partner: fees in, the later legs it no longer carries out, and its option of one through train of its own
      const theirFees = this.xlinkFees(this.me, left, aLegs.map((p) => p.edge), 1, trains);
      const more = riders > 0 ? Math.min(1, perTrain * (trains + 1) / riders) : 0;
      // (no option where its train could not run: no room beside ours, or no money, consist or depot for it)
      const option = partnerTrain && trains <= maxTrains ? value.revenue * more / (trains + 1) - year.total - theirFees - this.xlinkNeed(0, trainCost) : 0;
      const owner = fees - value.theirLeg * carried + Math.max(0, option);
      if (!best || net - this.xlinkNeed(0, trains * trainCost) > best.net - this.xlinkNeed(0, best.trains * trainCost)) best = { trains, net, value, revenue, carried, fees, running, owner, headway };
    }
    return { ...best!, length, kmh, upkeep, trainCost, aLegs, bLegs };
  }

  /**
   * The annual return a link's capital must earn, by the AI's rule for opening a railway (ai.ts railPlanJob): the civil
   * works (the curve) written off over 1 / (0.045 - 0.03 risk) years (22-67: track lasts), and 3% a year on all the
   * capital (the trains keep their value).
   */
  private xlinkNeed(works: number, trains: number): number { return works * (0.045 - 0.03 * this.ai.config.risk) + (works + trains) * 0.03; }

  /**
   * Candidate connecting curves between our line `a` and the partner's line `b`, where their tracks or stations come
   * within XLINK_REACH: turnout points on both lines' plain track (and on a depot lead beyond the partner's terminus,
   * into its platforms; never a free end either line could grow from) 14-90 units apart, with each way of running
   * a direct service across, valued; the best few. A reason string when there is nothing to plan.
   */
  private xlinkSurvey(a: Line, b: Line): XLinkSite[] | string {
    const g = this.g, net = g.world.net, me = this.me;
    const pa = this.pathOf(a)!, pb = this.pathOf(b)!;
    // the lines meet at a station already: joining their services is the join task's work
    if (pa.some((sid) => pb.includes(sid))) return 'meet';
    const A = this.lineLegs(a), B = this.lineLegs(b);
    if (!A.length || !B.length) return 'legs';
    const all = [...B, ...this.xlinkThroats(pb)];
    const lines = [a, b];
    const cars = this.xlinkStock(lines, [...pa, ...pb], [...A, ...B]);
    if (!cars) return 'stock';
    const q = { x: 0, y: 0, z: 0 }, p2 = { x: 0, y: 0, z: 0 }, ta = { x: 0, y: 0, z: 0 }, tb = { x: 0, y: 0, z: 0 };
    const bEdges = new Map<number, (typeof all)[number][]>();
    for (const p of all) { const list = bEdges.get(p.edge.id) ?? []; list.push(p); bEdges.set(p.edge.id, list); }
    const raw: { a: (typeof A)[number]; b: (typeof all)[number]; sa: number; sb: number; d: number }[] = [];
    let closest = Infinity;
    const sa0 = pa.map((id) => g.stations.get(id)!).filter(Boolean), sb0 = pb.map((id) => g.stations.get(id)!).filter(Boolean);
    for (const x of sa0) for (const y of sb0) if (Math.hypot(x.x - y.x, x.z - y.z) < 200) closest = Math.min(closest, g.stations.gap(x, y));
    // turnout points every 10 units or so along each piece of track (at most 16 a piece)
    const marks = new Map<number, { s: number; x: number; y: number; z: number }[]>();
    const marksOf = (e: NEdge) => {
      let m = marks.get(e.id);
      if (!m) {
        const n = Math.min(16, Math.max(3, Math.round(e.len / 10)));
        m = [];
        for (let i = 0; i < n; i++) { const s = e.len * (i + 0.5) / n; net.pointAt(e, s, q); m.push({ s, x: q.x, y: q.y, z: q.z }); }
        marks.set(e.id, m);
      }
      return m;
    };
    for (const p of A.slice(0, 256)) {
      if (p.edge.len < 3 || railModeOf(p.edge.type) !== 'mainline' || !this.mayAlter([p.edge.id])) continue;
      const ma = marksOf(p.edge);
      let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
      for (const u of ma) { x0 = Math.min(x0, u.x); z0 = Math.min(z0, u.z); x1 = Math.max(x1, u.x); z1 = Math.max(z1, u.z); }
      for (const e of net.edgesNear(x0 - 90, z0 - 90, x1 + 90, z1 + 90)) {
        const rs = bEdges.get(e.id);
        if (!rs || e.id === p.edge.id || e.len < 3 || railModeOf(e.type) !== 'mainline' || !this.mayAlter([e.id])) continue;
        if (e.a === p.edge.a || e.a === p.edge.b || e.b === p.edge.a || e.b === p.edge.b) continue;
        for (const u of ma) for (const v of marksOf(e)) {
          const d = Math.hypot(u.x - v.x, u.z - v.z);
          closest = Math.min(closest, d);
          if (d < 14 || d > 90 || Math.abs(u.y - v.y) > d * 0.035) continue;
          for (const r of rs) raw.push({ a: p, b: r, sa: u.s, sb: v.s, d });
        }
      }
    }
    if (closest > XLINK_REACH) return 'far';
    if (!raw.length) return 'sites';
    raw.sort((x, y) => x.d - y.d || x.a.edge.id - y.a.edge.id || x.b.edge.id - y.b.edge.id || x.sa - y.sa || x.sb - y.sb);
    const memo = new Map<string, ReturnType<NetPlanner['xlinkEconomics']>>();
    const out: XLinkSite[] = [];
    const roomA = this.xlinkRoom(a), roomB = this.xlinkRoom(b);
    const doubleA = this.xlinkDouble(a), doubleB = this.xlinkDouble(b);
    let spans = 0, full = 0;
    const direct = (path: number[]) => g.lines.all().some((l) => l.kind === 'rail' && l.stops.includes(path[0]) && l.stops.includes(path[path.length - 1]));
    let considered = 0;
    const minR = Math.max(18, (TRACK_TYPES.standard?.minRadius ?? 3) * 1.5);
    const skew = new Map<XLinkSite, number>();
    for (const c of raw.slice(0, 384)) {
      net.pointAt(c.a.edge, c.sa, q, ta); net.pointAt(c.b.edge, c.sb, p2, tb);
      const la = Math.hypot(ta.x, ta.z) || 1, lb = Math.hypot(tb.x, tb.z) || 1;
      const cx = (p2.x - q.x) / c.d, cz = (p2.z - q.z) / c.d;
      for (const forwardA of [true, false]) for (const forwardB of c.b.leg < 0 || c.b.leg >= pb.length - 1 ? [true] : [true, false]) {
        // travel directions: along our track towards the curve, along theirs away from it
        const da = c.a.dir * (forwardA ? 1 : -1), db = c.b.leg < 0 || c.b.leg >= pb.length - 1 ? c.b.dir : c.b.dir * (forwardB ? 1 : -1);
        const ax = ta.x / la * da, az = ta.z / la * da, bx = tb.x / lb * db, bz = tb.z / lb * db;
        // one arc can join them: leaving A forwards, arriving on B forwards, turning one way with a usable radius
        const ca = ax * cx + az * cz, cb = cx * bx + cz * bz;
        if (ca < 0.3 || cb < 0.3) continue;
        const alpha = Math.acos(Math.min(1, ca)), beta = Math.acos(Math.min(1, cb));
        const turnA = ax * cz - az * cx, turnB = cx * bz - cz * bx;
        if (alpha > 0.08 && beta > 0.08 && turnA * turnB < 0) continue;
        if (Math.abs(alpha - beta) > 0.5 || (alpha + beta > 0.05 && c.d / (2 * Math.sin((alpha + beta) / 2)) < minR)) continue;
        const left = forwardA ? pa.slice(0, c.a.leg + 1) : pa.slice(c.a.leg + 1).reverse();
        // (a depot lead beyond a terminus: into its platforms, then along the whole line)
        const right = c.b.leg < 0 ? [...pb] : c.b.leg >= pb.length - 1 ? [...pb].reverse() : forwardB ? pb.slice(c.b.leg + 1) : pb.slice(0, c.b.leg + 1).reverse();
        const path = [...left, ...right];
        if (!left.length || !right.length || new Set(path).size !== path.length || !left.some((sid) => g.stations.get(sid)?.owner === me) || direct(path)) continue;
        // single track: the service's passing stop on each such side right by the curve, else a passing loop laid there
        // (its trains hold one line's section at a time), and room for them on both lines (a loop is one more place)
        const sideA = doubleA ? 'near' : this.xlinkSide(q.x, q.z, left[left.length - 1]);
        const sideB = doubleB ? 'near' : this.xlinkSide(p2.x, p2.z, right[0]);
        if (!networkOptions.xlinkForce && (sideA === 'none' || sideB === 'none')) { spans++; continue; }
        const room = Math.min(roomA + Number(sideA === 'loop'), roomB + Number(sideB === 'loop'));
        if (room < 1) { full++; continue; }
        const k = `${left.join(',')}|${right.join(',')}|${room}`;
        let econ = memo.get(k);
        if (!econ) { econ = this.xlinkEconomics(a, b, left, right, c.d, cars, A, B, room - 1, (q.x + p2.x) / 2, (q.z + p2.z) / 2); memo.set(k, econ); considered++; }
        networkProfile.decisions['xlink.maxTrips'] = Math.max(networkProfile.decisions['xlink.maxTrips'] ?? 0, econ.value.trips);
        if (!networkOptions.xlinkForce && (econ.value.trips < networkOptions.xlinkTrips || econ.net <= 0)) continue;
        const loops = Number(sideA === 'loop') + Number(sideB === 'loop');
        const site: XLinkSite = { ax: q.x, az: q.z, atx: ax, atz: az, bx: p2.x, bz: p2.z, btx: bx, btz: bz,
          d: c.d, left, right, value: econ.net - this.xlinkNeed(loops * this.xlinkLoopCost(c.a.edge.type), econ.trains * econ.trainCost),
          la: sideA === 'loop', lb: sideB === 'loop' };
        skew.set(site, Math.abs(alpha - beta));
        out.push(site);
      }
    }
    if (!considered) return full ? 'capacity' : spans ? 'span' : 'direct';
    if (!out.length) return 'demand';
    // the best services first, the shorter curves among them; one site per stretch of track pairs
    out.sort((x, y) => y.value - x.value || skew.get(x)! - skew.get(y)! || x.d - y.d);
    const kept: XLinkSite[] = [];
    for (const s of out) {
      if (kept.some((k) => Math.hypot(k.ax - s.ax, k.az - s.az) < 6 && Math.hypot(k.bx - s.bx, k.bz - s.bz) < 6 && k.left.join() === s.left.join() && k.right.join() === s.right.join())) continue;
      kept.push(s);
      if (kept.length >= XLINK_SITES) break;
    }
    return kept;
  }

  /** The turnout point of a site on a plain track at (x, z), travelling (tx, tz): the edge, its arc length and direction. */
  private xlinkTurnout(x: number, z: number, tx: number, tz: number): { edge: NEdge; s: number; dir: 1 | -1 } | null {
    const net = this.g.world.net, t = { x: 0, y: 0, z: 0 }, p = { x: 0, y: 0, z: 0 };
    const hit = net.nearestEdge(x, z, 0.6, 'rail', (e) => e.station < 0 && e.depot < 0 && this.g.stations.throughStationOf(e.id) < 0 && this.mayAlter([e.id]));
    if (!hit || hit.edge.len < 3) return null;
    net.pointAt(hit.edge, hit.s, p, t);
    const l = Math.hypot(t.x, t.z) || 1, dot = (t.x * tx + t.z * tz) / l;
    if (Math.abs(dot) < 0.9) return null;
    return { edge: hit.edge, s: Math.max(1, Math.min(hit.edge.len - 1, hit.s)), dir: dot > 0 ? 1 : -1 };
  }

  /** Plan a site's curve in today's world (turnouts on agreeing track, consent for what it crosses, few demolitions). */
  private xlinkPlan(s: XLinkSite): Trackops.ConnectionPlan | null {
    const g = this.g;
    const ea = this.xlinkTurnout(s.ax, s.az, s.atx, s.atz), eb = this.xlinkTurnout(s.bx, s.bz, s.btx, s.btz);
    if (!ea || !eb || ea.edge.id === eb.edge.id) return null;
    const plan = Trackops.planConnection(g, ea.edge.id, ea.s, eb.edge.id, eb.s, this.me, { dirA: ea.dir, dirB: eb.dir, search: 2 });
    if (!plan.ok || !this.mayAlter(plan.turnouts.map((t) => t.edge))) return null;
    // (no demolition: a link given up takes up its track and refunds the works, but cannot rebuild a house)
    if (plan.proposal && (!this.proposalConsent(plan.proposal) || plan.proposal.demolish.length > 0)) return null;
    return plan;
  }

  /**
   * One pair of lines (ours, the partner's) a work unit at a time, its decision state saved in the work item:
   * survey (candidate curves and direct services valued), then two curves planned a unit, then the best one built
   * when it pays and the partner agrees; a walking link between their stations where no curve fits.
   */
  private *xlinkTask(item: WorkItem): Generator<void, void> {
    const g = this.g, [aid, bid] = item.ids, key = `xl${aid}:${bid}`;
    const finish = (days: number, why: string) => { delete item.xlink; this.careFor(key, days); this.considered('xlink.' + why); };
    const a = g.lines.map.get(aid), b = g.lines.map.get(bid);
    if (!a || !b || !this.xlinkPair(a, b) || this.ai.railPolicy.deepTrouble) { finish(180, 'invalid'); return; }
    const cursor = item.xlink ??= { at: 0 };
    if (cursor.at === 0) {
      this.considered('xlink.pair');
      if (lineCongestion(g, a.id).level >= 2 || lineCongestion(g, b.id).level >= 2) { finish(120, 'congestion'); return; }
      const sites = this.xlinkSurvey(a, b);
      yield;
      if (typeof sites === 'string') { if (sites === 'demand' || sites === 'sites') this.xlinkWalk(a, b); finish(sites === 'meet' || sites === 'far' ? 720 : 360, sites); return; }
      cursor.sites = sites; cursor.at = 1;
      return;
    }
    const sites = cursor.sites ?? [];
    if (cursor.at <= sites.length) {
      for (let n = 0; n < XLINK_PLANS && cursor.at <= sites.length; n++) {
        const i = cursor.at - 1, s = sites[i];
        cursor.at++;
        const plan = this.xlinkPlan(s);
        yield;
        if (!plan) { this.considered('xlink.plan'); continue; }
        // (annual: the service's result less what the curve's capital must earn)
        const score = s.value - this.xlinkNeed(plan.cost, 0);
        if (!cursor.best || score > cursor.best.score) cursor.best = { site: i, cost: plan.cost, score };
      }
      return;
    }
    const best = cursor.best;
    finish(360, !best ? 'noCurve' : best.score > 0 ? 'build' : 'unpaid');
    if (best && best.score <= 0 && !networkOptions.xlinkForce) {
      const s = sites[best.site];
      this.note(`no link ${a.name} - ${g.company(b.owner).name}'s ${b.name}: the direct service would leave ${Math.round(s.value / 1000)}k a year after its trains${s.la || s.lb ? ' and passing loops' : ''}, the best curve (${Math.round(best.cost / 1000)}k) needs ${Math.round(this.xlinkNeed(best.cost, 0) / 1000)}k`);
    }
    if (!best || (best.score <= 0 && !networkOptions.xlinkForce)) { this.xlinkWalk(a, b); return; }
    yield* this.xlinkBuild(a, b, sites[best.site]);
  }

  /** Where no curve fits or pays: their nearest stations linked for walking transfers (a transfer complex), when within range. */
  private xlinkWalk(a: Line, b: Line): boolean {
    const g = this.g;
    const pairs: { x: number; y: number; gap: number }[] = [];
    for (const x of new Set(a.stops)) for (const y of new Set(b.stops)) {
      const X = g.stations.get(x), Y = g.stations.get(y);
      if (!X || !Y || X.links.includes(y) || Math.hypot(X.x - Y.x, X.z - Y.z) > 200) continue;
      const gap = g.stations.gap(X, Y);
      if (gap <= TRANSFER_RANGE && !g.stations.canLink(x, y)) pairs.push({ x, y, gap });
    }
    pairs.sort((p, q) => p.gap - q.gap || p.x - q.x || p.y - q.y);
    const p = pairs[0];
    if (!p) return false;
    // some trips across: the change on foot shortens them
    const towns = (l: Line) => [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
    if (!towns(a).some((x) => towns(b).some((y) => x !== y && this.townTrips(x, y) > 0))) return false;
    if (g.stations.link(p.x, p.y)) return false;
    this.bump('netXComplex');
    const X = g.stations.get(p.x)!, Y = g.stations.get(p.y)!;
    this.note(`walking link ${X.name} - ${Y.name} (${g.company(Y.owner).name}): no connecting curve fits`);
    return true;
  }

  /**
   * Build a site's curve and run the direct service (a joint line of ours, our trains end to end), all checked in
   * today's world first: the economics, the partner's view, capacity on both lines (single track, congestion), a
   * consist and a depot, the money. Rolled back (only the new pieces; split halves of older track stay, the works
   * refunded) when the trains cannot run through. The partner is invited to run trains on it too (mutual through
   * running), and lines of either company inside the new route become its service patterns.
   */
  private *xlinkBuild(a: Line, b: Line, s: XLinkSite): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const pa = this.pathOf(a), pb = this.pathOf(b);
    const left = s.left, right = s.right, path = [...left, ...right];
    if (!pa || !pb || !left.every((sid) => pa.includes(sid)) || !right.every((sid) => pb.includes(sid))) { this.considered('xlink.changed'); return; }
    const A = this.lineLegs(a), B = this.lineLegs(b);
    yield;
    const cars = this.xlinkStock([a, b], path, [...A, ...B]);
    if (!cars) { this.considered('xlink.stock'); return; }
    const plan = this.xlinkPlan(s);
    if (!plan) { this.considered('xlink.plan'); return; }
    // capacity: our trains on both lines' track within their passing places (single track), one place left for the
    // partner's mutual through train; platforms where the direct trains turn
    const forced = networkOptions.xlinkForce;
    const sideA = this.xlinkDouble(a) ? 'near' : this.xlinkSide(s.ax, s.az, left[left.length - 1]);
    const sideB = this.xlinkDouble(b) ? 'near' : this.xlinkSide(s.bx, s.bz, right[0]);
    if (!forced && (sideA === 'none' || sideB === 'none')) { this.considered('xlink.span'); return; }
    const room = Math.min(this.xlinkRoom(a) + Number(sideA === 'loop'), this.xlinkRoom(b) + Number(sideB === 'loop'));
    if (room < 1) { this.considered('xlink.capacity'); return; }
    const econ = this.xlinkEconomics(a, b, left, right, s.d, cars, A, [...B, ...this.xlinkThroats(pb)], room - 1, (s.ax + s.bx) / 2, (s.az + s.bz) / 2);
    const works = plan.cost + (Number(sideA === 'loop') + Number(sideB === 'loop')) * this.xlinkLoopCost(net.edges.get(plan.turnouts[0].edge)?.type);
    const capital = works + econ.trains * econ.trainCost;
    if (!forced && (econ.value.trips < networkOptions.xlinkTrips || econ.net <= this.xlinkNeed(works, econ.trains * econ.trainCost))) { this.considered('xlink.payback'); return; }
    // the owner agrees when its fees and its share of the direct riders make up for the later legs it no longer carries
    if (!forced && econ.owner < 0) { this.considered('xlink.consent'); return; }
    const depots = [...g.depots.map.values()].filter((d) => d.owner === me && d.kind === 'rail')
      .sort((x, y) => Number(y.id === this.managed()?.get(a.id)?.depot) - Number(x.id === this.managed()?.get(a.id)?.depot) || x.id - y.id);
    const depot = depots.find((d) => left.some((sid) => depotReaches(g, d, sid, cars)));
    if (!depot) { this.considered('xlink.depot'); return; }
    // (platforms where the direct trains turn: grown without demolition, which a link given up could not rebuild)
    const ends = [path[0], path[path.length - 1]].map((sid) => g.stations.get(sid));
    for (const st of ends) {
      if (!st?.rail) { this.considered('xlink.changed'); return; }
      const turning = this.linesAt(st.id).length + 1;
      if (st.rail.tracks < Math.min(2, turning) && this.grow(st, { tracks: 2, through: st.rail.through ?? 0, length: st.rail.length }, 'direct services across', false) !== 'done') { this.considered('xlink.platforms'); return; }
    }
    if (!this.canSpend(capital * 1.2 + 150_000, 0.35)) { this.considered('xlink.funds'); return; }
    const money = this.eco.money, crossings0 = new Set(net.crossings.keys());
    // (signals as they were: a rolled-back loop leaves no one-way signal on single track)
    const signals = new Map([...net.nodes].map(([id, n]) => [id, { signal: n.signal, kind: n.signalKind, pass: n.signalPass }]));
    // the curve; where it joins directional double track, a crossover at the junction for the return movement (as
    // mid-line connections do); the passing loops beside it. Split descendants of either line's track are its owner's,
    // never part of the works.
    const built = this.builtEdges(() => {
      const known = new Set<number>(net.edges.keys());
      const split = (old: NEdge, x: NEdge, y: NEdge) => { if (known.has(old.id)) { known.add(x.id); known.add(y.id); } };
      net.onSplit.push(split);
      try {
        const result = Trackops.commitConnection(g, plan, { signals: false });
        if (!result.error) for (const turnout of plan.turnouts) {
          const hit = net.nearestEdge(turnout.x, turnout.z, 2, 'rail', (e) => known.has(e.id) && e.station < 0 && e.depot < 0 && this.mayAlter([e.id]));
          if (hit && this.oneWayAround(hit.edge)) this.junctionCrossover({ e: hit.edge, s: hit.s, x: turnout.x, z: turnout.z, dir: turnout === plan.turnouts[0] ? plan.dirA : plan.dirB });
        }
        if (!result.error && sideA === 'loop' && !this.xlinkLoop(a, plan.turnouts[0].x, plan.turnouts[0].z, left[left.length - 1])) return { ...result, error: 'no room for a passing loop on ' + a.name };
        if (!result.error && sideB === 'loop' && !this.xlinkLoop(b, plan.turnouts[1].x, plan.turnouts[1].z, right[0])) return { ...result, error: 'no room for a passing loop on ' + b.name };
        // nothing built crosses track or a road at grade unless its owner agrees (never the player's), whatever the
        // pieces became when built (crossovers, the loops' end connections)
        if (!result.error) for (const [cid, c] of net.crossings) {
          if (crossings0.has(cid)) continue;
          if ([c.e1, c.e2].some((id) => { const e = net.edges.get(id); return !!e && e.owner >= 0 && !this.agrees(e.owner); }))
            return { ...result, error: 'it would cross track without its owner\'s consent' };
        }
        return result;
      } finally { net.onSplit.splice(net.onSplit.indexOf(split), 1); }
    });
    const rollback = (why: string) => {
      this.xlinkRemove(built.edges);
      for (const [id, n] of net.nodes) { const old = signals.get(id); n.signal = old?.signal ?? 0; n.signalKind = old?.kind; n.signalPass = old?.pass; }
      this.eco.spend(this.eco.money - money, 'construction', true);
      net.version++; g.onNetworkChanged();
      this.note(`link ${a.name} - ${b.name} given up: ${why}; works refunded`);
      this.considered('xlink.rollback');
    };
    if (built.result.error) { rollback(built.result.error); return; }
    const l = g.lines.create('rail', me);
    l.stops = outAndBack(path);
    g.lines.rebuild();
    const routes = path.slice(1).every((sid, i) => routeBetween(g, path[i], sid, me) && routeBetween(g, sid, path[i], me));
    const why = !routes ? 'no way through the curve both ways' : lineCompatibility(g, l.id, cars);
    let bought = 0;
    if (!why) for (let i = 0; i < econ.trains; i++) { if (typeof g.vehicles.buyTrain(depot.id, cars, l.id) !== 'string') bought++; }
    if (why || !bought) {
      for (const vid of [...l.vehicles]) g.vehicles.sell(vid);
      g.lines.delete(l.id);
      rollback(why || 'no train');
      return;
    }
    // (all operators' trains together: the room on both lines' track, one place for the partner's mutual train)
    this.managed()?.set(l.id, { kind: 'rail', towns: [...new Set(path.map((sid) => g.stations.get(sid)?.townId ?? -1).filter((id) => id >= 0))],
      depot: depot.id, maxVehicles: Math.max(1, room), opened: g.day, across: true });
    // signals: each owner's track by the rules, where every change is on track whose owner agrees
    for (const owner of new Set([me, b.owner])) {
      const edges = [...new Set([...[a, b, l].flatMap((x) => this.lineLegs(x).map((p) => p.edge.id)), ...built.edges,
        ...[...pa, ...pb].flatMap((sid) => g.stations.get(sid)?.rail?.edges ?? [])])];
      const preview = autoSignalLine(g, edges, owner, { preview: true });
      if (preview.signals.every((x) => x.action === 'keep' || (x.node >= 0 ? this.agrees(net.nodes.get(x.node)?.owner ?? 0) : this.mayAlter([x.edge]))))
        this.ai.stats.signals += autoSignalLine(g, edges, owner).placed;
    }
    this.ai.stats.lines++; this.ai.stats.vehicles += bought;
    const loops = Number(sideA === 'loop') + Number(sideB === 'loop');
    if (loops) this.bump('netXLoops', loops);
    this.bump('connections'); this.bump('netXServices'); this.bump('netXLinks');
    const partner = g.company(b.owner).name;
    this.ai.railPolicy.event(l, 'connection', `link with ${partner}'s ${b.name}`);
    this.note(`${l.name}: linked with ${partner}'s ${b.name}${loops ? ` (${loops} passing loop${loops > 1 ? 's' : ''} beside the junction)` : ''}, direct trains ${g.stations.get(path[0])?.name} - ${g.stations.get(path[path.length - 1])?.name} (${Math.round(econ.value.trips)} trips a month, ${Math.round(econ.net / 1000)}k a year, fees ${Math.round(econ.fees / 1000)}k to ${partner})`);
    this.news(`links its network with ${partner}'s: ${l.name} runs direct trains across both.`, plan.turnouts[0].x, plan.turnouts[0].z);
    // lines inside the new route, of either company, become its service patterns (one line per route)
    this.xlinkCanon(l.id);
    // mutual through running: the partner may put trains on the direct service too (it owns stations on it)
    const joint = g.lines.get(l.id);
    if (joint) {
      g.lines.invite(joint.id, b.owner);
      const ai = g.ais.find((x) => x.companyId === b.owner && !x.disposed);
      if (ai) {
        let p = planners.get(ai);
        if (!p) { p = new NetPlanner(ai); planners.set(ai, p); }
        p.offerThrough(joint.id, econ.value.revenue, econ.value.trips * 12, bought, [a.id, b.id]);
      }
    }
    yield;
  }

  /**
   * Free room for more trains on a line's track: directional double track takes many; single track about one train
   * per passing place (stations with two platform tracks, passing loops), two at least (they cross at the ends). All
   * trains of every line sharing a stretch of it (two of its stations) count, of every operator.
   */
  private xlinkRoom(l: Line): number {
    const g = this.g;
    const stops = new Set(l.stops);
    const sts = [...stops].map((sid) => g.stations.get(sid)).filter((x): x is Station => !!x?.rail);
    const track = this.xlinkTrack(l);
    const cap = track.double ? 8 : Math.max(2, sts.filter((x) => x.rail!.tracks >= 2).length) + track.loops;
    let trains = 0;
    for (const x of g.lines.map.values()) if (x.kind === 'rail' && new Set(x.stops.filter((sid) => stops.has(sid))).size >= 2) trains += x.vehicles.length;
    return cap - trains;
  }

  /** The operating company's record of a line (any AI controller's). */
  private xlinkInfo(l: Line): (ManagedLine & { loops?: number }) | undefined {
    for (const ai of this.g.ais) { const info = (ai as unknown as { lines?: Map<number, ManagedLine & { loops?: number }> }).lines?.get(l.id); if (info) return info; }
    return undefined;
  }

  /** Double track: the owner's record, else a second track beside most of the line's route. */
  private xlinkDouble(l: Line): boolean { return this.xlinkTrack(l).double; }

  /**
   * A line's track between its stops: double (the owner's record, else a second track beside four fifths of its
   * route), and the passing loops along its single track (stretches of 20+ units with a second track beside them;
   * the owner's recorded loops at least).
   */
  private xlinkTrack(l: Line): { double: boolean; loops: number } {
    const info = this.xlinkInfo(l);
    if (info?.double) return { double: true, loops: 0 };
    const legs = this.lineLegs(l), q = { x: 0, y: 0, z: 0 }, t = { x: 0, y: 0, z: 0 }, skip = new Set(legs.map((p) => p.edge.id));
    let twin = 0, all = 0, run = 0, loops = 0, leg = -1;
    for (const p of legs) {
      if (p.leg !== leg) { if (run >= 20) loops++; run = 0; leg = p.leg; }
      if (p.edge.len < 0.5) continue;
      all += p.edge.len;
      this.g.world.net.pointAt(p.edge, p.edge.len / 2, q, t);
      const tl = Math.hypot(t.x, t.z) || 1;
      if (trackBeside(this.g, q.x, q.z, t.x / tl, t.z / tl, skip)) { twin += p.edge.len; run += p.edge.len; }
      else { if (run >= 20) loops++; run = 0; }
    }
    if (run >= 20) loops++;
    return { double: all > 0 && twin >= all * 0.8, loops: Math.max(loops, info?.loops ?? 0) };
  }

  /**
   * Whether a single-track side of a link needs a passing loop, and has room for one: the curve's end at (x, z) far
   * from the direct service's next stop on that side (beyond XLINK_SPAN), with plain track for a loop between them
   * (12 units off the junction, XLINK_LOOP long, short of the stop's throat). 'near': no loop needed; 'loop': one fits;
   * 'none': neither (the direct trains would hold both lines' sections at once).
   */
  private xlinkSide(x: number, z: number, sid: number): 'near' | 'loop' | 'none' {
    if (this.xlinkNearStop(x, z, sid)) return 'near';
    const st = this.g.stations.get(sid), r = st?.rail;
    if (!r) return 'none';
    return Math.hypot(x - r.x, z - r.z) - r.length / 2 >= 12 + XLINK_LOOP + 30 ? 'loop' : 'none';
  }

  /**
   * What a passing loop of XLINK_LOOP units costs, roughly: its second track, turnouts and signals (on flat ground
   * one was measured at 308k for standard track: 272k of track, 36k of signals).
   */
  private xlinkLoopCost(type = 'standard'): number { return XLINK_LOOP * (TRACK_TYPES[type] ?? TRACK_TYPES.standard).costPerUnit + 40_000; }

  /**
   * A passing loop on line `l`'s single track next to a link's junction near (x, z), between it and the direct
   * service's stop `stop` on that side: the route's track from the junction towards the stop is cut 12 units off the
   * junction and XLINK_LOOP further on (short of the stop's throat), and that stretch gets a second track
   * (directional, with its signals: trains wait there for the next section). Our works, on the partner's track under
   * mutual open access too (as the pair task's joint works: its titles restored, the new track ours). True when built.
   */
  private xlinkLoop(l: Line, x: number, z: number, stop: number): boolean {
    const g = this.g, net = g.world.net;
    const start = net.nearestNode(x, z, 1.5, 'rail', (n) => n.edges.length >= 3);
    if (!start) return false;
    // the route's track from the junction towards the stop (its pieces in order, each with the node it is entered
    // from), up to the stop's platforms: each way from the junction, the one reaching that stop
    const walk = (): { e: NEdge; from: number }[] | null => {
      const route = new Set(this.lineLegs(l).map((p) => p.edge.id));
      for (const first of start.edges) {
        if (!route.has(first)) continue;
        const chain: { e: NEdge; from: number }[] = [];
        let at = start.id, cur = net.edges.get(first);
        for (let k = 0; cur && k < 400; k++) {
          if (cur.station >= 0 || g.stations.throughStationOf(cur.id) >= 0) {
            if (cur.station === stop || g.stations.throughStationOf(cur.id) === stop) return chain;
            break;
          }
          chain.push({ e: cur, from: at });
          const node = net.nodes.get(cur.a === at ? cur.b : cur.a);
          if (!node) break;
          at = node.id;
          const prev: NEdge = cur;
          cur = node.edges.map((id) => net.edges.get(id)).find((e): e is NEdge => !!e && e.id !== prev.id && (route.has(e.id) || e.station >= 0 || g.stations.throughStationOf(e.id) >= 0));
        }
      }
      return null;
    };
    let chain = walk();
    if (!chain) return false;
    for (const { e } of chain) if (!this.mayAlter([e.id]) || g.vehicles.isEdgeBusy(e.id)) return false;
    // (the stop's throat: the last 30 units of the walk are its approach)
    const total = chain.reduce((s2, c) => s2 + c.e.len, 0), lo = 12, hi = 12 + XLINK_LOOP;
    if (hi > total - 30) return false;
    // the loop's ends: the track cut there (a node within a unit of either is used as it is)
    for (const cut of [hi, lo]) {
      let u = 0;
      for (const c of chain) {
        if (cut > u + 1 && cut < u + c.e.len - 1) { net.splitEdge(c.e.id, c.from === c.e.a ? cut - u : c.e.len - (cut - u)); break; }
        u += c.e.len;
      }
      chain = walk();
      if (!chain) return false;
    }
    const pick: NEdge[] = [];
    let u = 0;
    for (const c of chain) { if (u >= lo - 1 && u + c.e.len <= hi + 1) pick.push(c.e); u += c.e.len; }
    if (pick.reduce((s2, e) => s2 + e.len, 0) < XLINK_LOOP - 2) return false;
    // joint works: the titles are the builder's while planning and laying it, then restored (split pieces too)
    const owners = new Map<number, number>(), nodes = new Map<number, number>();
    for (const e of pick) {
      owners.set(e.id, e.owner);
      for (const nid of [e.a, e.b]) { const n = net.nodes.get(nid)!; if (!nodes.has(nid)) nodes.set(nid, n.owner); n.owner = this.me; }
      e.owner = this.me;
    }
    const split = (old: NEdge, a: NEdge, b: NEdge) => {
      const owner = owners.get(old.id);
      if (owner === undefined) return;
      owners.set(a.id, owner); owners.set(b.id, owner);
      const n = a.a === old.a ? a.b : a.a;
      if (!nodes.has(n)) nodes.set(n, owner);
    };
    net.onSplit.push(split);
    let built = false;
    try {
      // every piece, as planned and as built (commitDoubleTrack's fallbacks), crosses only with its owner's consent, never
      // the player's track at grade, and demolishes nothing (a rollback could not rebuild it)
      const consent = (prop: Proposal, planned = false) => this.proposalConsent(prop, planned) && prop.demolish.length === 0;
      for (const side of [1, -1] as const) {
        const plan = Trackops.planDoubleTrack(g, pick.map((e) => e.id), side, this.me);
        if (!plan.ok || !this.mayAlter(plan.steps.map((st) => st.edge)) || !plan.proposals.every((prop) => consent(prop, true))) continue;
        if (!Trackops.commitDoubleTrack(g, plan, true, {}, consent).error) { built = true; break; }
      }
    } finally {
      net.onSplit.splice(net.onSplit.indexOf(split), 1);
      for (const [id, owner] of owners) { const e = net.edges.get(id); if (e) e.owner = owner; }
      for (const [id, owner] of nodes) { const n = net.nodes.get(id); if (n) n.owner = owner; }
      net.version++; g.onNetworkChanged();
    }
    return built;
  }

  /** A single-track side's curve end (x, z) close to the direct service's passing stop there (XLINK_SPAN), where its trains wait. */
  private xlinkNearStop(x: number, z: number, sid: number): boolean {
    const st = this.g.stations.get(sid), r = st?.rail;
    return !!r && r.tracks >= 2 && Math.hypot(x - r.x, z - r.z) - r.length / 2 <= XLINK_SPAN;
  }

  /** Take up new pieces of track (a rolled-back link) without a removal fee; split halves of older track stay. */
  private xlinkRemove(ids: number[]) {
    const g = this.g, net = g.world.net;
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity, n = 0;
    for (const id of ids) {
      const e = net.edges.get(id);
      if (!e || g.vehicles.isEdgeBusy(id)) continue;
      const box = net.grid.box(id);
      if (box) { x0 = Math.min(x0, box[0]); z0 = Math.min(z0, box[1]); x1 = Math.max(x1, box[2]); z1 = Math.max(z1, box[3]); }
      net.removeEdge(id);
      n++;
    }
    if (n && Number.isFinite(x0)) recomputeLocks(g.world, x0, z0, x1, z1);
    net.version++;
    g.onNetworkChanged();
  }

  /** Lines (any company's, AI) whose route lies inside a new joint line become its patterns; every controller follows the merge. */
  private xlinkCanon(lineId: number) {
    if (!PAT.canonicalizeLines) return;
    const g = this.g;
    const infos = g.ais.map((ai) => ({ ai, map: (ai as unknown as { lines?: Map<number, ManagedLine> }).lines }));
    try {
      for (const nt of PAT.canonicalizeLines(g, lineId)) {
        const into = g.lines.get(nt.into);
        for (const o of infos) {
          const info = o.map?.get(nt.from);
          if (!info || !o.map) continue;
          o.map.delete(nt.from);
          if (into && !o.map.has(into.id)) o.map.set(into.id, { ...info, towns: [...new Set(into.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))],
            shared: into.owner === o.ai.companyId ? undefined : into.owner, joined: into.owner === o.ai.companyId ? undefined : true });
        }
        this.note(nt.text);
        this.bump('netLinesMerged');
      }
    } catch (e) { this.note('line merge failed: ' + String((e as Error)?.message ?? e)); }
  }

  /** The network planner of company `owner` (an AI company's; null for the player or a company gone). */
  private plannerOf(owner: number): NetPlanner | null {
    const ai = this.g.ais.find((x) => x.companyId === owner && !x.disposed);
    if (!ai) return null;
    let p = planners.get(ai);
    if (!p) { p = new NetPlanner(ai); planners.set(ai, p); }
    return p;
  }

  /**
   * Could this company put one through train of its own on a direct service over `path` (`legs` its track), as
   * offerThrough would? Its money rules (without borrowing yet), a consist of its own or the year's that fits, a depot
   * reaching one of its stations on the route. The economics and the room are the caller's.
   */
  private throughTrainPossible(path: number[], legs: { edge: NEdge }[]): boolean {
    const g = this.g, me = this.me, e = this.eco;
    if (this.buildBar()) return false;
    const credit = Math.max(0, e.maxLoan * Math.min(0.97, this.ai.loanAppetite + 0.2) - e.loan);
    const cars = this.xlinkStock(g.lines.all().filter((x) => x.kind === 'rail' && x.owner === me), path, legs);
    if (!cars) return false;
    const cost = cars.reduce((s, m) => s + m.cost, 0) * 1.2 + 150_000;
    if (cost > Math.max(0, this.networkBudget()) * 0.3 || e.money + credit < cost) return false;
    return [...g.depots.map.values()].some((d) => d.owner === me && d.kind === 'rail' && path.some((sid) => g.stations.get(sid)?.owner === me && depotReaches(g, d, sid, cars)));
  }

  /**
   * Mutual through running, the partner's side: another company's direct service across our networks, offered
   * under open access (`revenue`: what its `riders` a year would pay, as many as trains can carry). One train of ours
   * on it when its share of the riders (one train more among `theirTrains + 1`, within the seats) pays for its
   * running, the fees for the other's stations and track, and its price within our horizon, as our money rules
   * allow; room left on the line and on the lines whose track it shares (`shared`). True when a train was bought.
   */
  offerThrough(lineId: number, revenue: number, riders: number, theirTrains: number, shared: number[] = []): boolean {
    const g = this.g, me = this.me, l = g.lines.get(lineId);
    if (!l || l.owner === me || l.kind !== 'rail' || !this.agrees(l.owner) || this.fleet(l).ours.length) return false;
    const path = this.pathOf(l);
    if (!path || !g.lines.canOperate(l, me) && g.lines.join(l.id, me) !== null) { this.considered('xlink.partner.operator'); return false; }
    if (this.ai.railPolicy.deepTrouble || !this.mayBuild()) { this.considered('xlink.partner.funds'); return false; }
    const legs = this.lineLegs(l);
    const mine = g.lines.all().filter((x) => x.kind === 'rail' && x.owner === me);
    const cars = this.xlinkStock(mine, path, legs);
    if (!cars) { this.considered('xlink.partner.stock'); return false; }
    const depot = [...g.depots.map.values()].filter((d) => d.owner === me && d.kind === 'rail').sort((x, y) => x.id - y.id)
      .find((d) => path.some((sid) => g.stations.get(sid)?.owner === me && depotReaches(g, d, sid, cars)));
    if (!depot) { this.considered('xlink.partner.depot'); return false; }
    const length = legs.reduce((s, p) => s + p.edge.len, 0), year = estimateVehicleYear(cars, length / Math.max(1, path.length - 1), g.year, 0.4);
    const kmh = Math.max(20, year.km / (YEAR_S / 3600)), cycle = 2 * length * UNIT_M / (kmh / 3.6);
    const perTrain = cars.reduce((s, m) => s + m.capacity, 0) * 0.8 * 2 * YEAR_S / Math.max(1, cycle);
    const share = riders > 0 ? revenue * Math.min(1, perTrain * (theirTrains + 1) / riders) / (theirTrains + 1) : 0;
    const fees = this.xlinkFees(l.owner, path, legs.map((p) => p.edge), 1, theirTrains);
    const cost = cars.reduce((s, m) => s + m.cost, 0);
    const net = share - year.total - fees;
    if (net <= this.xlinkNeed(0, cost)) { this.considered('xlink.partner.payback'); return false; }
    // room on the direct service and on the lines whose track it shares (all their trains count)
    const lines = [l, ...shared.map((id) => g.lines.get(id)).filter((x): x is Line => !!x && x.id !== l.id)];
    const counted = (x: Line) => x === l || new Set(l.stops.filter((sid) => x.stops.includes(sid))).size >= 2;
    if (lines.some((x) => this.xlinkRoom(x) - (counted(x) ? 0 : l.vehicles.length) < 1)) { this.considered('xlink.partner.room'); return false; }
    if (!this.canSpend(cost * 1.2 + 150_000, 0.3)) { this.considered('xlink.partner.funds'); return false; }
    const t = g.vehicles.buyTrain(depot.id, cars, l.id);
    if (typeof t === 'string') { this.considered('xlink.partner.train'); return false; }
    this.managed()?.set(l.id, { kind: 'rail', towns: [...new Set(path.map((sid) => g.stations.get(sid)?.townId ?? -1).filter((x) => x >= 0))],
      depot: depot.id, maxVehicles: 1, opened: g.day, shared: l.owner, joined: true });
    this.ai.stats.vehicles++;
    this.bump('netXPartner');
    this.note(`through running on ${g.company(l.owner).name}'s ${l.name}: a train of ours across both networks (${Math.round(net / 1000)}k a year)`);
    return true;
  }

  private *connectTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const P = { x: 0, y: 0, z: 0 }, D = { x: 0, y: 0, z: 0 };
    let built = 0;
    for (const st of this.selected(g.stations.map.values(), ids)) {
      if (built >= 1) return;
      if (st.owner !== me || !st.rail || railPartMode(st.rail) !== 'mainline' || (st.rail.level ?? 'ground') !== 'ground') continue;
      if (!this.mayAlter([...st.rail.edges, ...st.rail.throughEdges, ...this.approachOf(st, 80)])) continue;
      const lines = this.linesAt(st.id).filter((l) => l.owner === me && l.kind === 'rail' && this.fleet(l).ours.length);
      const ending = lines.filter((l) => { const p = this.pathOf(l); return !!p && (p[0] === st.id || p[p.length - 1] === st.id); });
      if (!ending.length) continue;
      this.considered('connect.termini');
      for (const end of ['front', 'back'] as const) {
        const key = `conn${st.id}${end}`;
        if (this.cared(key) || !this.freeEnd(st, end)) continue;
        this.considered('connect.freeEnd');
        this.careFor(key, 180);
        const r = st.rail, sg = end === 'front' ? 1 : -1, fx = Math.sin(r.angle) * sg, fz = Math.cos(r.angle) * sg;
        const cx = r.x + (fx * r.length) / 2, cz = r.z + (fz * r.length) / 2;
        const mine = this.approachOf(st, 90);
        const cands: { e: NEdge; s: number; x: number; z: number; y: number; d: number; dir: 1 | -1 }[] = [];
        for (const e of net.edgesNear(cx - 80, cz - 80, cx + 80, cz + 80)) {
          if (e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || mine.has(e.id) || g.stations.throughStationOf(e.id) >= 0) continue;
          if (!this.mayAlter([e.id])) continue;
          if (railModeOf(e.type) !== 'mainline') continue;
          for (let s = 2; s <= e.len - 2; s += 3) {
            net.pointAt(e, s, P, D);
            const dx = P.x - cx, dz = P.z - cz, d = Math.hypot(dx, dz);
            if (d < 14 || d > 80 || (dx * fx + dz * fz) / d < 0.55 || net.sectionAt(e, s) !== 'ground') continue;
            if (Math.abs(P.y - r.y) > 0.03 * d) continue;
            const tl = Math.hypot(D.x, D.z) || 1, tx = D.x / tl, tz = D.z / tl;
            // the curve joins the track tangentially, travelling on the way the chord points
            const along = (dx * tx + dz * tz) / d;
            if (Math.abs(along) < 0.35) continue;
            cands.push({ e, s, x: P.x, z: P.z, y: P.y, d, dir: along > 0 ? 1 : -1 });
          }
        }
        if (!cands.length) continue;
        this.considered('connect.nearTrack');
        cands.sort((p, q) => p.d - q.d);
        yield;
        // the best target: the station the junction leads to that our trains would serve best
        let best: { c: (typeof cands)[number]; dest: number; line: Line; value: number; revenue: number } | null = null;
        const tried = new Set<string>();
        for (const c of cands.slice(0, 24)) {
          const dest = this.stationAlong(c.e, c.s, c.dir, 320, st.id);
          if (!dest) continue;
          const k = `${c.e.id}:${dest.station}`;
          if (tried.has(k)) continue;
          tried.add(k);
          const S2 = g.stations.get(dest.station);
          if (!S2?.rail || (S2.owner !== me && !g.canUse(me, S2.owner)) || railPartMode(S2.rail) !== 'mainline') continue;
          for (const l of ending) {
            const path = this.pathOf(l)!;
            if (path.includes(S2.id)) continue;
            if ((l.operators ?? []).some((o) => !g.canUse(o, c.e.owner) || !g.canUse(o, S2.owner))) continue;
            const value = this.newTrips(path, [S2.id], true, this.headway([l]));
            networkProfile.decisions['connect.maxTrips'] = Math.max(networkProfile.decisions['connect.maxTrips'] ?? 0, value.trips);
            if (value.trips >= networkOptions.throughTrips && (!best || value.trips > best.value)) best = { c, dest: S2.id, line: l, value: value.trips, revenue: value.revenue };
          }
        }
        if (!best) continue;
        this.considered('connect.demand');
        // the free end nearest the junction leads; the others join it at the throat
        const ends = g.stations.trackEnds(st).map((t) => t[end]);
        const free = ends.filter((id) => net.nodes.get(id)?.edges.length === 1);
        const lead = (free.length ? free : [...ends]).sort((p, q) => { const a = net.nodes.get(p)!, b = net.nodes.get(q)!; return Math.hypot(a.x - best!.c.x, a.z - best!.c.z) - Math.hypot(b.x - best!.c.x, b.z - best!.c.z); })[0];
        const snap: Snap = { kind: 'edge', x: best.c.x, z: best.c.z, y: best.c.y, edge: best.c.e.id, s: best.c.s };
        const prop = planEdge(g, nodeSnap(g, lead, 'rail'), snap, this.railOpts(r.trackType));
        if (!prop.ok || !this.proposalConsent(prop) || !this.demolitionOk(prop.demolish)) { this.note(`no junction from ${st.name} towards ${g.stations.get(best.dest)?.name}: ${prop.errors[0] ?? 'buildings or ownership in the way'}`); continue; }
        if (networkOptions.throughTrips > 0 && prop.cost > best.revenue * 8) continue;
        if (!this.canSpend(prop.cost * 1.3 + 200_000, 0.25)) return;
        const directional = this.oneWayAround(best.c.e);
        const dem = [...prop.demolish];
        const { result: err, edges: made } = this.builtEdges(() => {
          const err = commitProposal(g, prop);
          if (!err) {
            OPS.connectStationThroat?.(g, st.id, me);
            if (directional && (!routeBetween(g, st.id, best!.dest, me) || !routeBetween(g, best!.dest, st.id, me))) this.junctionCrossover(best!.c);
          }
          return err;
        });
        if (err) continue;
        this.compensate(dem);
        // the line runs on to the station beyond the junction (and back): else the junction goes again
        const l = best.line, path = this.pathOf(l)!;
        const np = path[path.length - 1] === st.id ? [...path, best.dest] : [best.dest, ...path];
        if ([me, ...(l.operators ?? [])].some((o) => !routeBetween(g, st.id, best!.dest, o) || !routeBetween(g, best!.dest, st.id, o))) {
          removeEdges(g, made, me);
          this.note(`junction from ${st.name} taken up again: no way through to ${g.stations.get(best.dest)?.name}`);
          continue;
        }
        this.setStops(l, outAndBack(np));
        const info = this.managed()?.get(l.id);
        if (info) { info.maxVehicles = Math.max(info.maxVehicles, Math.min(6, np.length + 1)); info.towns = [...new Set(np.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))]; }
        this.signal(l.id);
        this.canon(l.id);
        this.bump('connections');
        this.bump('netThrough');
        built++;
        const S2 = g.stations.get(best.dest)!;
        this.note(`junction at ${st.name}: ${l.name} runs through to ${S2.name} (${Math.round(best.value)} trips a month)`);
        this.news(`connects ${st.name} with the line to ${S2.name}: through trains.`, st.x, st.z);
        yield;
        break;
      }
    }
  }

  // ================================================================ stations inserted where towns grew (9l)
  /** Residents within a station's catchment at (x, z) along a line not covered by any other rail station there. */
  private uncovered(x: number, z: number, angle: number, length: number, mode: 'mainline' | 'metro' | 'lightrail', coverCache: Map<number, boolean>, existing: { x: number; z: number; r: number }[]): number {
    // (one walking reach for every rail style, `mode` sets only the callers' spacing and thresholds; but an in-city
    // metro / light-rail stop walks half as far, CITY_WALK_SCALE)
    const g = this.g, w = g.world;
    const scale = mode !== 'mainline' && g.stations.cityAt(x, z, g.towns.nearest(x, z)) ? CITY_WALK_SCALE : 1;
    const shapes = railCatchShapes(x, z, angle, length, true, 'rail', 0, scale);
    let pop = 0;
    const seen = new Set<number>();
    for (const c of shapes) for (const id of w.bgrid.query(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r)) {
      if (seen.has(id)) continue;
      const b = w.buildings.get(id);
      if (!b || (b.x - c.x) ** 2 + (b.z - c.z) ** 2 > c.r * c.r) continue;
      seen.add(id);
      let cov = coverCache.get(id);
      if (cov === undefined) {
        // A missing access street is a reason to repair access, not to duplicate a station's catchment.
        cov = existing.some((c) => (b.x - c.x) ** 2 + (b.z - c.z) ** 2 <= c.r * c.r);
        coverCache.set(id, cov);
      }
      if (!cov) pop += b.pop;
    }
    return pop;
  }

  /** Add a new through station to every own line whose route between consecutive stops now runs through it. */
  private addToLines(stationId: number, before: Map<number, [number, number][]>): Line[] {
    const g = this.g, net = g.world.net, out: Line[] = [];
    const st = g.stations.get(stationId);
    if (!st?.rail) return out;
    const own = new Set([...st.rail.edges, ...st.rail.throughEdges]);
    for (const [lid, pairs] of before) {
      const l = g.lines.get(lid);
      if (!l || l.owner !== this.me) continue;
      for (const [a, b] of pairs) {
        if (a === stationId || b === stationId) continue;
        const r = routeBetween(g, a, b, l.owner);
        if (!r || !r.some((id) => own.has(id) || net.edges.get(id)?.station === stationId)) continue;
        if (this.insertStop(l, a, b, stationId)) { this.localOnly(l, stationId); out.push(l); }
        break;
      }
    }
    for (const l of out) { this.signal(l.id); this.canon(l.id); }
    return out;
  }

  /** Make sure a new ground station is reached from the roads (an access street to the nearest road). */
  private roadAccess(st: Station) {
    const g = this.g, net = g.world.net;
    if (!st.rail || g.stations.hasAccess(st)) return;
    const b = st.rail.building;
    const ne = net.nearestEdge(b.x, b.z, 30, 'road', (e) => e.depot < 0);
    if (!ne) return;
    const q = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, q);
    const d = Math.hypot(q.x - b.x, q.z - b.z) || 1, off = Math.max(b.w, b.d) / 2 + 0.8;
    const from: Snap = { kind: 'free', x: b.x + ((q.x - b.x) / d) * off, z: b.z + ((q.z - b.z) / d) * off, y: 0 };
    const pj = planEdge(g, from, { kind: 'edge', x: q.x, z: q.z, y: q.y, edge: ne.edge.id, s: ne.s }, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.me });
    if (pj.ok && this.proposalConsent(pj) && pj.demolish.length <= 1 && this.canSpend(pj.cost, 0.1) && !commitProposal(g, pj)) g.stations.refreshAccess(true);
  }

  /**
   * Insert a through station into own track at (edge, s), trying a little either way along `steps` (edge, s)
   * where the plan fails (straight level track needed). Returns the new station id or -1 ('busy': -2).
   */
  private *insertAt(spots: { e: number; s: number }[], length: number, why: string, maxCost: number, opts: { tracks?: number; mode?: import('./stations').RailMode; accept?: (p: OnTrackPlanLike) => boolean } = {}): Generator<void, number> {
    const g = this.g, me = this.me;
    if (!OPS.planStationOnTrack || !OPS.commitStationOnTrack) return -1;
    let firstErr = '';
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (!this.mayAlter([sp.e])) continue;
      const plan = OPS.planStationOnTrack(g, sp.e, sp.s, { length, tracks: opts.tracks, mode: opts.mode, style: 'none' }, me);
      if (i % 3 === 2) yield;
      if (!plan.ok) { this.considered('station.site'); firstErr ||= plan.error ?? ''; continue; }
      if (opts.accept && !opts.accept(plan)) { this.considered('station.catchmentOrSpacing'); firstErr ||= 'catchment, spacing or value'; continue; }
      if (plan.cost > maxCost || !this.canSpend(plan.cost * 1.1, 0.3)) { this.considered('station.paybackOrFunds'); firstErr ||= `too expensive (${Math.round(plan.cost / 1000)}k)`; continue; }
      const res = OPS.commitStationOnTrack(g, plan);
      if (res.error === 'busy') return -2;
      if (res.station < 0 || !g.stations.get(res.station)) { firstErr ||= res.error ?? ''; continue; }
      return res.station;
    }
    if (firstErr) this.note(`${why}: ${firstErr}`);
    return -1;
  }

  /** Spots along a route (own plain track) every `step` units, nearest to (x, z) first. */
  private spotsNear(route: number[], x: number, z: number, maxD: number, step = 3): { e: number; s: number; d: number }[] {
    const g = this.g, net = g.world.net, q = { x: 0, y: 0, z: 0 }, out: { e: number; s: number; d: number }[] = [];
    for (const id of route) {
      const e = net.edges.get(id);
      if (!e || e.owner !== this.me || e.station >= 0 || e.depot >= 0 || e.len < 1 || g.stations.throughStationOf(e.id) >= 0) continue;
      const margin = Math.min(2, e.len / 2);
      for (let s = margin; s <= e.len - margin + 1e-6; s += step) {
        net.pointAt(e, s, q);
        const d = Math.hypot(q.x - x, q.z - z);
        if (d <= maxD) out.push({ e: e.id, s, d });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  private *insertTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planStationOnTrack) return;
    const q = { x: 0, y: 0, z: 0 }, dq = { x: 0, y: 0, z: 0 };
    const cover = new Map<string, Map<number, boolean>>();
    for (const l of this.selected(g.lines.map.values(), ids)) {
      if (l.owner !== me || l.kind !== 'rail' || this.cared('ins' + l.id) || !this.fleet(l).ours.length) continue;
      this.considered('insert.line');
      this.careFor('ins' + l.id, 180);
      const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
      if (sts.length < 2) continue;
      const mode = railPartMode(sts[0].rail!);
      let covered = cover.get(mode);
      if (!covered) cover.set(mode, covered = new Map());
      // (every rail station covers its residents, whatever its track type)
      const existing = [...g.stations.map.values()].filter((s) => s.rail).flatMap((s) => g.stations.catchmentShapes(s, true));
      const spacing = MIN_SPACING[mode], R = CATCHMENT_RADIUS.rail;
      const platform = this.platformFor(l);
      let best: { e: number; s: number; pop: number; x: number; z: number; a: number; b: number } | null = null;
      for (const [a, b] of this.pairsOf(l)) {
        const A = g.stations.get(a), B = g.stations.get(b);
        if (!A || !B || Math.hypot(A.x - B.x, A.z - B.z) < spacing * 2) { this.considered('insert.shortLeg'); continue; }
        const r = this.route(a, b);
        yield;
        if (!r) continue;
        let k = 0;
        for (const id of r) {
          const e = net.edges.get(id);
          if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0 || e.len < 1 || g.stations.throughStationOf(e.id) >= 0) continue;
          // Signal and upgrade work splits straight approaches into ~3-unit pieces. The station
          // planner follows their chain; requiring each individual piece to hold a platform misses it.
          const margin = Math.min(3, e.len / 2);
          for (let s = margin; s <= e.len - margin + 1e-6; s += 6) {
            if (++k % 6 === 0) yield;
            net.pointAt(e, s, q, dq);
            // dense spacing rules: clear of every rail station of the mode (any line, any company)
            let near = false;
            for (const o of g.stations.footprintsNear(q.x, q.z, spacing)) if (o.rail && railPartMode(o.rail) === mode && Math.hypot(o.rail.x - q.x, o.rail.z - q.z) < spacing) { near = true; break; }
            if (near) continue;
            // (open country: nothing to cover)
            if (!g.world.bgrid.query(q.x - R, q.z - R, q.x + R, q.z + R).length) continue;
            const pop = this.uncovered(q.x, q.z, Math.atan2(dq.x, dq.z), platform, mode, covered, existing);
            networkProfile.decisions['insert.maxPop'] = Math.max(networkProfile.decisions['insert.maxPop'] ?? 0, pop);
            if (pop >= INSERT_POP[mode] * networkOptions.insertPop && (!best || pop > best.pop)) best = { e: e.id, s, pop, x: q.x, z: q.z, a, b };
          }
        }
      }
      if (!best) { this.considered('insert.noPopulation'); continue; }
      this.considered('insert.population');
      const route = this.route(best.a, best.b) ?? [best.e];
      // The most populated point may be on a curve. Look farther along the line, checking the
      // actual planned catchment and spacing before spending on a nearby, straighter site.
      const spots = this.spotsNear(route, best.x, best.z, spacing).slice(0, 36);
      const before = new Map<number, [number, number][]>();
      for (const o of g.lines.map.values()) if (o.owner === me && o.kind === 'rail') before.set(o.id, this.pairsOf(o));
      const town = g.towns.nearest(best.x, best.z);
      // Net revenue at today's passenger rate and fares must cover the station within eight years.
      const upkeep = 20_000 + 2 * platform * 500;
      const value = this.residentValue(sts[0]);
      const maxCost = Math.max(0, best.pop * value - upkeep) * 8;
      let servedPop = best.pop;
      const accept = (p: OnTrackPlanLike) => {
        const st = p.station;
        if (!st || [...g.stations.map.values()].some((o) => o.rail && railPartMode(o.rail) === mode && Math.hypot(o.x - st.x, o.z - st.z) < spacing)) return false;
        const pop = this.uncovered(st.x, st.z, st.angle, st.length, mode, covered!, existing);
        if (pop < INSERT_POP[mode] * networkOptions.insertPop || p.cost > Math.max(0, pop * value - upkeep) * 8) return false;
        servedPop = pop;
        return true;
      };
      // A one-train single-track service needs a halt, not a new passing station. The planner retains
      // existing parallel tracks; add another platform only when several trains need to pass here.
      const id = yield* this.insertAt(spots, platform, `no station site in ${town?.name ?? 'town'} on ${l.name}`, maxCost, { tracks: l.vehicles.length > 1 ? 2 : 1, mode, accept });
      if (id === -2) { this.careFor('ins' + l.id, 15); continue; }
      if (id < 0) continue;
      const st = g.stations.get(id)!;
      this.roadAccess(st);
      const served = this.addToLines(id, before);
      this.bump('netInserted');
      this.note(`station ${st.name} on ${served.map((x) => x.name).join(', ') || l.name} (${servedPop} residents beyond the stations' reach)`);
      this.news(`opens ${st.name} station on ${l.name}.`, st.x, st.z);
      return;
    }
  }

  // ================================================================ interchange stations (9l)
  /** Fit the trains actually using the line, rather than requiring its longest existing platforms. */
  private platformFor(l: Line): number {
    const st = this.g.stations.get(l.stops[0]);
    let length = st?.rail ? PLATFORM_LENGTH[railPartMode(st.rail)] : defaultPlatformLength();
    for (const id of l.vehicles) {
      const v = this.g.vehicles.get(id) as unknown as { length?: number } | undefined;
      if (v?.length) length = Math.max(length, Math.ceil(v.length + 0.5));
    }
    return length;
  }

  /** Sample points of a line's route (every ~3 units), with the edge and whether the track there is ours. */
  private routeSamples(l: Line): { x: number; z: number; e: number; s: number }[] {
    const g = this.g, net = g.world.net, out: { x: number; z: number; e: number; s: number }[] = [];
    const seen = new Set<number>(), q = { x: 0, y: 0, z: 0 };
    for (const [a, b] of this.pairsOf(l)) for (const id of this.route(a, b, l.owner) ?? []) {
      if (seen.has(id)) continue;
      seen.add(id);
      const e = net.edges.get(id);
      if (!e || e.station >= 0) continue;
      for (let s = 1; s < e.len; s += 3) { net.pointAt(e, s, q); out.push({ x: q.x, z: q.z, e: e.id, s }); }
    }
    return out;
  }

  /** Walking gap between a planned station (centre, axis, platform length) and a station's platform area (approx.). */
  private planGap(p: { x: number; z: number; angle: number; length: number }, st: Station): number {
    const r = st.rail;
    if (!r) return Infinity;
    const pts = (x: number, z: number, a: number, L: number) => { const out: [number, number][] = []; for (let t = -L / 2; t <= L / 2 + 1e-6; t += 1) out.push([x + Math.sin(a) * t, z + Math.cos(a) * t]); return out; };
    let d = Infinity;
    for (const [ax, az] of pts(p.x, p.z, p.angle, p.length)) for (const [bx, bz] of pts(r.x, r.z, r.angle, r.length)) d = Math.min(d, Math.hypot(ax - bx, az - bz));
    return Math.max(0, d - 1.2);
  }

  /** Distance from a spot on a track to a station's centre. */
  private spotGap(sp: { e: number; s: number }, st: Station): number {
    const net = this.g.world.net, e = net.edges.get(sp.e), q = { x: 0, y: 0, z: 0 };
    if (!e) return Infinity;
    net.pointAt(e, sp.s, q);
    return Math.hypot(q.x - st.x, q.z - st.z);
  }

  private *interchangeTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planStationOnTrack) return;
    const rail = [...g.lines.map.values()].filter((l) => l.kind === 'rail' && l.stops.length >= 2 && l.vehicles.length);
    const ours = rail.filter((l) => ids.includes(l.id) && l.owner === me && this.fleet(l).ours.length);
    if (!ours.length) return;
    if (ours.length < 2) this.considered('interchange.fewOwnLines');
    const samples = new Map<number, { x: number; z: number; e: number; s: number }[]>();
    for (const l of rail) { samples.set(l.id, this.routeSamples(l)); yield; }
    const stationsOf = (l: Line) => [...new Set(l.stops)];
    const complexOf = (id: number) => new Set(g.stations.complex(id));
    let best: { l1: Line; l2: Line; p: { x: number; z: number }; value: number; revenue: number; shared: boolean } | null = null;
    for (const l1 of ours) for (const l2 of rail) {
      // planStationOnTrack rebuilds only own track. One isolated halt at another operator's crossing
      // would not provide a transfer: require both parts, under the same company's control.
      if (l1 === l2 || l2.owner !== me || this.cared(`ix${Math.min(l1.id, l2.id)}:${Math.max(l1.id, l2.id)}`)) continue;
      const s1 = stationsOf(l1), s2 = stationsOf(l2);
      // a station (complex) in common: they meet there already
      if (s1.some((a) => { const c = complexOf(a); return s2.some((b) => c.has(b)); })) { this.considered('interchange.alreadyMeet'); continue; }
      const stations = [...s1, ...s2].map((id) => g.stations.get(id)).filter((st): st is Station => !!st);
      const S1 = samples.get(l1.id) ?? [], S2 = samples.get(l2.id) ?? [];
      if (!S1.length || !S2.length) continue;
      // where the routes cross or touch (the closest pair of points within 6 units)
      const C = 8, cells = new Map<number, number[]>(), key = (x: number, z: number) => Math.floor(x / C) * 65536 + Math.floor(z / C);
      S2.forEach((p, i) => { const k = key(p.x, p.z); let a = cells.get(k); if (!a) cells.set(k, a = []); a.push(i); });
      let meet: { x: number; z: number; d: number; shared: boolean } | null = null;
      for (const p of S1) for (let cx = Math.floor((p.x - 6) / C); cx <= Math.floor((p.x + 6) / C); cx++) for (let cz = Math.floor((p.z - 6) / C); cz <= Math.floor((p.z + 6) / C); cz++) {
        for (const i of cells.get(cx * 65536 + cz) ?? []) {
          const q = S2[i], d = Math.hypot(q.x - p.x, q.z - p.z);
          if (d > 6 || (meet && d >= meet.d)) continue;
          const x = (p.x + q.x) / 2, z = (p.z + q.z) / 2;
          if (stations.some((st) => Math.hypot(st.x - x, st.z - z) < 30)) continue;
          meet = { x, z, d, shared: q.e === p.e };
        }
      }
      if (!meet) { this.considered('interchange.noCrossing'); continue; }
      this.considered('interchange.nearTrack');
      const m = meet;
      const value = this.newTrips(s1, s2, false, this.headway([l1, l2]));
      networkProfile.decisions['interchange.maxTrips'] = Math.max(networkProfile.decisions['interchange.maxTrips'] ?? 0, value.trips);
      if (value.trips >= networkOptions.interchangeTrips && (!best || value.trips > best.value)) best = { l1, l2, p: { x: m.x, z: m.z }, value: value.trips, revenue: value.revenue, shared: m.shared };
    }
    yield;
    if (!best) return;
    this.considered('interchange.demand');
    const key = `ix${Math.min(best.l1.id, best.l2.id)}:${Math.max(best.l1.id, best.l2.id)}`;
    this.careFor(key, 720);
    const before = new Map<number, [number, number][]>();
    for (const o of g.lines.map.values()) if (o.owner === me && o.kind === 'rail') before.set(o.id, this.pairsOf(o));
    const routeOf = (l: Line) => [...new Set(this.pairsOf(l).flatMap(([a, b]) => this.route(a, b, l.owner) ?? []))];
    const where = `between ${best.l1.name} and ${best.l2.name}`;
    const made: number[] = [];
    // on shared track one station takes both lines; else a station on each line (own track), linked for transfers
    const lines = best.shared ? [best.l1] : best.l2.owner === me ? [best.l1, best.l2] : [best.l1];
    // Crossing platforms need enough length to put both parts within walking range.
    const L = Math.max(10, this.platformFor(best.l1), this.platformFor(best.l2));
    const netRevenue = Math.max(0, best.revenue - lines.length * (20_000 + 2 * L * 500));
    const maxCost = networkOptions.interchangeTrips > 0 ? Math.min(3_500_000, netRevenue * 8 / lines.length) : 3_500_000;
    for (const l of lines) {
      // (clear of the crossing: the station's throats need plain track on both sides)
      const first = made.length ? g.stations.get(made[0]) : undefined;
      const spots = this.spotsNear(routeOf(l), best.p.x, best.p.z, 30).filter((sp) => sp.d >= L / 2 + 7 && (!first || this.spotGap(sp, first) > 4)).slice(0, 14);
      // (a halt: one platform track on single track; the second within walking range of the first)
      const accept = first ? (p: OnTrackPlanLike) => !!p.station && this.planGap(p.station, first) <= 12 : undefined;
      const id = yield* this.insertAt(spots, L, `no interchange site ${where}`, maxCost, { accept });
      if (id < 0) break;
      made.push(id);
    }
    if (!made.length) return;
    // a second line not on our track: our station is linked to theirs only if within walking range; else ours alone
    if (made.length === 2) g.stations.link(made[0], made[1]);
    const served: Line[] = [];
    for (const id of made) { const st = g.stations.get(id); if (st) { this.roadAccess(st); served.push(...this.addToLines(id, before)); } }
    if (!served.length) {
      for (const id of made) g.stations.removeStation(id);
      this.note(`interchange ${where} given up: no line stops there`);
      return;
    }
    const st = g.stations.get(made[0])!;
    this.bump('netInterchanges');
    this.note(`interchange ${st.name} ${where} (${Math.round(best.value)} trips a month newly connected)`);
    this.news(`opens ${st.name}, an interchange between ${best.l1.name} and ${best.l2.name}.`, st.x, st.z);
  }

  // ================================================================ city interchanges (citycatch)
  /**
   * Our served rail lines with a town in common with another served rail line (ours, or an agreeing company's), where
   * one of the two calls at an in-city metro / light-rail station there (Station.city: near city stations).
   */
  private cityLinkPairs(): WorkItem[] {
    const g = this.g, me = this.me, out: WorkItem[] = [];
    const rail = g.lines.all().filter((l) => l.kind === 'rail' && l.vehicles.length > 0 && new Set(l.stops).size >= 2);
    const towns = new Map(rail.map((l) => [l.id, new Set(l.stops.map((sid) => g.stations.get(sid)?.townId ?? -1).filter((t) => t >= 0))]));
    const city = new Map(rail.map((l) => [l.id, new Set(l.stops.map((sid) => g.stations.get(sid)).filter((s) => s?.city).map((s) => s!.townId))]));
    for (const a of rail) {
      if (a.owner !== me || !this.fleet(a).ours.length) continue;
      for (const b of rail) {
        // (two of our lines once: the lower id leads)
        if (a === b || !this.agrees(b.owner) || (b.owner === me && this.fleet(b).ours.length && b.id < a.id)) continue;
        if (this.cared(`cl${a.id}:${b.id}`)) continue;
        const shared = [...towns.get(b.id)!].filter((t) => towns.get(a.id)!.has(t));
        if (!shared.some((t) => city.get(a.id)!.has(t) || city.get(b.id)!.has(t))) continue;
        out.push({ ids: [a.id, b.id] });
      }
    }
    return out;
  }

  /**
   * Trips a month and yearly revenue newly possible between two sets of stations in one town: the local demand from
   * each station's walking regions to the regions the other set's stations cover (the regional OD model, as passenger
   * generation shares it out, with the town's rail uplift), both ways, for station pairs routing serves badly or not
   * at all today; each such journey makes a change of lines (TRANSFER_FARE_FACTOR).
   */
  private cityTrips(as: number[], bs: number[], headway = 900): { trips: number; revenue: number } {
    const g = this.g, D = g.demand, n = D.regions.length, od = D.od;
    let trips = 0, revenue = 0;
    if (!n || od.length !== n * n) return { trips, revenue };
    const pair = (a: Station, b: Station) => {
      const shares = D.shares.get(a.id);
      if (!shares || !(a.catchPop > 0)) return 0;
      const d = Math.hypot(a.x - b.x, a.z - b.z), walk = Math.min(1, d / 25);
      let x = 0;
      for (const [q, cov] of D.coverageSnapshot(b, false)) for (const [r, sr] of shares) if (r < n && q < n) x += sr * od[r * n + q] * cov * (r === q ? walk : 1);
      return a.catchPop * TRIPS_PER_MONTH * x * localTripMultiplier(g, a, 'rail', 1);
    };
    for (const x of new Set(as)) for (const y of new Set(bs)) {
      const A = g.stations.get(x), B = g.stations.get(y);
      if (x === y || !A || !B || A.townId < 0 || A.townId !== B.townId) continue;
      const d = Math.hypot(A.x - B.x, A.z - B.z), time = estimateLegTime(d, 35, headway, 1.3) + 360;
      const hop = g.lines.nextHop(x, y);
      if (hop && hop.cost < time * 1.4) continue;
      const t = pair(A, B) + pair(B, A);
      trips += t;
      revenue += t * 12 * estimateLegFare(d, 35, headway, 1, 1.3, false, false, { mode: 'rail' }) * TRANSFER_FARE_FACTOR;
    }
    return { trips, revenue };
  }

  /**
   * One pair of lines with stations in one town (citylink): their nearest stations there become one interchange where
   * the change of lines newly allows enough trips: linked for walking transfers when within walking range (linkRange: free, under
   * the stations' access rules), else a stop of ours on our own track within CITY_LINK_GAP of the other line's station
   * (linked to it), when the trips' revenue repays the stop and its upkeep within CITY_LINK_YEARS.
   */
  private *cityLinkTask(ids: number[]): Generator<void, void> {
    const g = this.g, me = this.me, [aid, bid] = ids;
    const A = g.lines.get(aid), B = g.lines.get(bid);
    if (!A || !B) return;
    this.careFor(`cl${aid}:${bid}`, 360);
    this.considered('citylink.pair');
    const sa = [...new Set(A.stops)], sb = [...new Set(B.stops)];
    if (sa.some((x) => { const c = new Set(g.stations.complex(x)); return sb.some((y) => c.has(y)); })) { this.considered('citylink.meet'); return; }
    let near: { a: Station; b: Station; gap: number } | null = null;
    for (const x of sa) for (const y of sb) {
      const X = g.stations.get(x), Y = g.stations.get(y);
      // (near in-city stations: one of the two an in-city metro / light-rail station)
      if (!X?.rail || !Y?.rail || X.townId < 0 || X.townId !== Y.townId || !(X.city || Y.city) || Math.hypot(X.x - Y.x, X.z - Y.z) > 160) continue;
      const gap = g.stations.gap(X, Y);
      if (!near || gap < near.gap || (gap === near.gap && X.id + Y.id < near.a.id + near.b.id)) near = { a: X, b: Y, gap };
    }
    if (!near || near.gap > CITY_LINK_REACH) { this.considered('citylink.far'); return; }
    yield;
    const value = this.cityTrips(sa, sb, this.headway([A, B]));
    networkProfile.decisions['citylink.maxTrips'] = Math.max(networkProfile.decisions['citylink.maxTrips'] ?? 0, value.trips);
    if (value.trips < networkOptions.cityLinkTrips) { this.considered('citylink.demand'); return; }
    if (near.gap <= g.stations.linkRange(near.a, near.b)) {
      const why = g.stations.canLink(near.a.id, near.b.id);
      if (why || g.stations.link(near.a.id, near.b.id)) { this.considered('citylink.rules'); return; }
      this.bump('netCityLinks');
      this.note(`interchange ${near.a.name} - ${near.b.name}${near.b.owner !== me ? ` (${g.company(near.b.owner).name})` : ''}: linked for transfers, ${Math.round(value.trips)} trips a month newly connected`);
      return;
    }
    if (!this.mayBuild()) { this.considered('citylink.funds'); return; }
    // a stop of ours beside the other line's station (on our line; on either when both are ours)
    const options: { l: Line; to: Station }[] = [{ l: A, to: near.b }];
    if (B.owner === me && this.fleet(B).ours.length) options.push({ l: B, to: near.a });
    for (const { l, to } of options) {
      const own = [...new Set(l.stops)].map((sid) => g.stations.get(sid)).filter((s): s is Station => !!s?.rail);
      const nearest = own.reduce<Station | undefined>((best, st) => !best || Math.hypot(st.x - to.x, st.z - to.z) < Math.hypot(best.x - to.x, best.z - to.z) ? st : best, undefined);
      const mode = nearest ? railPartMode(nearest.rail!) : 'mainline';
      const L = Math.max(4, this.platformFor(l)), route = [...new Set(this.pairsOf(l).flatMap(([a, b]) => this.route(a, b, l.owner) ?? []))];
      const spots = this.spotsNear(route, to.x, to.z, CITY_LINK_GAP + L / 2 + 4).slice(0, 14);
      if (!spots.length) { this.considered('citylink.noTrack'); continue; }
      const before = new Map<number, [number, number][]>();
      for (const o of g.lines.map.values()) if (o.owner === me && o.kind === 'rail') before.set(o.id, this.pairsOf(o));
      // the stop's own upkeep (its level: the line's there) must be repaid by the newly connected trips
      const accept = (p: OnTrackPlanLike) => {
        const st = p.station as StationPlan | null;
        if (!st || this.planGap(st, to) > CITY_LINK_GAP || own.some((o) => Math.hypot(o.x - st.x, o.z - st.z) < st.length + 6)) return false;
        const upkeep = (20_000 + st.tracks * st.length * 500) * STATION_UPKEEP_FACTOR[st.level];
        return (value.revenue - upkeep) * CITY_LINK_YEARS >= p.cost;
      };
      const id = yield* this.insertAt(spots, L, `no interchange stop beside ${to.name}`, Math.max(0, value.revenue * CITY_LINK_YEARS), { accept, tracks: 2, mode });
      if (id === -2) { this.careFor(`cl${aid}:${bid}`, 15); return; }
      if (id < 0) continue;
      const st = g.stations.get(id)!;
      this.roadAccess(st);
      const served = this.addToLines(id, before);
      if (!served.length) { g.stations.removeStation(id); this.considered('citylink.unserved'); continue; }
      if (!g.stations.get(st.id)?.links.includes(to.id) && !g.stations.canLink(st.id, to.id)) g.stations.link(st.id, to.id);
      this.bump('netCityLinks'); this.bump('netCityStops');
      this.note(`interchange stop ${st.name} on ${l.name} beside ${to.name}${to.owner !== me ? ` (${g.company(to.owner).name})` : ''}: ${Math.round(value.trips)} trips a month newly connected`);
      this.news(`opens ${st.name} on ${l.name}, an interchange with ${to.name}.`, st.x, st.z);
      return;
    }
  }

  // ================================================================ one station per town (9g consolidation)
  private *consolidateTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const mine = [...g.stations.map.values()].filter((s) => s.owner === me && s.rail && railPartMode(s.rail) === 'mainline' && (s.rail.level ?? 'ground') === 'ground' && s.townId >= 0);
    for (let i = 0; i < mine.length; i++) for (let j = 0; j < mine.length; j++) {
      const A = mine[i], B = mine[j];
      if (!ids.includes(A.id) || i === j || A.townId !== B.townId || !g.stations.get(A.id) || !g.stations.get(B.id)) continue;
      if (!this.mayAlter([...A.rail!.edges, ...A.rail!.throughEdges, ...B.rail!.edges, ...B.rail!.throughEdges, ...this.approachOf(A, 80), ...this.approachOf(B, 80)])) continue;
      if (Math.hypot(A.x - B.x, A.z - B.z) > 40) continue;
      this.considered('consolidate.nearTermini');
      // A: the bigger (more platforms, more lines)
      const la = this.linesAt(A.id), lb = this.linesAt(B.id);
      if (A.rail!.tracks * 10 + la.length < B.rail!.tracks * 10 + lb.length || (A.rail!.tracks === B.rail!.tracks && la.length === lb.length && A.id > B.id)) continue;
      const key = `cons${A.id}:${B.id}`;
      if (this.cared(key)) continue;
      this.careFor(key, 720);
      // side by side: one rail part
      const cm = OPS.canMerge?.(g, A.id, B.id);
      if (cm?.ok && cm.kind === 'rebuild' && OPS.mergeStations) {
        const res = OPS.mergeStations(g, A.id, B.id);
        if (!res.error) {
          for (const l of this.linesAt(A.id)) if (l.owner === me && l.kind === 'rail') { this.signal(l.id); this.canon(l.id); }
          this.bump('merged'); this.bump('netConsolidated');
          this.note(`merged ${B.name} into ${A.name} (one station)`);
          this.news(`merges its stations in ${g.towns.list[A.townId]?.name ?? 'town'} into one: ${A.name}.`, A.x, A.z);
          yield;
          continue;
        }
        if (res.error === 'busy') this.careFor(key, 10);
      }
      // two termini: B's lines move to A over a junction between their approaches, B is taken up
      if (!lb.length || lb.some((l) => l.owner !== me || l.kind !== 'rail' || this.fleet(l).others)) continue;
      const bEnd = (['front', 'back'] as const).find((e) => this.freeEnd(B, e));
      if (!bEnd) continue;
      yield* this.moveLines(A, B, lb);
      yield;
    }
  }

  /** B's lines over to A: a junction from B's approach track to A's, the lines re-routed, B removed. */
  private *moveLines(A: Station, B: Station, lb: Line[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planConnection || !OPS.commitConnection) return;
    const appB = [...this.approachOf(B, 70)].map((id) => net.edges.get(id)!).filter((e) => e && e.owner === me && e.station < 0 && e.depot < 0 && e.len > 4 && !this.oneWayAround(e));
    const appA = [...this.approachOf(A, 70)].map((id) => net.edges.get(id)!).filter((e) => e && this.agrees(e.owner) && e.station < 0 && e.depot < 0 && e.len > 4 && !this.oneWayAround(e));
    if (!appB.length || !appA.length) return;
    const q = { x: 0, y: 0, z: 0 }, tangent = { x: 0, y: 0, z: 0 };
    const inward = (e: NEdge, st: Station): 1 | -1 => { const a = net.nodes.get(e.a)!, b = net.nodes.get(e.b)!; return Math.hypot(b.x - st.x, b.z - st.z) < Math.hypot(a.x - st.x, a.z - st.z) ? 1 : -1; };
    const sites: { ea: NEdge; eb: NEdge; sa: number; sb: number; dirA: 1 | -1; dirB: 1 | -1; score: number }[] = [];
    let scanned = 0;
    for (const eb of appB) for (const ea of appA) {
      if (eb.id === ea.id || !net.edges.has(eb.id) || !net.edges.has(ea.id)) continue;
      const dirB = inward(eb, B), dirA = inward(ea, A);
      // Nearby turnout pieces often face the wrong way. Check the whole approach cheaply before
      // spending the limited curve attempts: a farther turnout gives the diagonal room to turn.
      for (const [far, near] of [[0.7, 0.3], [0.85, 0.2], [0.5, 0.5]]) {
        const sb = eb.len * (dirB < 0 ? far : 1 - far), sa = ea.len * (dirA < 0 ? near : 1 - near);
        net.pointAt(eb, sb, q, tangent); const qb = { ...q }, tb = { ...tangent };
        net.pointAt(ea, sa, q, tangent);
        const dx = q.x - qb.x, dz = q.z - qb.z, d = Math.hypot(dx, dz);
        if (d < 8 || d > 85) continue;
        const cb = (dx * tb.x + dz * tb.z) * dirB / (d * (Math.hypot(tb.x, tb.z) || 1));
        const ca = (dx * tangent.x + dz * tangent.z) * dirA / (d * (Math.hypot(tangent.x, tangent.z) || 1));
        const alignment = Math.min(ca, cb);
        // A rough S-curve radius rejects short, nearly sideways links before expensive planning.
        // Without this, many tiny approach pieces consume every attempt before a roomy diagonal.
        const radius = d * alignment * alignment / (6 * Math.max(0.02, Math.sqrt(Math.max(0, 1 - alignment * alignment))));
        if (alignment > 0 && radius >= (TRACK_TYPES[eb.type] ?? TRACK_TYPES.standard).minRadius * 1.25)
          sites.push({ ea, eb, sa, sb, dirA, dirB, score: d / (0.25 + alignment) + Math.abs(q.y - qb.y) * 40 });
      }
      if (++scanned % 128 === 0) yield;
    }
    sites.sort((a, b) => a.score - b.score || a.eb.id - b.eb.id || a.ea.id - b.ea.id);
    let plan: ConnPlan | null = null;
    let reason = '';
    for (const s of sites.slice(0, 24)) {
      if (!net.edges.has(s.eb.id) || !net.edges.has(s.ea.id)) continue;
      const pc = OPS.planConnection(g, s.eb.id, s.sb, s.ea.id, s.sa, me, { dirA: s.dirB, dirB: s.dirA });
      if (pc.ok && (!pc.proposal || this.proposalConsent(pc.proposal) && this.demolitionOk(pc.proposal.demolish))) { plan = pc; break; }
      reason ||= pc.error ?? 'buildings in the way';
      yield;
    }
    if (!plan) { this.note(`${B.name} and ${A.name}: no junction between their approaches${reason ? ' (' + reason + ')' : ''}`); return; }
    if (!this.canSpend(plan.cost * 1.3 + 300_000, 0.25)) return;
    const dem = [...(plan.proposal?.demolish ?? [])];
    const { result: res, edges: made } = this.builtEdges(() => OPS.commitConnection!(g, plan!, { signals: false }));
    if (res.error) return;
    this.compensate(dem);
    // Check after building the junction: disconnected approaches could never pass this test beforehand.
    // Every train's home must remain accessible when B's platforms are removed.
    for (const l of lb) {
      const depots = new Set<number>();
      const info = this.managed()?.get(l.id);
      if (info) depots.add(info.depot);
      for (const vid of l.vehicles) { const v = g.vehicles.get(vid) as unknown as { depotId?: number } | undefined; if (v?.depotId !== undefined) depots.add(v.depotId); }
      for (const id of depots) {
        const dp = g.depots.get(id);
        if (dp && !this.reachesAvoiding(dp.node, A, B)) { removeEdges(g, made, me); return; }
      }
    }
    // A needs room for the lines it takes
    if (A.rail && A.rail.tracks < Math.min(8, this.linesAt(A.id).length + lb.length) && A.rail.tracks < 4) this.grow(A, { tracks: Math.min(4, A.rail.tracks + 2), through: A.rail.through ?? 0, length: Math.max(A.rail.length, B.rail?.length ?? 0) }, `lines from ${B.name}`);
    // the lines: B -> A where every hop still finds its way
    const moved: Line[] = [];
    for (const l of lb) {
      const old = [...l.stops];
      if (l.stops.includes(A.id)) continue;
      const stops = l.stops.map((s) => (s === B.id ? A.id : s));
      const tmp = { ...l, stops } as Line;
      const ok = this.pairsOf(tmp).every(([a, b]) => routeBetween(g, a, b, me) && routeBetween(g, b, a, me));
      if (!ok) continue;
      this.setStops(l, stops);
      if (!this.linesRoute([l.id])) { this.setStops(l, old); continue; }
      moved.push(l);
    }
    if (!moved.length) { removeEdges(g, made, me); this.note(`${B.name}: lines could not move to ${A.name}; junction taken up`); return; }
    for (const l of moved) { this.signal(l.id); this.canon(l.id); }
    if (!this.linesAt(B.id).length) this.retire.set('st' + B.id, g.day);
    this.bump('merged'); this.bump('netConsolidated');
    this.note(`moved ${moved.map((l) => l.name).join(', ')} from ${B.name} to ${A.name}`);
    this.news(`brings its lines in ${g.towns.list[A.townId]?.name ?? 'town'} together at ${A.name}.`, A.x, A.z);
    yield* this.retireUnused();
  }

  /** Can trains get from a node to station A's platforms without passing B's platforms? */
  private reachesAvoiding(node: number, A: Station, B: Station): boolean {
    const net = this.g.world.net, seen = new Set<number>([node]), queue = [node];
    const bEdges = new Set([...B.rail!.edges, ...B.rail!.throughEdges]);
    for (let guard = 0; queue.length && guard < 20000; guard++) {
      const n = queue.pop()!;
      for (const id of net.nodes.get(n)?.edges ?? []) {
        const e = net.edges.get(id);
        if (!e || e.kind !== 'rail' || bEdges.has(id)) continue;
        if (e.station === A.id) return true;
        const o = e.a === n ? e.b : e.a;
        if (!seen.has(o)) { seen.add(o); queue.push(o); }
      }
    }
    return false;
  }

  // ================================================================ bus stops (9k co-location)
  private *stopsTask(ids: number[]): Generator<void, void> {
    const g = this.g, me = this.me;
    const stopOnly = [...g.stations.map.values()].filter((s) => !s.rail && s.stops.length);
    const tram = (st: Station) => st.stops.some((p) => g.world.net.edges.get(p.edge)?.tram);
    let k = 0;
    for (const a of stopOnly) {
      if (!ids.includes(a.id) || a.owner !== me || !g.stations.get(a.id)) continue;
      if (++k % 8 === 0) yield;
      for (const b of stopOnly) {
        if (a === b || !g.stations.get(b.id) || !g.stations.get(a.id) || tram(a) !== tram(b)) continue;
        let gap = Infinity;
        for (const p of a.stops) for (const q of b.stops) gap = Math.min(gap, Math.hypot(p.x - q.x, p.z - q.z));
        if (gap > 8) continue;
        if (b.owner === me) {
          // ours both: one station (the one with more lines keeps its name)
          if (b.id < a.id) continue;
          const [into, from] = this.linesAt(b.id).length > this.linesAt(a.id).length ? [b, a] : [a, b];
          // (stations.ts mergeStops: one station, a stop beside another one taken away; else one station with both stops)
          const err = errorOf(OPS.mergeStops ? OPS.mergeStops(g, into.id, from.id) : g.stations.merge(into.id, from.id));
          if (err) continue;
          // two stops on the same street a few metres apart: one is enough (its upkeep saved)
          if (!OPS.mergeStops) this.trimStops(into);
          this.bump('netStopsMerged');
          this.note(`bus stops ${from.name} and ${into.name} combined`);
          yield;
          break;
        }
        // another company's stop on an open network beside ours: our lines use theirs, ours goes
        if (b.owner < 0 || !g.canUse(me, b.owner) || g.accessPolicy(b.owner) !== 'open' || gap > 5) continue;
        const ls = this.linesAt(a.id);
        if (ls.some((l) => l.owner !== me || l.stops.includes(b.id) || new Set(l.stops.map((s) => (s === a.id ? b.id : s))).size < 2)) continue;
        for (const l of ls) this.setStops(l, l.stops.map((s) => (s === a.id ? b.id : s)));
        if (!this.linesAt(a.id).length && !g.stations.removeStation(a.id)) {
          this.bump('netStopsMerged');
          this.note(`our lines at ${a.name} use ${g.company(b.owner).name}'s stop beside it now`);
        }
        yield;
        break;
      }
    }
  }

  /** Stops of one station closer than 4 units on the same road: the extra ones removed. */
  private trimStops(st: Station) {
    const g = this.g;
    for (let i = st.stops.length - 1; i > 0; i--) {
      const p = st.stops[i];
      if (st.stops.some((q, j) => j < i && q.edge === p.edge && Math.hypot(q.x - p.x, q.z - p.z) < 4)) g.stations.removeStop(st, i);
    }
    g.onNetworkChanged();
    g.lines.rebuild();
  }

  // ================================================================ tidying up (9i)
  private *tidyTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const busy = this.busyEdges();
    let k = 0;
    // rail: dead ends of ours that lead nowhere (never one on a bridge)
    for (const n of this.selected(net.nodes.values(), ids)) {
      if (n.kind !== 'rail' || n.edges.length !== 1) continue;
      const e = net.edges.get(n.edges[0]);
      if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) continue;
      if (++k % 10 === 0) yield;
      const onBridge = net.sectionAt(e, e.a === n.id ? 0 : e.len) === 'bridge';
      const len = this.takeUpStub(n.id, onBridge ? 400 : 120, busy);
      if (len) this.note(`took up ${Math.round(len)} u of dead-end track${onBridge ? ' ending on a bridge' : ''}`);
    }
    // roads of ours ending on a bridge: back to the last junction
    for (const n of this.selected(net.nodes.values(), ids)) {
      if (n.kind !== 'road' || n.edges.length !== 1) continue;
      const e = net.edges.get(n.edges[0]);
      if (!e || e.owner !== me || e.depot >= 0 || net.sectionAt(e, e.a === n.id ? 0 : e.len) !== 'bridge') continue;
      const chain: number[] = [];
      let at = n.id, cur: NEdge | undefined = e, len = 0;
      for (let i = 0; cur && i < 20; i++) {
        if (cur.owner !== me || cur.depot >= 0 || busy.has(cur.id)) { chain.length = 0; break; }
        chain.push(cur.id);
        len += cur.len;
        const o: number = cur.a === at ? cur.b : cur.a, on = net.nodes.get(o);
        if (!on || on.edges.length !== 2) break;
        at = o;
        cur = net.edges.get(on.edges[0] === cur.id ? on.edges[1] : on.edges[0]);
      }
      if (!chain.length || len > 80) continue;
      // (no stop of any company on it)
      if ([...g.stations.map.values()].some((st) => st.stops.some((p) => chain.includes(p.edge)))) continue;
      removeEdges(g, chain, me);
      this.bump('stubs', Math.round(len));
      this.note(`took up ${Math.round(len)} u of road ending on a bridge`);
      yield;
    }
  }

  /** Own plain track straight on from a station's platform ends (both ends, through switches the straightest way), up to `reach`. */
  private straightOut(st: Station, reach: number): number[] {
    const g = this.g, net = g.world.net, out = new Set<number>();
    const own = new Set([...st.rail!.edges, ...st.rail!.throughEdges]);
    for (const t of g.stations.trackEnds(st, true)) for (const nid of [t.front, t.back]) {
      const n0 = net.nodes.get(nid);
      const first = n0?.edges.map((id) => net.edges.get(id)).find((e) => !!e && !own.has(e.id));
      if (!n0 || !first) continue;
      let cur: NEdge | undefined = first, at = n0.id, acc = 0;
      for (let k = 0; cur && k < 40 && acc < reach; k++) {
        if (cur.owner !== this.me || cur.depot >= 0 || cur.station >= 0 || cur.kind !== 'rail') break;
        out.add(cur.id);
        acc += cur.len;
        const dir = cur.a === at ? 1 : -1;
        const conts = net.nextRail(cur, dir);
        if (!conts.length) break;
        const geo = net.geo(cur), i = dir > 0 ? geo.n - 1 : 0, tx = geo.tan[i * 2] * dir, tz = geo.tan[i * 2 + 1] * dir;
        let best = conts[0], bd = -Infinity;
        for (const c of conts) { const ld = net.leaveDir(c.edge, c.node.id), dot = ld.x * tx + ld.z * tz; if (dot > bd) { bd = dot; best = c; } }
        at = best.node.id;
        cur = best.edge;
      }
    }
    return [...out];
  }

  // ================================================================ lifting town-centre stations (9k)
  private *relevelTask(ids: number[]): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planRelevel || !OPS.commitRelevel) return;
    if (this.eco.yearTotals.length && this.eco.lastYearProfit < 0) return;
    for (const st of this.selected(g.stations.map.values(), ids)) {
      if (st.owner !== me || !st.rail || (st.rail.level ?? 'ground') !== 'ground' || railPartMode(st.rail) !== 'mainline' || this.cared('lift' + st.id)) continue;
      const T = g.towns.list[st.townId];
      if (!T || T.pop < 3500 || Math.hypot(st.x - T.x, st.z - T.z) > T.radius * 0.6) continue;
      this.careFor('lift' + st.id, 720);
      // the railway cuts the town: level crossings with its streets near the station, or the town on both sides
      const app = this.approachOf(st, 60);
      let crossings = 0;
      for (const c of net.crossings.values()) if (c.kind === 'level' && (app.has(c.e1) || st.rail.edges.includes(c.e1))) crossings++;
      const ax = Math.sin(st.rail.angle), az = Math.cos(st.rail.angle);
      let left = 0, right = 0;
      for (const id of T.buildings) { const b = g.world.buildings.get(id); if (!b) continue; const side = (b.x - st.x) * az - (b.z - st.z) * ax; if (side > 2) left += b.pop; else if (side < -2) right += b.pop; }
      const split = Math.min(left, right) > 0.25 * (left + right);
      if (crossings < 2 && !split) continue;
      yield;
      const edges = [...st.rail.edges, ...st.rail.throughEdges, ...this.straightOut(st, 50)];
      if (!this.mayAlter(edges)) continue;
      const plan = OPS.planRelevel(g, edges, 'elevated', me);
      if (!this.mayAlter((plan as Partial<Trackops.RelevelPlan>).edges?.map((e) => e.id) ?? edges)) continue;
      if (!plan.ok || !this.canSpend(plan.cost * 1.1, 0.25)) { if (!plan.ok) this.note(`${st.name} cannot be lifted: ${plan.error ?? ''}`); continue; }
      const err = errorOf(OPS.commitRelevel(g, plan));
      if (err) { if (err === 'busy') this.careFor('lift' + st.id, 20); continue; }
      for (const l of this.linesAt(st.id)) if (l.owner === me && l.kind === 'rail') this.signal(l.id);
      this.bump('netRelevelled');
      this.note(`lifted ${st.name} onto a viaduct (${crossings} level crossings${split ? ', the town on both sides' : ''})`);
      this.news(`lifts ${st.name} and its approaches onto a viaduct.`, st.x, st.z);
      return;
    }
  }
}
