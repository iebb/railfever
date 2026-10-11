// Route upgrades as staged works: a busy bus or coach line becomes a tram, light-rail, metro or railway line while its
// buses keep running, in three stages (as the AI brings two lines to one station: ai-hub.ts, whose ledger, roll-back
// and hand-over these works share):
//  1. construct: tram tracks in its streets, or stations at or beside its stops and the track between them, a depot
//     beside the line (depot-sites.ts: never at its ends) and the new vehicles (waiting in the depot), unit by unit over
//     game time, each paid as it is built;
//  2. switch: the line itself (its id, name, colour, history and waiting passengers) runs the new vehicles: its buses
//     are taken off (sold), its stops become tram stops or move to the new stations (linked for walking transfers);
//  3. remove: the old stops no line serves any more and the bus depots no vehicle uses, one a day.
// Works are game state (Game.routeWorks: plain data, one step at the start of each day), so a game saved during them
// resumes the same decisions on the same day. Works that fail before the switch, or are cancelled, are taken up again
// with a refund of what was built (ai-hub.ts takeUpWorks; the vehicles bought are sold at their full price).
import type { Game } from './game';
import type { Line } from './lines';
import type { Town } from './towns';
import type { Station, StationPlan, RailMode } from './stations';
import type { VehicleModel } from './vehicle-types';
import type { SideYard } from './depot-sites';
import type { Snap, BuildOptions } from './construction';
import type { OPoint } from './routing';
import { MODEL_BY_ID } from './vehicle-types';
import { outAndBack } from './lines';
import { stationLayout } from './stations';
import { TRACK_TYPES } from './constants';
import { planEdge, commitProposal, findSnap } from './construction';
import { nodeSnap, stationEnds, railPairGen, routeGen, buildChain, runGen, estimateChainCost, chainProfile, routeConflictAt, type ChainProfile } from './routing';
import { finishDoubleTrack } from './trackops';
import { planProspectiveSideDepot, buildPlannedSideDepot, buildDepotBeside, sideYardDistances, runningSideOf } from './depot-sites';
import { addTramTracks } from './build-ops';
import { tramDepotSites, pathPoints } from './ai-tram';
import { RoadVehicle, roadDepotReaches } from './roadvehicle';
import { Train, depotServes, findRailRoute, consistRule, platformDepartureFrontiers } from './train';
import { autoSignalLine } from './signals';
import { settleMail } from './mail';
import { demolitionCost } from './demolition';
import { planWalkingCatchment, walkingPopulation } from './catchment';
import { recordWorks, takeUpWorks, worksBusy, handOver, type WorksLedger } from './ai-hub';
import { planTramUpgrade, routeOf } from './ai-bus';
import { cityRailUnit, cityRailPlatform, citySitePlan, openingRailCall, pickTrain } from './ai';

export type UpgradeMode = 'tram' | 'lightrail' | 'metro' | 'rail';
export type UpgradeLevel = 'ground' | 'elevated' | 'underground';

/** A station an upgrade builds: where and how (planRail's options, so it is built as planned), the old stops it takes over. */
export interface UpgradeSite {
  x: number; z: number; angle: number; length: number;
  level: UpgradeLevel; depth: number; height: number; entrances?: number; trackType: string; railMode: RailMode;
  stops: number[]; cost: number;
}

/** A route upgrade planned (planRouteUpgrade): the new line and what it costs. Plain data (the works keep it). */
export interface UpgradeQuote {
  ok: boolean; error?: string;
  line: number; owner: number; mode: UpgradeMode; level: UpgradeLevel;
  /** one vehicle (a train's cars: model ids) and how many */
  cars: string[]; vehicles: number;
  /** costs: track, stations, depot, vehicles; what the line's buses fetch; the total less the buses */
  track: number; stations: number; depot: number; fleet: number; resale: number; cost: number;
  /** new track (units) and the works (days) */
  trackLength: number; days: number;
  /** tram: the streets of the route and those without tracks; an own tram depot on the route (-1: a new one) */
  edges?: number[]; fresh?: number[]; tramDepot?: number;
  /** rail: the stations, the depot planned beside the line (city lines), the railway's planned way between stations */
  sites?: UpgradeSite[]; yard?: SideYard | null; ways?: OPoint[][];
  /** the new line's stops on the map, in order */
  path: { x: number; z: number }[];
}

export type WorksStage = 'build' | 'switch' | 'remove';
/** Route upgrade works under way (Game.routeWorks). */
export interface RouteWorks {
  id: number; line: number; owner: number; mode: UpgradeMode; level: UpgradeLevel;
  quote: UpgradeQuote;
  stage: WorksStage;
  /** build: the unit being built, days left on it; days worked of the total */
  unit: number; left: number; done: number; total: number;
  /** days the current step has waited (funds, vehicles in the way) */
  waits: number;
  /** the line's stops when the works began (a line changed before the switch stops them) */
  identity: string;
  started: number; name: string;
  built: WorksLedger & { stations: number[]; depot: number; vehicles: number[] };
  /** after the switch: old stop -> the station that took it over; the bus depots freed; what is removed next */
  olds?: [number, number][]; depots?: number[]; removing?: number;
  /** what holds the works up (UI) */
  note?: string;
}

/** Construction rates: units of track a day (tram tracks, rail by level, open-line railway), days per station. */
const RATE = { tram: 10, ground: 6, elevated: 4, underground: 3, mainline: 12 };
const STATION_DAYS = { ground: 6, elevated: 10, underground: 15 };
/** Days for a depot, the new vehicles' delivery, the crossovers and signals; a main-line station. */
const DEPOT_DAYS = 5, FLEET_DAYS = 6, FINISH_DAYS = 4, MAIN_STATION_DAYS = 8;
/** Days a step may wait (money, trains in the way) before the works give up. */
const MAX_WAIT = 180;
/** A city railway's depot may take a block or two (ai.ts URBAN_DEPOT_POP). */
const URBAN_DEPOT_POP = 600;

// ============================================================================ planning

const fail = (base: Pick<UpgradeQuote, 'line' | 'owner' | 'mode' | 'level'>, error: string): UpgradeQuote => ({ ...base, ok: false, error, cars: [], vehicles: 0,
  track: 0, stations: 0, depot: 0, fleet: 0, resale: 0, cost: 0, trackLength: 0, days: 0, path: [] });

/** Works under way on a line (or null). */
export function worksOn(g: Game, lineId: number): RouteWorks | null { return g.routeWorks.find((w) => w.line === lineId) ?? null; }

/** The line's buses (the owner's road vehicles on it), the seats they have and what they fetch. */
function busesOf(g: Game, l: Line, owner: number) {
  const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is RoadVehicle => v instanceof RoadVehicle && v.owner === owner);
  return { vs, seats: vs.reduce((a, v) => a + v.capacity, 0), resale: vs.reduce((a, v) => a + g.vehicles.resaleValue(v), 0) };
}

/** Why a line cannot be upgraded at all (or null). */
export function upgradeBlock(g: Game, lineId: number, owner: number): string | null {
  const l = g.lines.get(lineId);
  if (!l || l.id !== lineId || l.kind !== 'road') return 'Not a bus line';
  if (l.owner !== owner) return 'Not your line';
  if (worksOn(g, lineId)) return 'Works under way';
  if (l.vehicles.some((id) => g.vehicles.get(id)?.owner !== owner)) return 'Partners run buses on it';
  if (!routeOf(g, l)) return 'Too few stops';
  return null;
}

/** The towns of a line's route in order (each once). */
function routeTowns(g: Game, path: number[]): number[] {
  const out: number[] = [];
  for (const id of path) { const t = g.stations.get(id)?.townId ?? -1; if (t >= 0 && out[out.length - 1] !== t && !out.includes(t)) out.push(t); }
  return out;
}

/** Which modes suit a line: trams (any road line), light rail and metro (in one town), a railway (between towns). */
export function upgradeModes(g: Game, lineId: number): UpgradeMode[] {
  const l = g.lines.get(lineId), route = l ? routeOf(g, l) : null;
  if (!l || !route) return ['tram'];
  const towns = new Set(route.path.map((id) => g.stations.get(id)?.townId ?? -1));
  return towns.size > 1 || towns.has(-1) ? ['tram', 'rail'] : ['tram', 'lightrail', 'metro'];
}

/** Plan an upgrade (synchronous: the UI); the AI runs routeUpgradeGen with its work units. */
export function planRouteUpgrade(g: Game, lineId: number, owner: number, mode: UpgradeMode, level?: UpgradeLevel): UpgradeQuote {
  return runGen(routeUpgradeGen(g, lineId, owner, mode, level));
}

/** Plan an upgrade, a bounded step a yield (pure: nothing is built). */
export function* routeUpgradeGen(g: Game, lineId: number, owner: number, mode: UpgradeMode, level?: UpgradeLevel): Generator<void, UpgradeQuote> {
  const lv: UpgradeLevel = mode === 'metro' ? 'underground' : mode === 'lightrail' ? level ?? 'elevated' : 'ground';
  const base = { line: lineId, owner, mode, level: lv };
  const block = upgradeBlock(g, lineId, owner);
  if (block) return fail(base, block);
  const l = g.lines.get(lineId)!;
  if (!upgradeModes(g, lineId).includes(mode)) return fail(base, mode === 'rail' ? 'Railway: two towns only' : 'In one town only');
  if (mode === 'tram') return tramQuote(g, l, owner);
  if (mode === 'rail') return yield* mainlineQuote(g, l, owner);
  return (yield* cityRailQuote(g, l, owner, mode, lv)).quote;
}

/** A city railway along a bus line as planned, with its station plans and the price of its links (the AI's valuation). */
export function* cityRailPlanGen(g: Game, lineId: number, owner: number, mode: 'lightrail' | 'metro', level: UpgradeLevel): Generator<void, CityRailPlan> {
  const base = { line: lineId, owner, mode, level };
  const block = upgradeBlock(g, lineId, owner);
  if (block) return { quote: fail(base, block), plans: [], links: 0 };
  if (!upgradeModes(g, lineId).includes(mode)) return { quote: fail(base, 'In one town only'), plans: [], links: 0 };
  return yield* cityRailQuote(g, g.lines.get(lineId)!, owner, mode, level);
}
export interface CityRailPlan { quote: UpgradeQuote; plans: StationPlan[]; links: number }

/** Days the works take, unit by unit. */
function unitsOf(q: UpgradeQuote): { kind: 'tracks' | 'station' | 'link' | 'finish' | 'depot' | 'fleet'; i: number; days: number }[] {
  const out: ReturnType<typeof unitsOf> = [];
  if (q.mode === 'tram') {
    const chunks = Math.max(1, Math.ceil(q.trackLength / (RATE.tram * 2)));
    for (let i = 0; i < chunks; i++) out.push({ kind: 'tracks', i, days: Math.max(1, Math.round(q.trackLength / chunks / RATE.tram)) });
    if ((q.tramDepot ?? -1) < 0) out.push({ kind: 'depot', i: 0, days: DEPOT_DAYS });
    out.push({ kind: 'fleet', i: 0, days: FLEET_DAYS });
    return out;
  }
  const sites = q.sites ?? [], main = q.mode === 'rail';
  sites.forEach((_, i) => out.push({ kind: 'station', i, days: main ? MAIN_STATION_DAYS : STATION_DAYS[q.level] }));
  for (let i = 0; i + 1 < sites.length; i++) {
    const a = sites[i], b = sites[i + 1], d = Math.max(1, Math.hypot(b.x - a.x, b.z - a.z) - (a.length + b.length) / 2);
    out.push({ kind: 'link', i, days: Math.max(1, Math.ceil(d / (main ? RATE.mainline : RATE[q.level]))) });
  }
  if (!main) out.push({ kind: 'finish', i: 0, days: FINISH_DAYS });
  out.push({ kind: 'depot', i: 0, days: DEPOT_DAYS });
  out.push({ kind: 'fleet', i: 0, days: FLEET_DAYS });
  return out;
}
const daysOf = (q: UpgradeQuote) => unitsOf(q).reduce((a, u) => a + u.days, 0);

/** Run a pure planning step as if these streets had tram tracks of `owner` (nothing changes: the flags are put back). */
function withTramTracks<T>(g: Game, edges: number[], owner: number, f: () => T): T {
  const net = g.world.net, set = edges.map((id) => net.edges.get(id)).filter((e): e is NonNullable<typeof e> => !!e && !e.tram);
  const was = set.map((e) => ({ e, tram: 'tram' in e ? e.tram : undefined, owner: 'tramOwner' in e ? e.tramOwner : undefined, has: ['tram' in e, 'tramOwner' in e] }));
  for (const e of set) { e.tram = true; e.tramOwner = owner; }
  try { return f(); } finally {
    for (const w of was) {
      if (w.has[0]) w.e.tram = w.tram; else delete w.e.tram;
      if (w.has[1]) w.e.tramOwner = w.owner; else delete w.e.tramOwner;
    }
  }
}

/** Trams: tracks in the streets the line runs, its stops become tram stops (ai-bus.ts planTramUpgrade). */
function tramQuote(g: Game, l: Line, owner: number): UpgradeQuote {
  const base = { line: l.id, owner, mode: 'tram' as const, level: 'ground' as const };
  const p = planTramUpgrade(g, l.id, owner);
  if (!p.ok || !p.model) return fail(base, p.error ?? 'Not possible');
  const route = routeOf(g, l)!;
  // (a new depot: priced at the site the works will take, as if the tracks were laid already, where one is found)
  const depot = p.depot >= 0 ? 0 : withTramTracks(g, p.fresh, owner, () => tramDepotSites(g, pathPoints(g, p.edges), [...new Set(l.stops)], owner)[0]?.cost) ?? p.depotCost;
  const q: UpgradeQuote = { ...base, ok: true, cars: [p.model.id], vehicles: p.trams, track: p.trackCost, stations: 0, depot, fleet: p.tramCost,
    resale: p.resale, cost: p.cost - p.depotCost + depot, trackLength: p.trackLength, days: 0, edges: [...p.edges], fresh: [...p.fresh], tramDepot: p.depot,
    path: route.path.map((id) => { const st = g.stations.get(id)!; return { x: st.x, z: st.z }; }) };
  q.days = daysOf(q);
  return q;
}

/** A planned station as a site the works build. */
function siteOf(p: StationPlan, stops: number[]): UpgradeSite {
  return { x: p.x, z: p.z, angle: p.angle, length: p.length, level: p.level, depth: p.depth, height: p.height,
    ...(p.entrances.length && p.level !== 'ground' ? { entrances: p.entrances.length } : {}), trackType: p.trackType, railMode: p.mode, stops, cost: p.cost };
}

/** Plan a site's station again as it was planned (the works, a day or more later). */
function replan(g: Game, s: UpgradeSite, owner: number, tracks: number): StationPlan {
  const p = g.stations.planRail(s.x, s.z, s.angle, s.length, tracks, owner, { trackType: s.trackType, mode: s.railMode, level: s.level,
    ...(s.level === 'underground' ? { depth: s.depth } : s.level === 'elevated' ? { height: s.height } : {}), ...(s.entrances ? { entrances: s.entrances } : {}) });
  // (an own stop there stays its own station, linked for transfers: taking the works up never removes a working stop)
  if (p.ok && p.join && !p.join.rail) { p.links = [...new Set([...p.links, p.join])]; p.join = null; }
  return p;
}

/**
 * The stops of a route a railway serves: the first, then each far enough on from the last (`mid`; the termini's
 * neighbours `end`, room for the crossovers before the platforms), the last; each old stop goes to the nearest of them
 * along the route.
 */
function railTargets(pts: { x: number; z: number }[], end: number, mid: number): { at: number; stops: number[] }[] {
  const d = (i: number, j: number) => Math.hypot(pts[i].x - pts[j].x, pts[i].z - pts[j].z);
  const n = pts.length, at = [0];
  for (let i = 1; i < n - 1; i++) if (d(i, at[at.length - 1]) >= (at.length === 1 ? end : mid)) at.push(i);
  // the last stop: the previous one goes where it is too close
  while (at.length > 1 && d(n - 1, at[at.length - 1]) < end) at.pop();
  at.push(n - 1);
  if (at.length >= 2 && d(at[0], at[1]) < end && at.length > 2) at.splice(1, 1);
  if (at.length < 2 || d(at[0], at[at.length - 1]) < end) return [];
  return at.map((i, k) => {
    const lo = k ? Math.ceil((at[k - 1] + i) / 2 + 0.01) : 0, hi = k + 1 < at.length ? Math.floor((i + at[k + 1]) / 2) : n - 1;
    const stops: number[] = [];
    for (let j = lo; j <= hi; j++) stops.push(j);
    return { at: i, stops };
  });
}

/** Shifts of a station site from its stop (along its axis, across it) tried in turn; turns of its axis. */
const SHIFTS: [number, number][] = [[0, 0], [0, 3], [0, -3], [3, 0], [-3, 0], [0, 6], [0, -6], [4, 4], [-4, -4], [4, -4], [-4, 4], [0, 9], [0, -9], [6, 0], [-6, 0]];
const TURNS = [0, 0.25, -0.25];

/** The planned link between two planned stations (two tracks, at their level), as the city-rail planner prices it. */
function plannedLink(g: Game, a: StationPlan, b: StationPlan, owner: number, level = false) {
  const net = g.world.net;
  const out = (p: StationPlan, to: StationPlan) => {
    const ux = Math.sin(p.angle), uz = Math.cos(p.angle), side = ux * (to.x - p.x) + uz * (to.z - p.z) >= 0 ? 1 : -1;
    return p.layout.trackOffsets.map((off) => ({ x: p.x + uz * off + ux * p.length / 2 * side, z: p.z - ux * off + uz * p.length / 2 * side, y: p.y, dx: ux * side, dz: uz * side }));
  };
  const ea = out(a, b), eb = out(b, a);
  return net.withTemporaryNodes('rail', [...ea, ...eb], owner, (nodes) => {
    // (each group left to right of its own way out: planEdge's order)
    const group = (ns: typeof nodes): Snap => {
      const t = { x: ns[0].dx, z: ns[0].dz }, c = { x: ns.reduce((s, n) => s + n.x, 0) / ns.length, z: ns.reduce((s, n) => s + n.z, 0) / ns.length };
      const ids = [...ns].sort((p, q) => ((p.x - c.x) * -t.z + (p.z - c.z) * t.x) - ((q.x - c.x) * -t.z + (q.z - c.z) * t.x)).map((n) => n.id);
      const q = net.nodes.get(ids[0])!;
      return { kind: 'node', x: q.x, y: q.y, z: q.z, node: q.id, group: ids };
    };
    return planEdge(g, group(nodes.slice(0, ea.length)), group(nodes.slice(ea.length)), linkOptions(a, owner, level));
  });
}

/**
 * A city railway's double track at its stations' level (as the city-rail planner lays it: over the streets on the
 * ground, `level` true: light rail crossing them at grade where it cannot rise over them in time).
 */
function linkOptions(st: { level?: string; depth?: number; height?: number }, owner: number, level = false): BuildOptions {
  const lv = st.level ?? 'ground';
  return { kind: 'rail', type: 'electric', tracks: 2, heightOffset: 0, crossing: lv === 'ground' && !level ? 'over' : 'auto', owner, designGrade: TRACK_TYPES.electric.maxGrade,
    level: lv as BuildOptions['level'], levelDepth: st.depth || undefined, levelHeight: st.height || undefined, subway: lv === 'underground' };
}

/** Crossovers before the termini and signals of a city railway (ai.ts cityRailEconomics' estimate). */
function completionCost(stations: number, len: number, level: UpgradeLevel): number {
  const type = TRACK_TYPES.electric, lat = stationLayout(2, 0, 'middle', 'side').trackOffsets, lateral = Math.abs(lat[1] - lat[0]);
  const diagonal = Math.max(5, Math.min(12, Math.sqrt(60 * lateral * Math.min(1, type.minRadius / 12)) + 2));
  const structure = level === 'underground' ? 5 : level === 'elevated' ? 2.5 : 1;
  return Math.hypot(diagonal, lateral) * 1.04 * 4 * type.costPerUnit * structure + 8 * 30_000 + (stations * 2 + 4 + Math.ceil(len / 50) * 2) * 9000;
}

/**
 * Light rail (on the ground or on a viaduct) or a metro (underground) along a town bus line: a station at or beside its
 * stops (the city-rail planner's sites: half the walking reach in town), double track between them, a depot beside the
 * line, units of the year; as many as the buses' seats and a third more.
 */
function* cityRailQuote(g: Game, l: Line, owner: number, mode: 'lightrail' | 'metro', lv: UpgradeLevel): Generator<void, CityRailPlan> {
  const base = { line: l.id, owner, mode, level: lv };
  const none = (why: string): CityRailPlan => ({ quote: fail(base, why), plans: [], links: 0 });
  const route = routeOf(g, l)!;
  if (route.loop) return none('Loop line: trams only');
  const stations = route.path.map((id) => g.stations.get(id)!), townId = stations[0].townId;
  const unit = cityRailUnit(g.year, mode, mode === 'metro' ? 12 : 7);
  if (!unit) return none(mode === 'metro' ? 'No metro trains yet' : 'No light-rail trains yet');
  const PL = cityRailPlatform(g.year, mode);
  const end = PL + Math.max(TRACK_TYPES.electric.minRadius * 2 + 2, 18), mid = PL + 6;
  const pts = stations.map((st) => st.stops[0] ?? st);
  const targets = railTargets(pts, end, mid);
  if (targets.length < 2) return none('Too short for rail');
  const plans: StationPlan[] = [];
  for (const [k, t] of targets.entries()) {
    const p = pts[t.at], prev = targets[k - 1] ? pts[targets[k - 1].at] : null, next = targets[k + 1] ? pts[targets[k + 1].at] : null;
    const ax = (next ? next.x : p.x) - (prev ? prev.x : p.x), az = (next ? next.z : p.z) - (prev ? prev.z : p.z);
    const a0 = Math.atan2(ax, az), ux = Math.sin(a0), uz = Math.cos(a0);
    const gap = k === 1 || k === targets.length - 1 ? end - 0.5 : mid;
    let found: StationPlan | null = null, why = '';
    search: for (const [along, across] of SHIFTS) for (const da of TURNS) {
      const x = p.x + ux * along + uz * across, z = p.z + uz * along - ux * across;
      const pl = citySitePlan(g, owner, townId, mode, PL, x, z, a0 + da, lv, plans[k - 1]);
      if (!pl || typeof pl === 'string') { if (pl) why = pl; continue; }
      if (k && Math.hypot(pl.x - plans[k - 1].x, pl.z - plans[k - 1].z) < gap) continue;
      found = pl; break search;
    }
    yield;
    if (!found) return none(`No ${lv} station site at ${stations[t.at].name}${why ? ': ' + why : ''}`);
    plans.push(found);
  }
  let links = 0, len = 0;
  for (let i = 0; i + 1 < plans.length; i++) {
    let pj = plannedLink(g, plans[i], plans[i + 1], owner);
    if (!pj.ok && lv === 'ground') pj = plannedLink(g, plans[i], plans[i + 1], owner, true);
    yield;
    if (!pj.ok) return none(`No track ${stations[targets[i].at].name} – ${stations[targets[i + 1].at].name}: ${pj.errors[0] ?? 'blocked'}`);
    links += pj.cost; len += pj.stats.len / 2;
  }
  // the depot beside the line: a siding off a running track, the termini's links first (ai.ts urbanWork's yard search)
  const lat = stationLayout(2, 0, 'middle', 'side').trackOffsets;
  const D = Math.max(5, Math.min(12, Math.sqrt(60 * Math.abs(lat[1] - lat[0]) * Math.min(1, TRACK_TYPES.electric.minRadius / 12)) + 2));
  const n = plans.length, order = [...new Set([0, n - 2, ...Array.from({ length: Math.max(0, n - 1) }, (_, i) => i)])].filter((i) => i >= 0 && i + 1 < n);
  let yard: (SideYard & { rank: number }) | null = null;
  for (const index of order) {
    if (yard && index !== 0 && index !== n - 2) break;
    for (const d of sideYardDistances(plans, index, 2 * D + 4)) for (const track of [0, plans[index].layout.trackOffsets.length - 1]) {
      const w = runningSideOf(plans, index, track);
      const y = planProspectiveSideDepot(g, owner, plans, index, track, d, w, lv, 'electric', undefined, undefined, undefined, URBAN_DEPOT_POP);
      yield;
      const rank = y ? y.cost * (w === (index < (n - 1) / 2 ? 1 : -1) ? 1 : 1.15) : Infinity;
      if (y && (!yard || rank < yard.rank)) yard = { ...y, rank };
    }
  }
  if (!yard) return none('No depot site beside the line');
  const { rank: _, ...side } = yard;
  const buses = busesOf(g, l, owner);
  const vehicles = Math.max(2, Math.min(6, Math.ceil(buses.seats * 4 / 3 / Math.max(1, unit.capacity))));
  const stationCost = plans.reduce((a, p) => a + p.cost, 0), works = links + completionCost(n, len, lv);
  const q: UpgradeQuote = { ...base, ok: true, cars: [unit.id], vehicles, track: works, stations: stationCost, depot: side.cost,
    fleet: vehicles * unit.cost, resale: buses.resale, cost: 0, trackLength: len, days: 0, yard: side,
    sites: plans.map((p, k) => siteOf(p, targets[k].stops.map((i) => route.path[i]))), path: plans.map((p) => ({ x: p.x, z: p.z })) };
  q.cost = q.track + q.stations + q.depot + q.fleet - q.resale;
  q.days = daysOf(q);
  return { quote: q, plans, links };
}

/** Where a planned or built main-line station's platform track `k` ends towards `to`, and the way out there. */
function trackEnd(p: { x: number; z: number; angle: number; length: number; layout: { trackOffsets: number[] } }, to: { x: number; z: number }, k: number) {
  const ux = Math.sin(p.angle), uz = Math.cos(p.angle), side = ux * (to.x - p.x) + uz * (to.z - p.z) >= 0 ? 1 : -1;
  const off = [...p.layout.trackOffsets].sort((a, b) => a - b)[k] ?? 0;
  return { x: p.x + uz * off + ux * p.length / 2 * side, z: p.z - ux * off + uz * p.length / 2 * side, tx: ux * side, tz: uz * side };
}

/** The corridor between two main-line stations' throats (as the railway planner routes one: routeGen). */
function mainRoute(g: Game, a: { x: number; z: number; y: number; angle: number; length: number; layout: { trackOffsets: number[] } },
  b: { x: number; z: number; y: number; angle: number; length: number; layout: { trackOffsets: number[] } }, owner: number, exclude = new Set<number>()) {
  const LEAD = 20, ea = trackEnd(a, b, 0), eb = trackEnd(b, a, 0);
  const from: OPoint = { x: ea.x + ea.tx * LEAD, z: ea.z + ea.tz * LEAD, tx: ea.tx, tz: ea.tz };
  const to: OPoint = { x: eb.x + eb.tx * LEAD, z: eb.z + eb.tz * LEAD, tx: -eb.tx, tz: -eb.tz };
  const avoid = [
    { x0: ea.x - ea.tx * 4, z0: ea.z - ea.tz * 4, x1: from.x - ea.tx * 4, z1: from.z - ea.tz * 4, r: 4 },
    { x0: eb.x - eb.tx * 4, z0: eb.z - eb.tz * 4, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
  ];
  return { plan: runGen(routeGen(g, from, to, { kind: 'rail', owner, tracks: 1, y0: a.y, y1: b.y, pre: [{ x: ea.x, z: ea.z, tx: ea.tx, tz: ea.tz }],
    post: [{ x: eb.x, z: eb.z, tx: -eb.tx, tz: -eb.tz }], avoid, exclude, retries: 3 })), ea, eb };
}

/**
 * A railway for an inter-city coach line between two towns: a two-platform station in each (the railway planner's pair
 * of sites whose leads meet: railPairGen; the coach stops within a walk linked to it), single track between them (the
 * second platforms joined to it: trains pass at the stations), a depot beside the line, trains of the year seating the
 * coaches' riders and a quarter more.
 */
function* mainlineQuote(g: Game, l: Line, owner: number): Generator<void, UpgradeQuote> {
  const base = { line: l.id, owner, mode: 'rail' as const, level: 'ground' as const };
  const route = routeOf(g, l)!, towns = routeTowns(g, route.path).map((id) => g.towns.list[id]).filter((t) => !!t);
  if (towns.length !== 2 || route.path.some((id) => (g.stations.get(id)?.townId ?? -1) < 0)) return fail(base, 'Railway: two towns only');
  const [TA, TB] = towns, span = Math.hypot(TA.x - TB.x, TA.z - TB.z);
  const cars = pickTrain(g.year, 16, span * 1.3, 2);
  if (!cars) return fail(base, 'No trains yet');
  const length = Math.max(10, Math.ceil(cars.reduce((a, c) => a + c.length + 0.1, 0) + 1.5));
  // (the railway planner's site search around each town's coach stops: stations beside them, their leads meeting)
  const around = (T: Town): Town => {
    const ss = route.path.map((id) => g.stations.get(id)!).filter((st) => st.townId === T.id);
    const x = ss.reduce((a, st) => a + st.x, 0) / ss.length, z = ss.reduce((a, st) => a + st.z, 0) / ss.length;
    return { ...T, x, z, radius: Math.min(T.radius, 24) };
  };
  const pair = yield* railPairGen(g, around(TA), around(TB), { tracks: 2, length, owner, front: 22 });
  if (!pair) return fail(base, `No station sites by the stops in ${TA.name} and ${TB.name}`);
  for (const [k, p] of [pair.a, pair.b].entries()) if (!(walkingPopulation(g, planWalkingCatchment(g, p)) > 0)) return fail(base, `No residents by a station site in ${towns[k].name}`);
  const plans = [pair.a, pair.b];
  const { plan } = mainRoute(g, pair.a, pair.b, owner);
  yield;
  if (typeof plan === 'string') return fail(base, `No route ${TA.name} – ${TB.name}: ${plan}`);
  // (as the railway planner: a route winding far beyond the distance is no railway worth its running time)
  const dist = Math.hypot(pair.a.x - pair.b.x, pair.a.z - pair.b.z);
  if (plan.prof.s[plan.prof.s.length - 1] > dist * 1.55 + 25) return fail(base, `No direct route ${TA.name} – ${TB.name}`);
  const track = estimateChainCost(plan.prof, 1, 'rail', 'standard').cost + 2 * 14 * TRACK_TYPES.standard.costPerUnit;
  const len = plan.prof.s[plan.prof.s.length - 1];
  const buses = busesOf(g, l, owner), seats = cars.reduce((a, c) => a + c.capacity, 0);
  const vehicles = Math.max(1, Math.min(4, Math.ceil(buses.seats * 1.25 / Math.max(1, seats))));
  // (each stop goes to its town's station)
  const sites = plans.map((p, k) => siteOf(p, route.path.filter((id) => g.stations.get(id)?.townId === towns[k].id)));
  const q: UpgradeQuote = { ...base, ok: true, cars: cars.map((c) => c.id), vehicles, track, stations: plans.reduce((a, p) => a + p.cost, 0), depot: 150_000,
    fleet: vehicles * cars.reduce((a, c) => a + c.cost, 0), resale: buses.resale, cost: 0, trackLength: len, days: 0, sites, ways: [plan.way.map((p) => ({ ...p }))],
    path: plans.map((p) => ({ x: p.x, z: p.z })) };
  q.cost = q.track + q.stations + q.depot + q.fleet - q.resale;
  q.days = daysOf(q);
  return q;
}

// ============================================================================ the works

/** Start an upgrade as works (the quote as planned); null when started, else why not. */
export function startRouteWorks(g: Game, q: UpgradeQuote): string | null {
  if (!q.ok) return q.error ?? 'Not possible';
  const block = upgradeBlock(g, q.line, q.owner);
  if (block) return block;
  const l = g.lines.get(q.line)!, units = unitsOf(q);
  const id = g.routeWorks.reduce((m, w) => Math.max(m, w.id), 0) + 1;
  g.routeWorks.push({ id, line: l.id, owner: q.owner, mode: q.mode, level: q.level, quote: JSON.parse(JSON.stringify(q)), stage: 'build',
    unit: 0, left: units[0]?.days ?? 1, done: 0, total: units.reduce((a, u) => a + u.days, 0), waits: 0, identity: l.stops.join(','),
    started: g.day, name: l.name, built: { spent: 0, debits: [], stations: [], depot: -1, vehicles: [] } });
  return null;
}

/** Share of the works done, and what they are at (for the line window). */
export function worksStatus(w: RouteWorks): { label: string; share: number } {
  if (w.stage === 'build') {
    const share = Math.min(0.99, w.done / Math.max(1, w.total));
    return { label: w.note ?? `Building · ${Math.floor(share * 100)}%`, share };
  }
  if (w.stage === 'switch') return { label: w.note ?? 'Switching', share: 1 };
  return { label: 'Removing old stops', share: 1 };
}

const MODE_WORD: Record<UpgradeMode, string> = { tram: 'trams', lightrail: 'light rail', metro: 'metro', rail: 'trains' };

/** One step of every works under way (Game, at the start of each day). */
export function stepRouteWorks(g: Game) {
  for (const w of [...g.routeWorks]) {
    try { stepWorks(g, w); } catch (e) {
      // (a bug must not stop the game: the works are given up as a failure would, else dropped)
      try { giveUp(g, w, String((e as Error)?.message ?? e)); } catch { finish(g, w); }
    }
  }
}

/** Pay for a step: the owner's cash (an AI company borrows for it). */
function fund(g: Game, owner: number, cost: number): boolean {
  const eco = g.company(owner).economy;
  if (eco.money >= cost) return true;
  const ai = g.aiOf(owner);
  return !!ai && ai.fundWorks(cost);
}

function finish(g: Game, w: RouteWorks) { g.routeWorks = g.routeWorks.filter((x) => x !== w); }

/** Works that cannot go on before the switch: taken up again with a refund (what trains stand on stays). */
function giveUp(g: Game, w: RouteWorks, why: string) {
  finish(g, w);
  if (w.stage === 'remove') return;
  for (const id of w.built.vehicles) if (g.vehicles.get(id)?.owner === w.owner) g.vehicles.sell(id);
  const used = w.built.stations.some((id) => g.lines.all().some((l) => l.stops.includes(id)));
  const refund = used || worksBusy(g, w.built) ? 0 : takeUpWorks(g, w.owner, w.built);
  const st = g.stations.get(g.lines.get(w.line)?.stops[0] ?? -1);
  if (w.owner === 0) g.postNews(`${w.name}: ${MODE_WORD[w.mode]} works stopped (${why})${refund ? `, ${Math.round(refund / 1000)}k refunded` : ''}.`, 'bad', st?.x, st?.z);
  else g.aiOf(w.owner)?.railNote(`${w.name}: ${MODE_WORD[w.mode]} works given up: ${why}`);
}

/** Cancel works before the switch (the player): what was built is taken up and refunded. Null when done, else why not. */
export function cancelRouteWorks(g: Game, id: number, owner: number): string | null {
  const w = g.routeWorks.find((x) => x.id === id);
  if (!w || w.owner !== owner) return 'No such works';
  if (w.stage === 'remove') return 'Already switched';
  giveUp(g, w, 'cancelled');
  return null;
}

/** The line is as it was when the works began (same stops, ours, a bus line, no partners). */
function lineIntact(g: Game, w: RouteWorks): Line | null {
  const l = g.lines.get(w.line);
  if (!l || l.id !== w.line || l.owner !== w.owner || l.kind !== 'road' || l.stops.join(',') !== w.identity) return null;
  return l.vehicles.every((id) => g.vehicles.get(id)?.owner === w.owner) ? l : null;
}

function stepWorks(g: Game, w: RouteWorks) {
  if (w.stage === 'remove') { removeStep(g, w); return; }
  const l = lineIntact(g, w);
  if (!l) { giveUp(g, w, 'line changed'); return; }
  if (w.stage === 'switch') { switchStep(g, w, l); return; }
  const units = unitsOf(w.quote);
  if (w.left > 0) { w.left--; w.done++; if (w.left > 0) return; }
  const u = units[w.unit];
  if (!u) { w.stage = 'switch'; delete w.note; return; }
  const r = buildUnit(g, w, l, u);
  if (r === 'wait') {
    w.note = 'Waiting for funds';
    if (++w.waits > MAX_WAIT) giveUp(g, w, 'no money');
    return;
  }
  if (r) { giveUp(g, w, r); return; }
  delete w.note; w.waits = 0;
  w.unit++;
  const next = units[w.unit];
  if (next) w.left = next.days; else w.stage = 'switch';
}

/** Build one unit: null when built, 'wait' (no money yet), else why the works cannot go on. */
function buildUnit(g: Game, w: RouteWorks, l: Line, u: ReturnType<typeof unitsOf>[number]): string | null {
  const q = w.quote, me = w.owner, net = g.world.net, b = w.built;
  const demolished = (ids: number[]) => ids.reduce((n, id) => { const x = g.world.buildings.get(id); return n + (x ? demolitionCost(g, x) : 0); }, 0);
  if (u.kind === 'tracks') {
    // the route's streets still without tracks: this unit's share of them (the last: all that are left)
    const p = planTramUpgrade(g, l.id, me, q.vehicles);
    if (!p.ok) return p.error ?? 'streets changed';
    const chunks = unitsOf(q).filter((x) => x.kind === 'tracks').length, left = chunks - u.i;
    const want = p.trackLength / Math.max(1, left);
    const pick: number[] = [];
    let got = 0;
    for (const id of p.fresh) { if (got >= want - 1e-6 && left > 1) break; pick.push(id); got += net.edges.get(id)!.len; }
    if (!pick.length) return null;
    const dry = addTramTracks(g, pick, me, true);
    if (!dry.changed) return dry.error ?? 'no tracks laid';
    if (!fund(g, me, dry.cost)) return 'wait';
    const err = recordWorks(g, me, b, () => { const r = addTramTracks(g, pick, me); return r.changed ? null : r.error ?? 'no tracks laid'; });
    b.debits[b.debits.length - 1].tram = pick.filter((id) => net.edges.get(id)?.tram && net.edges.get(id)?.tramOwner === me);
    return err;
  }
  if (u.kind === 'station') {
    const s = q.sites![u.i], plan = replan(g, s, me, 2);
    if (!plan.ok || plan.join) return `station: ${plan.error ?? 'site taken'}`;
    if (!fund(g, me, plan.cost)) return 'wait';
    const id = g.stations.nextId, lost = demolished(plan.demolish);
    const err = recordWorks(g, me, b, () => g.stations.commitRail(plan, me), lost, id);
    if (err || !g.stations.get(id)?.rail) return `station: ${err ?? 'not built'}`;
    b.stations.push(id);
    return null;
  }
  const sts = b.stations.map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
  if (sts.length !== b.stations.length) return 'station gone';
  if (u.kind === 'link') {
    const A = sts[u.i], B = sts[u.i + 1];
    if (!A || !B) return 'station gone';
    if (q.mode === 'rail') return mainLink(g, w, A, B);
    const ends = (st: Station, to: Station) => {
      const r = st.rail!, fwd = Math.sin(r.angle) * (to.x - st.x) + Math.cos(r.angle) * (to.z - st.z) >= 0;
      return stationEnds(g, st).map((e) => fwd ? e.front : e.back);
    };
    const plan = (level: boolean) => planEdge(g, nodeSnap(g, ends(A, B)[0], 'rail'), nodeSnap(g, ends(B, A)[0], 'rail'), linkOptions(A.rail!, me, level));
    let pj = plan(false);
    if (!pj.ok && q.level === 'ground') pj = plan(true);
    if (!pj.ok) return `track ${A.name} – ${B.name}: ${pj.errors[0] ?? 'blocked'}`;
    if (!fund(g, me, pj.cost)) return 'wait';
    const err = recordWorks(g, me, b, () => commitProposal(g, pj), demolished(pj.demolish));
    return err ? `track ${A.name} – ${B.name}: ${err}` : null;
  }
  if (u.kind === 'finish') {
    // directional running: crossovers before the termini, one-way block signals (trackops)
    const doubles = [...new Set(b.debits.flatMap((d) => d.edges))].filter((id) => { const e = net.edges.get(id); return !!e && e.kind === 'rail' && e.station < 0 && e.depot < 0; });
    let error: string | undefined;
    recordWorks(g, me, b, () => { error = finishDoubleTrack(g, doubles, me).error; return null; });
    return error ? `crossovers: ${error}` : null;
  }
  if (u.kind === 'depot') {
    if (q.mode === 'tram') {
      const stations = [...new Set(l.stops)];
      const have = [...g.depots.map.values()].find((d) => d.owner === me && d.kind === 'tram' && roadDepotReaches(g, d, stations[0]));
      if (have) { b.depot = have.id; return null; }
      if (!fund(g, me, Math.max(q.depot, 150_000))) return 'wait';
      // the tram depot sites along the route in turn (tramDepotGen's), the first that reaches every stop; a site that
      // does not is taken up again at once, refunded (works roll back what does not serve them)
      const p = planTramUpgrade(g, l.id, me, q.vehicles);
      for (const plan of tramDepotSites(g, pathPoints(g, p.edges), stations, me)) {
        const id = g.depots.nextId;
        if (!g.company(me).economy.canAfford(plan.cost)) return 'wait';
        recordWorks(g, me, b, () => g.depots.commit('tram', plan, me), demolished(plan.demolish));
        const d = b.debits[b.debits.length - 1], dp = g.depots.get(id);
        if (dp) d.depot = id;
        if (dp && stations.every((sid) => roadDepotReaches(g, dp, sid))) { b.depot = id; return null; }
        // (nothing else of the works stands on it yet)
        b.debits.pop(); b.spent -= d.cost;
        takeUpWorks(g, me, { spent: d.cost, debits: [d] });
      }
      return 'no tram depot site on the route';
    }
    const order = sts.map((s) => s.id), plain = [...new Set(b.debits.flatMap((d) => d.edges))].filter((id) => { const e = net.edges.get(id); return !!e && e.kind === 'rail' && e.station < 0 && e.depot < 0; });
    if (!fund(g, me, q.depot * 1.2)) return 'wait';
    let id = -1;
    const lv = q.level, type = q.mode === 'rail' ? 'standard' : 'electric';
    recordWorks(g, me, b, () => {
      // the planned siding; else another beside the line, at its level
      if (q.yard) id = buildPlannedSideDepot(g, q.yard, lv, me, order, type, URBAN_DEPOT_POP);
      const T = sts[Math.min(q.yard?.index ?? 0, sts.length - 1)];
      if (id < 0 && q.mode !== 'rail') id = buildDepotBeside(g, plain, q.yard?.jx ?? T.x, q.yard?.jz ?? T.z, me, order,
        { sections: [lv === 'underground' ? 'tunnel' : lv === 'elevated' ? 'bridge' : 'ground'], tries: 16, maxDist: q.yard ? 20 : 60, type, maxPop: URBAN_DEPOT_POP });
      // (a railway's: beside its open line, near either station, wherever a siding fits)
      if (q.mode === 'rail') for (const S of sts) if (id < 0) id = buildDepotBeside(g, plain, S.x, S.z, me, order, { sections: ['ground', 'bridge', 'tunnel'], tries: 24, type });
      return null;
    });
    b.debits[b.debits.length - 1].depot = id;
    if (id < 0) return 'no depot site beside the line';
    b.depot = id;
    return null;
  }
  // fleet: the new vehicles wait in the depot (no line) until the switch
  const dp = g.depots.get(b.depot);
  if (!dp) return 'depot gone';
  const cars = q.cars.map((m) => MODEL_BY_ID.get(m)).filter((m): m is VehicleModel => !!m);
  if (cars.length !== q.cars.length || !cars.length) return 'no vehicles';
  const price = cars.reduce((a, c) => a + c.cost, 0), n = q.vehicles - b.vehicles.length;
  if (n > 0 && !fund(g, me, price * n)) return 'wait';
  for (let i = 0; i < n; i++) {
    const v = q.mode === 'tram' ? g.vehicles.buyRoad(dp.id, cars[0], null) : g.vehicles.buyTrain(dp.id, cars, null);
    if (typeof v === 'string') return v === 'Not enough money' ? 'wait' : v;
    b.vehicles.push(v.id);
  }
  return null;
}

/** A railway's single track between two of its stations (the railway planner's corridor), the second platforms joined to it. */
function mainLink(g: Game, w: RouteWorks, A: Station, B: Station): string | null {
  const me = w.owner, net = g.world.net, b = w.built;
  const a = { ...A.rail!, layout: { trackOffsets: A.rail!.trackOffsets } }, c = { ...B.rail!, layout: { trackOffsets: B.rail!.trackOffsets } };
  const end = (st: Station, to: Station, k: number) => {
    const r = st.rail!, fwd = Math.sin(r.angle) * (to.x - st.x) + Math.cos(r.angle) * (to.z - st.z) >= 0;
    const e = stationEnds(g, st)[k];
    return e ? (fwd ? e.front : e.back) : -1;
  };
  const a0 = end(A, B, 0), b0 = end(B, A, 0);
  const na = net.nodes.get(a0), nb = net.nodes.get(b0);
  if (!na || !nb) return 'station tracks';
  // (the stations' own track and access streets, laid by the works, are no obstacle)
  const own = new Set([...na.edges, ...nb.edges, ...A.rail!.edges, ...B.rail!.edges, ...b.debits.filter((d) => d.station === A.id || d.station === B.id).flatMap((d) => d.edges)]);
  // the way as planned where it is still clear, else the corridor planned again
  const ea = trackEnd(a, c, 0), eb = trackEnd(c, a, 0), saved = w.quote.ways?.[0];
  let way: OPoint[] | null = null, prof: ChainProfile | null = null;
  if (saved?.length) {
    const p = chainProfile(g, [{ x: ea.x, z: ea.z, tx: ea.tx, tz: ea.tz }, ...saved], 1, A.rail!.y, B.rail!.y, 'rail', own);
    if (p && !routeConflictAt(g, p, 'rail', 1, own)) { way = saved; prof = p; }
  }
  if (!way || !prof) {
    const { plan } = mainRoute(g, a, c, me, own);
    if (typeof plan === 'string') return `no route ${A.name} – ${B.name}: ${plan}`;
    if (plan.prof.s[plan.prof.s.length - 1] > Math.hypot(A.x - B.x, A.z - B.z) * 1.55 + 25) return `no direct route ${A.name} – ${B.name}`;
    way = plan.way; prof = plan.prof;
  }
  const estimate = estimateChainCost(prof, 1, 'rail', 'standard').cost;
  if (!fund(g, me, estimate * 1.2 + 200_000)) return 'wait';
  const opts: BuildOptions = { kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner: me };
  return recordWorks(g, me, b, () => {
    const res = buildChain(g, a0, way!, opts, b0, prof);
    if (!res.ok) return `track ${A.name} – ${B.name}: ${res.error ?? 'blocked'}`;
    // (the second platform track joins the lead a little out of each station)
    for (const [st, e, k] of [[A, ea, end(A, B, 1)], [B, eb, end(B, A, 1)]] as const) {
      if (k < 0) continue;
      const s = findSnap(g, 'rail', e.x + e.tx * 14, e.z + e.tz * 14, 0.6);
      const pj = s.kind !== 'free' ? planEdge(g, nodeSnap(g, k, 'rail'), s, opts) : null;
      if (!pj?.ok || commitProposal(g, pj)) return `throat at ${st.name}`;
    }
    return null;
  });
}

/** Native routing from a's platforms to b for a consist (ai-hub.ts route): can the new trains run the line? */
function runs(g: Game, a: Station, b: Station, cars: VehicleModel[], owner: number): boolean {
  const length = cars.reduce((n, c) => n + c.length + 0.1, 0), rule = consistRule(cars);
  for (const group of g.stations.railTrackGroups(a)) {
    if (group.length < length) continue;
    for (const steps of [group.steps, [...group.steps].reverse().map((s) => ({ edge: s.edge, dir: -s.dir }))]) {
      const front = platformDepartureFrontiers(g, steps, owner, rule, length);
      if (findRailRoute(g, [...front.forward, ...front.reverse], b.id, owner, -1, 20000, false, rule, true, { length })) return true;
    }
  }
  return false;
}

/** The switch: the line runs the new vehicles from today; its buses come off. */
function switchStep(g: Game, w: RouteWorks, l: Line) {
  const me = w.owner, q = w.quote, b = w.built;
  const vs = b.vehicles.map((id) => g.vehicles.get(id)).filter((v) => !!v && v.owner === me);
  const dp = g.depots.get(b.depot);
  if (!dp || vs.length !== b.vehicles.length || !vs.length) { giveUp(g, w, 'vehicles gone'); return; }
  const buses = busesOf(g, l, me), freed = [...new Set(buses.vs.map((v) => v.depotId))];
  let stops: number[];
  const olds: [number, number][] = [];
  if (q.mode === 'tram') {
    const stations = [...new Set(l.stops)];
    const missing = stations.find((sid) => !g.stations.tramStops(g.stations.get(sid)!, me).length || !roadDepotReaches(g, dp, sid));
    if (missing !== undefined) { giveUp(g, w, `no tram stop at ${g.stations.get(missing)?.name ?? 'a stop'}`); return; }
    stops = l.stops;
  } else {
    const sts = b.stations.map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
    const cars = (vs[0] as Train).cars;
    if (sts.length !== b.stations.length || sts.length < 2) { giveUp(g, w, 'station gone'); return; }
    for (let i = 0; i + 1 < sts.length; i++) for (const [x, y] of [[sts[i], sts[i + 1]], [sts[i + 1], sts[i]]]) {
      if (!runs(g, x, y, cars, me)) { giveUp(g, w, `no route ${x.name} – ${y.name}`); return; }
    }
    if (!sts.slice(1).some((s, i) => depotServes(g, dp, sts[i].id, s.id, cars) >= 0)) { giveUp(g, w, 'depot off the line'); return; }
    // the old stops go to the station that takes them over, linked to it where they are within a walk
    q.sites!.forEach((s, k) => { for (const id of s.stops) if (!olds.some(([o]) => o === id)) olds.push([id, sts[k].id]); });
    for (const [o, n] of olds) if (g.stations.get(o) && g.stations.canLink(o, n) === null) g.stations.link(o, n);
    stops = outAndBack(sts.map((s) => s.id));
  }
  // the buses off the line (sold), the line retyped: its id, name, history and waiting passengers stay
  for (const v of buses.vs) g.vehicles.sell(v.id);
  const kind = q.mode === 'tram' ? 'tram' : 'rail';
  if (kind === 'rail') l.routeFamily ??= l.id;
  g.lines.retype(l.id, kind);
  if (kind === 'rail') {
    l.stops = stops; delete l.loop; delete l.spacing; delete l.platforms;
    const re = new Map(olds);
    for (const [o, n] of olds) {
      const X = g.stations.get(o), S = g.stations.get(n);
      if (!X || !S) continue;
      // the line's riders waiting at an old stop wait at its station now (bound for its stations)
      const all = [...X.waiting.values()];
      if (!all.some((x) => x.line === l.id)) continue;
      X.waiting.clear(); X.waitingTotal = 0;
      for (const x of all) {
        if (x.line !== l.id) g.stations.addWaiting(X, x.line, x.alight, x.dest, x.count, 0, x.t, x.transfers ?? 0, x.rail ?? 0, x.ic ?? 0);
        else g.stations.addWaiting(S, x.line, re.get(x.alight) ?? x.alight, re.get(x.dest) ?? x.dest, x.count, 0, x.t, x.transfers ?? 0, x.rail ?? 0, x.ic ?? 0);
      }
    }
    g.lines.rebuild();
    autoSignalLine(g, l.id, me);
  }
  for (const v of vs) {
    v!.setLine(l.id);
    if (v instanceof Train) { const call = openingRailCall(g, v); if (call >= 0 && call !== v.stopIndex) { v.stopIndex = call; v.onLineChanged(); } }
  }
  g.aiOf(me)?.routeUpgraded(l.id, kind, dp.id, vs.length, q.mode === 'lightrail' || q.mode === 'metro' ? q.mode : undefined);
  w.stage = 'remove'; w.olds = olds; w.depots = freed; w.removing = 0; w.waits = 0; delete w.note;
  const st = g.stations.get(l.stops[0]);
  if (me === 0) g.postNews(`${l.name}: ${MODE_WORD[q.mode]} in service.`, 'good', st?.x, st?.z);
  else g.postNews(`${g.company(me).name} switches ${w.name} to ${MODE_WORD[q.mode]} (${l.name}).`, 'ai', st?.x, st?.z);
}

/** Remove: an old stop no line serves (its waiting passengers and mail to its station), then the freed bus depots. */
function removeStep(g: Game, w: RouteWorks) {
  const olds = w.olds ?? [], me = w.owner;
  const at = w.removing ?? 0;
  if (at < olds.length) {
    w.removing = at + 1;
    const X = g.stations.get(olds[at][0]), S = g.stations.get(olds[at][1]);
    if (!X || X.owner !== me || X.rail || g.lines.all().some((x) => x.stops.includes(X.id))) return;
    if (S) { const deliveries = handOver(g, X, S); g.stations.removeStation(X.id); for (const d of deliveries) settleMail(g, d.st, d.count, d.j, null); }
    else g.stations.removeStation(X.id);
    return;
  }
  const depots = w.depots ?? [], k = at - olds.length;
  if (k < depots.length) {
    w.removing = at + 1;
    const d = g.depots.get(depots[k]);
    const kept = g.aiOf(me)?.managedDepots() ?? [];
    if (d && d.owner === me && !kept.includes(d.id) && ![...g.vehicles.map.values()].some((v) => (v as RoadVehicle | Train).depotId === d.id)) g.depots.remove(d.id);
    return;
  }
  finish(g, w);
}

/** Save form (plain data). */
export function saveRouteWorks(g: Game): RouteWorks[] { return JSON.parse(JSON.stringify(g.routeWorks)); }
export function loadRouteWorks(g: Game, d: unknown) { g.routeWorks = Array.isArray(d) ? JSON.parse(JSON.stringify(d)) : []; }
