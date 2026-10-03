// AI network management (v2.4, UPDATE 9f / 9g / 9i / 9k / 9l / 9m): what an AI company does with the railways it
// already has, beside opening new ones (ai.ts). ai.ts calls `networkDaily(ai)` once a game day while the company
// has no project running; one task starts at a time (each on its own period, the first runs spread out per
// company) and its work runs in small steps within a few milliseconds a day:
//  - lines: no line is a subset / superset of another (patterns.ts canonicalizeLines: one line, service patterns);
//  - decommission: a route losing money two years running is closed (a through line with a neighbouring line of
//    ours is tried first); stations, depots and track nobody uses are taken up after a grace period (what other
//    companies use is kept: their fees pay for it);
//  - capacity: stations needing room (alongside ai.ts, also for other companies' trains), junctions of two operators and
//    hubs of three lines to 3-4 platforms, trains of any company waiting for a platform; a building where its
//    wider catchment pays for it (halt -> building, concourse / terminal in big towns), none at quiet halts;
//  - pair: two own single tracks side by side become one directional double track (pairAsDoubleTrack);
//  - crossovers: double track normalised to =====x==[station]==x===== (normaliseCrossovers, when there);
//  - connect: a terminus whose free end faces another line's track gets a junction and its line runs through to
//    the next station there (X-A-B + Y-A-C networks), when the trips it connects pay for it;
//  - insert: a station on a line where the town grew beyond the stations' catchment (planStationOnTrack);
//  - interchange: a station where two lines cross or meet (in town or in open country) purely for transfers,
//    justified by the trips between their stations that routing cannot serve today;
//  - consolidate: two of our termini in one town become one station (rail parts united, or the lines moved to
//    the bigger one over a new junction and the other taken up);
//  - stops: our adjacent bus stops merged, one of ours beside an open-access stop given up for it;
//  - tidy: dead-end stubs of ours taken up (no track or road of ours ends on a bridge);
//  - relevel: a ground station splitting a town centre lifted onto a viaduct (planRelevel, when there).
// Spending follows the company's money rules (available(), borrowing in steps as ai.ts does); land is graded and
// a few town buildings demolished where that gives a better site (cost plus compensation, a small rating hit).
import type { Game } from './game';
import type { AIController } from './ai';
import type { Station } from './stations';
import type { NEdge, NNode } from './network';
import type { Line } from './lines';
import type { Economy } from './economy';
import type { Proposal, BuildOptions, Snap } from './construction';
import { railModeOf, defaultPlatformLength, planStationUpgrade, commitStationUpgrade, railCatchShapes, CATCHMENT_RADIUS } from './stations';
import { defaultStationStyle, styleOf, stylesFor } from './station-styles';
import * as Trackops from './trackops';
import * as StationsMod from './stations';
import * as Patterns from './patterns';
import { autoSignalLine } from './signals';
import { findRailRoute, railNext, platformWaits } from './train';
import { linearStops, outAndBack } from './lines';
import { planEdge, commitProposal } from './construction';
import { removeEdges, nodeSnap } from './routing';
import { terraformBrush } from './build-ops';
import { BT_TOWER } from './towns';
import { estimateLegTime, estimateLegFare } from './fares';
import { TRACK_TYPES, PASSENGER_RATE_SCALE, PASSENGER_FARE_SCALE } from './constants';

// ============================================================================ optional primitives (feature-detected)

interface PlanLike { ok: boolean; error?: string; cost: number }
interface ConnPlan extends PlanLike { proposal: Proposal | null; turnouts: { edge: number; s: number; x: number; z: number }[] }
interface OnTrackPlanLike extends PlanLike { station: { x: number; z: number; angle: number; length: number } | null }
interface FinishLike { signals: number; crossovers: number; cost: number; error?: string }
/** Track and station operations of trackops.ts / stations.ts this module uses when they are there. */
interface NetOps {
  pairAsDoubleTrack?: (g: Game, a: number[], b: number[], owner: number) => FinishLike;
  planConnection?: (g: Game, ea: number, sa: number, eb: number, sb: number, owner: number, o?: { search?: number; dirA?: 1 | -1; dirB?: 1 | -1 }) => ConnPlan;
  commitConnection?: (g: Game, plan: ConnPlan) => { error: string | null; edges: number[]; signals: number };
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
  canonicalizeLines?: (g: Game, lineId?: number) => { from: number; into: number; text: string }[];
  subsetOf?: (g: Game, l: Line) => Line | null;
  linePatterns?: (l: Line) => { kind: string; stops: boolean[] }[];
  patternHeadways?: (g: Game, l: Line) => { headway: number }[];
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
interface ManagedLine { kind: string; towns: number[]; depot: number; maxVehicles: number; opened: number; shared?: number; joined?: boolean; urban?: string; double?: boolean }

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// ============================================================================ tasks

type Task = 'lines' | 'decommission' | 'capacity' | 'pair' | 'crossovers' | 'connect' | 'insert' | 'interchange' | 'consolidate' | 'stops' | 'tidy' | 'relevel';

/** Tasks in priority order: how often (days) and whether they spend money (then only with money to spare). */
const TASKS: { id: Task; period: number; spend: boolean }[] = [
  { id: 'lines', period: 30, spend: false },
  { id: 'decommission', period: 30, spend: false },
  { id: 'capacity', period: 30, spend: true },
  { id: 'pair', period: 90, spend: true },
  { id: 'tidy', period: 120, spend: false },
  { id: 'connect', period: 120, spend: true },
  { id: 'insert', period: 120, spend: true },
  { id: 'interchange', period: 150, spend: true },
  { id: 'consolidate', period: 120, spend: true },
  { id: 'crossovers', period: 180, spend: false },
  { id: 'stops', period: 180, spend: false },
  { id: 'relevel', period: 360, spend: true },
];

/** Fixed work allowance per daily call. Timing is profiling only; load never changes the amount of work. */
export const NETWORK_WORK_UNITS = 4;

/** Spacing of stations along a line by mode (units): no station inserted closer to another one. */
const MIN_SPACING: Record<string, number> = { mainline: 45, metro: 18, lightrail: 15 };
/** Residents a new station must newly cover (beyond the other stations' catchment) to be inserted. */
const INSERT_POP: Record<string, number> = { mainline: 650, metro: 900, lightrail: 450 };

/** Counters (in AIController.stats, saved with it): the ones ai.ts declares and this module's own. */
type NetStat = 'grown' | 'merged' | 'paired' | 'connections' | 'stubs' | 'netDecommissioned' | 'netRetired' | 'netInserted' | 'netInterchanges'
  | 'netLinesMerged' | 'netRestyled' | 'netConsolidated' | 'netStopsMerged' | 'netThrough' | 'netRelevelled' | 'netCrossovers' | 'netGraded' | 'netDemolished' | 'netJoined';

/** Frame cost of the daily network work over all companies (tests / profiling). */
export const networkProfile = { calls: 0, steps: 0, maxSteps: 0, ms: 0, max: 0, slow: 0, decisions: {} as Record<string, number>,
  tasks: {} as Record<string, { steps: number; ms: number; max: number }> };
/**
 * Settings: the switch (tests: the AI without its network work), trips a month a through connection from a
 * terminus and an interchange station must newly connect, and a factor on the residents an inserted station
 * must newly cover.
 */
// These gates were calibrated at the old passenger rate. Money limits remain in game money.
export const networkOptions = { enabled: true, throughTrips: 25 * PASSENGER_RATE_SCALE, interchangeTrips: 45 * PASSENGER_RATE_SCALE, insertPop: PASSENGER_RATE_SCALE };

const planners = new WeakMap<AIController, NetPlanner>();

/** Durable deadlines, in game days. Scans and geometry caches are rebuilt from the saved world. */
export interface NetworkPlannerState {
  next: [Task, number][];
  care: [string, number][];
  sizes: [number, { key: string; day: number }][];
  retire: [string, number][];
  /** This cache has a game-day expiry; keeping its exact doubles avoids changing a pending value estimate. */
  demand?: { day: number; nt: number; P: number[] } | null;
}
interface NetworkSave { version: 1; companies: [number, NetworkPlannerState][] }

/** The save hook deliberately does not create planners for companies which have never done network work. */
export function saveNetwork(g: Game): NetworkSave {
  const companies: NetworkSave['companies'] = [];
  for (const ai of g.ais) { const p = planners.get(ai); if (p) companies.push([ai.companyId, p.save()]); }
  companies.sort((a, b) => a[0] - b[0]);
  return { version: 1, companies };
}

/** Old saves have no aiNetwork field and keep the initial, company-staggered schedule. */
export function loadNetwork(g: Game, data?: NetworkSave): void {
  if (data?.version !== 1 || !Array.isArray(data.companies)) return;
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
  p.job = p.run(task); p.task = task;
  for (let i = 0; i < steps && p.job; i++) if (p.job.next().done) { p.job = null; p.task = null; }
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
  job: Generator<void, void> | null = null;
  task: Task | null = null;
  /** day each task may run next */
  private next = new Map<Task, number>();
  /** per-object cool-down: key -> day it may be looked at again */
  private care = new Map<string, number>();
  /** station sizes seen (tracks / through / length / style) and the day they last changed */
  private sizes = new Map<number, { key: string; day: number }>();
  /** things of ours nobody uses: key -> day they may be taken up */
  private retire = new Map<string, number>();
  /** route cache (edge ids between two stations for an owner), valid for one network version */
  private rc = new Map<string, number[] | null>();
  private rcVersion = -1;
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
    };
  }

  load(s: NetworkPlannerState): void {
    if (Array.isArray(s.next)) for (const [id, day] of s.next) if (TASKS.some((t) => t.id === id) && Number.isFinite(day)) this.next.set(id, day);
    if (Array.isArray(s.care)) this.care = new Map(s.care.map(([k, d]) => [k, d]));
    if (Array.isArray(s.sizes)) this.sizes = new Map(s.sizes.map(([id, v]) => [id, { ...v }]));
    if (Array.isArray(s.retire)) this.retire = new Map(s.retire.map(([k, d]) => [k, d]));
    if (s.demand && Array.isArray(s.demand.P) && s.demand.P.length === s.demand.nt * s.demand.nt) this.dem = { ...s.demand, P: new Float64Array(s.demand.P) };
  }

  private get eco(): Economy { return this.g.company(this.me).economy; }
  private get name(): string { return this.g.company(this.me).name; }
  private managed(): Map<number, ManagedLine> | null { return (this.ai as unknown as { lines?: Map<number, ManagedLine> }).lines ?? null; }

  daily() {
    const t0 = now();
    let units = 0;
    try {
      const g = this.g;
      if (!this.job) {
        const t = TASKS.find((x) => (this.next.get(x.id) ?? 0) <= g.day);
        if (!t) return;
        this.next.set(t.id, g.day + t.period + ((this.me * 7 + g.day) % 13));
        if (t.spend && !this.mayBuild()) return;
        this.job = this.run(t.id);
        this.task = t.id;
      }
      while (this.job && units < NETWORK_WORK_UNITS) {
        const t1 = now(), task = this.task ?? '?';
        const done = this.job.next().done;
        units++;
        const dt = now() - t1, tp = (networkProfile.tasks[task] ??= { steps: 0, ms: 0, max: 0 });
        tp.steps++; tp.ms += dt; tp.max = Math.max(tp.max, dt);
        if (done) { this.job = null; this.task = null; break; }
      }
    } catch (e) {
      this.note(`network work (${this.task}) failed: ${String((e as Error)?.message ?? e)}`);
      if (!this.errLogged) { this.errLogged = true; console.warn(`AI network ${this.name}:`, e); }
      this.job = null;
      this.task = null;
    } finally {
      const dt = now() - t0;
      this.prof.calls++; this.prof.ms += dt; this.prof.max = Math.max(this.prof.max, dt);
      networkProfile.calls++; networkProfile.ms += dt; networkProfile.max = Math.max(networkProfile.max, dt);
      networkProfile.steps += units; networkProfile.maxSteps = Math.max(networkProfile.maxSteps, units);
      if (dt > 15) networkProfile.slow++;
    }
  }

  run(task: Task): Generator<void, void> {
    switch (task) {
      case 'lines': return this.linesTask();
      case 'decommission': return this.decommissionTask();
      case 'capacity': return this.capacityTask();
      case 'pair': return this.pairTask();
      case 'crossovers': return this.crossoversTask();
      case 'connect': return this.connectTask();
      case 'insert': return this.insertTask();
      case 'interchange': return this.interchangeTask();
      case 'consolidate': return this.consolidateTask();
      case 'stops': return this.stopsTask();
      case 'tidy': return this.tidyTask();
      case 'relevel': return this.relevelTask();
    }
  }

  // ---------------------------------------------------------------- small helpers
  private note(s: string) {
    const log = this.ai.log;
    log.push(`${this.g.dateString()}: ${s}`);
    if (log.length > 40) log.shift();
  }
  private bump(k: NetStat, n = 1) { const s = this.ai.stats as unknown as Record<string, number>; s[k] = (s[k] ?? 0) + n; }
  private considered(k: string) { networkProfile.decisions[k] = (networkProfile.decisions[k] ?? 0) + 1; }
  private news(text: string, x?: number, z?: number) { this.g.postNews(`${this.name} ${text}`, 'ai', x, z); }
  private cared(key: string): boolean { return (this.care.get(key) ?? -1) > this.g.day; }
  private careFor(key: string, days: number) { this.care.set(key, this.g.day + days); }

  /** May the company spend on its network now? (its money rules: cash plus credit, loan and losses in bounds) */
  private mayBuild(): boolean {
    const e = this.eco, c = this.ai.config;
    if (this.ai.available() < 750_000) { this.considered('build.cash'); return false; }
    if (e.loan > e.maxLoan * Math.min(0.97, this.ai.loanAppetite + 0.2)) return false;
    // Opening a railway is a capital outlay, not a recurring loss that should bar useful improvements.
    const v = e.yearTotals[e.yearTotals.length - 1]?.v;
    if (v && e.lastYearProfit - v.construction - v.vehicles < -1_500_000 * (0.5 + c.risk)) { this.considered('build.loss'); return false; }
    return true;
  }
  /** Borrow in steps (as ai.ts) until `amount` is there. */
  private borrowFor(amount: number): boolean {
    const e = this.eco;
    while (e.money < amount + 300_000 && e.borrow()) { /* borrow in steps */ }
    return e.money >= amount;
  }
  /** A spend of `cost` within `share` of what the company can commit; borrows for it. */
  private canSpend(cost: number, share = 0.3): boolean {
    if (!(cost >= 0)) return false;
    return cost <= Math.max(0, this.ai.available()) * share && this.borrowFor(cost);
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

  /** Cached route between two stations (for `owner`'s trains). */
  private route(a: number, b: number, owner = this.me): number[] | null {
    const net = this.g.world.net;
    if (this.rcVersion !== net.version) { this.rc.clear(); this.rcVersion = net.version; }
    const k = `${owner}:${a}:${b}`;
    if (this.rc.has(k)) return this.rc.get(k)!;
    const r = routeBetween(this.g, a, b, owner);
    this.rc.set(k, r);
    return r;
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
      for (const [a, b] of this.pairsOf(l)) if (!routeBetween(this.g, a, b, l.owner) || !routeBetween(this.g, b, a, l.owner)) return false;
    }
    return true;
  }

  private signal(lineId: number): number {
    try { return autoSignalLine(this.g, lineId, this.me).placed; } catch (e) { this.note('signalling failed: ' + String((e as Error)?.message ?? e)); return 0; }
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
    try {
      for (const nt of PAT.canonicalizeLines(this.g, lineId)) { this.note(nt.text); this.bump('netLinesMerged'); this.forget(nt.from); }
    } catch (e) { this.note('line merge failed: ' + String((e as Error)?.message ?? e)); }
  }

  /** A line that no longer exists: out of its company's controller (ai.ts would otherwise follow the merged id). */
  private forget(lineId: number) {
    for (const ai of this.g.ais) (ai as unknown as { lines?: Map<number, ManagedLine> }).lines?.delete(lineId);
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
      revenue += added * 12 * estimateLegFare(distance, 70, headway, 1, 1.3, direct, false);
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
  private compensate(ids: number[]) {
    if (!ids.length) return;
    const g = this.g, w = g.world;
    let pay = 0;
    const towns = new Set<number>();
    for (const id of ids) { const b = w.buildings.get(id); if (b) { pay += 3000 + b.pop * 1250; towns.add(b.townId); } }
    if (pay) this.eco.spend(pay, 'construction', true);
    for (const st of g.stations.map.values()) if (st.owner === this.me && towns.has(st.townId)) st.rating = Math.max(0, st.rating - 0.015 * ids.length);
    this.bump('netDemolished', ids.length);
  }

  /** Rail options for a connecting track of the given type. */
  private railOpts(type: string): BuildOptions { return { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.me }; }

  /** New links only, excluding replacement pieces of existing track split by the operation (safe rollback). */
  private builtEdges<T>(commit: () => T): { result: T; edges: number[] } {
    const net = this.g.world.net, first = net.nextEdge, inherited = new Set<number>();
    const split = (old: NEdge, a: NEdge, b: NEdge) => {
      if (old.id < first || inherited.has(old.id)) { inherited.add(a.id); inherited.add(b.id); }
    };
    net.onSplit.push(split);
    try {
      const result = commit();
      const edges = [...net.edges.values()].filter((e) => e.id >= first && e.kind === 'rail' && e.owner === this.me && !inherited.has(e.id)).map((e) => e.id);
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
  private *linesTask(): Generator<void, void> {
    const g = this.g, me = this.me;
    if (!PAT.canonicalizeLines || !PAT.subsetOf) return;
    const todo = new Set<number>();
    for (const l of g.lines.map.values()) {
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

  private *decommissionTask(): Generator<void, void> {
    const g = this.g, me = this.me;
    const months = g.month;
    if (months >= 6) for (const l of [...g.lines.map.values()]) {
      if (l.owner !== me || !g.lines.map.has(l.id) || l.kind === 'tram' || l.stops.length < 2) continue;
      const f = this.fleet(l);
      // partners run it too: they keep it going (and pay their share)
      if (f.others || !f.ours.length) continue;
      if (this.lineAge(l) < 720 || this.cared('dec' + l.id)) continue;
      // cheap test first: the vehicles alone lose money both years
      const lastV = l.incomeLast - l.costLast, curV = ((l.incomeYear - l.costYear) * 12) / Math.max(1, months);
      if (lastV > 400_000 && curV > 400_000) continue;
      const infra = this.infraCost(l);
      yield;
      const last = lastV - infra, cur = curV - infra;
      if (!(last < 0 && cur < 0)) { this.careFor('dec' + l.id, 90); continue; }
      // a fix first: run through with a neighbouring line of ours (one through line instead of two)
      if (l.kind === 'rail' && this.joinNeighbour(l)) { yield; continue; }
      this.closeLine(l, `${Math.round(-last / 1000)}k lost last year, ${Math.round(-cur / 1000)}k a year now`);
      yield;
    }
    yield* this.retireUnused();
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
  private *retireUnused(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const due = (k: string, wait: number): boolean => {
      const d = this.retire.get(k);
      if (d === undefined) { this.retire.set(k, g.day + wait); return false; }
      return d <= g.day;
    };
    for (const st of [...g.stations.map.values()]) {
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
    for (const d of [...g.depots.map.values()]) {
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
    for (const e0 of [...net.edges.values()]) {
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
    const mode = railModeOf(r.trackType), cm = mode === 'mainline' ? 'rail' : mode;
    const shapes = (b: number) => (r.level ?? 'ground') === 'ground' ? railCatchShapes(r.x, r.z, r.angle, r.length, true, cm, b)
      : r.entrances.map((e) => ({ x: e.x, z: e.z, r: CATCHMENT_RADIUS[cm] * (1 + b), mode: cm, active: true }));
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
  private grow(st: Station, want: { tracks: number; through: number; length: number }, why: string): 'done' | 'busy' | 'no' {
    const g = this.g, r = st.rail!;
    const now0 = { tracks: r.tracks, through: r.through ?? 0, length: r.length };
    if (railModeOf(r.trackType) !== 'mainline') want = { ...now0, length: want.length };
    const same = (q: typeof now0) => q.tracks === now0.tracks && q.through === now0.through && q.length === now0.length;
    const steps = [want, { ...want, tracks: Math.min(want.tracks, now0.tracks + 1) }, { ...want, through: now0.through }, { ...now0, length: want.length }, { ...now0, tracks: want.tracks }]
      .filter((q, i, all) => !same(q) && all.findIndex((o) => o.tracks === q.tracks && o.through === q.through && o.length === q.length) === i);
    let graded = false;
    for (let i = 0; i < steps.length; i++) {
      const q = steps[i];
      let plan = planStationUpgrade(g, st.id, { ...q, side: 'auto' });
      // uneven ground beside the station: graded to the platform level once, then planned again (9i)
      if (!plan.ok && !graded && /uneven/i.test(plan.error ?? '')) { graded = true; if (this.grade(st)) { plan = planStationUpgrade(g, st.id, { ...q, side: 'auto' }); } }
      if (!plan.ok) continue;
      if (plan.plan && !this.demolitionOk(plan.plan.demolish)) continue;
      if (!this.canSpend(plan.cost * 1.2 + 300_000, 0.4)) return 'no';
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

  private *capacityTask(): Generator<void, void> {
    const g = this.g, me = this.me;
    const waits = platformWaits(g, 30);
    const stations = [...g.stations.map.values()].filter((s) => s.owner === me && s.rail);
    let grown = 0;
    for (const st of stations) {
      if (!g.stations.get(st.id)?.rail || this.cared('cap' + st.id)) continue;
      if (this.recentlyChanged(st, 90)) continue;
      const r = st.rail!, cap = g.stations.capacity(st.id);
      if (!cap) continue;
      const lines = this.linesAt(st.id);
      // ai.ts also grows its managed lines; the size cooldown prevents duplicate work here.
      const mainline = railModeOf(r.trackType) === 'mainline';
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
        const res = this.grow(st, want, why);
        if (res === 'done') grown++;
        this.careFor('cap' + st.id, res === 'busy' ? 7 : res === 'done' ? 90 : 360);
        yield;
        continue;
      }
      // a station building where its wider catchment pays for it (9m); halts stay halts
      if (!this.cared('sty' + st.id)) { this.restyle(st, cap.terminus); yield; }
    }
  }

  /** Upgrade a station's building when the catchment it adds pays for it within a few years (or take a useless one down at a quiet halt). */
  private restyle(st: Station, terminus: boolean) {
    const g = this.g, r = st.rail!;
    this.careFor('sty' + st.id, 360);
    const mode = railModeOf(r.trackType), T = g.towns.list[st.townId], pop = T?.pop ?? 0;
    const cur = styleOf(r.style).id;
    const avail = new Set(stylesFor(r.level ?? 'ground', r.tracks, g.year).map((s) => s.id));
    const cands: string[] = [];
    const base = defaultStationStyle(g.year, Math.max(2, r.tracks), r.level ?? 'ground', mode, Math.max(pop, 1500));
    if (base !== 'none' && base !== 'shelter') cands.push(base);
    if (terminus && r.tracks >= 4 && pop >= 5000) cands.push('terminal');
    if (pop >= 6000 && r.tracks >= 2) cands.push('concourse');
    cands.push('modern', 'classic');
    const years = 5 + 5 * this.ai.config.risk;
    let best: { style: string; gain: number; cost: number } | null = null;
    for (const s of [...new Set(cands)]) {
      if (s === cur || !avail.has(s) || (styleOf(s).catchBonus ?? 0) <= (styleOf(cur).catchBonus ?? 0)) continue;
      const plan = planStationUpgrade(g, st.id, { style: s });
      if (!plan.ok || (plan.plan && !this.demolitionOk(plan.plan.demolish))) continue;
      const gain = this.buildingValue(st, s) * years - plan.cost;
      if (gain > 0 && (!best || gain > best.gain)) best = { style: s, gain, cost: plan.cost };
    }
    if (!best || !this.canSpend(best.cost, 0.15)) return;
    const plan = planStationUpgrade(g, st.id, { style: best.style });
    if (!plan.ok) return;
    const dem = plan.plan ? [...plan.plan.demolish] : [];
    const err = commitStationUpgrade(g, plan);
    if (err) { if (err === 'busy') this.careFor('sty' + st.id, 10); return; }
    this.compensate(dem);
    this.bump('netRestyled');
    this.note(`${st.name}: ${styleOf(best.style).name.toLowerCase()} (its catchment pays for it)`);
    this.recentlyChanged(st, 0);
  }

  // ================================================================ pairing single tracks (9g)
  /** Plain own track through `e` (both ways through plain nodes): its edges. */
  private plainChain(e: NEdge, cap = 60): number[] {
    const g = this.g, net = g.world.net, out = [e.id];
    for (const start of [e.a, e.b]) {
      let at = start, cur: NEdge = e;
      for (let k = 0; k < cap; k++) {
        const n = net.nodes.get(at);
        if (!n || n.edges.length !== 2) break;
        const nx = net.edges.get(n.edges[0] === cur.id ? n.edges[1] : n.edges[0]);
        if (!nx || nx.kind !== 'rail' || nx.owner !== this.me || nx.station >= 0 || nx.depot >= 0 || out.includes(nx.id) || g.stations.throughStationOf(nx.id) >= 0) break;
        out.push(nx.id);
        at = nx.a === at ? nx.b : nx.a;
        cur = nx;
      }
    }
    return out;
  }

  /** Is any edge of B reachable from A's track within `reach` units of track (switches, crossovers, stations)? */
  private connectedNear(A: number[], B: number[], reach: number): boolean {
    const net = this.g.world.net, target = new Set(B), best = new Map<number, number>();
    const queue: { n: number; d: number }[] = [];
    for (const id of A) { const e = net.edges.get(id); if (e) for (const n of [e.a, e.b]) if (!best.has(n)) { best.set(n, 0); queue.push({ n, d: 0 }); } }
    const inA = new Set(A);
    for (let guard = 0; queue.length && guard < 20000; guard++) {
      queue.sort((p, q) => q.d - p.d);
      const { n, d } = queue.pop()!;
      if ((best.get(n) ?? Infinity) < d) continue;
      for (const id of net.nodes.get(n)?.edges ?? []) {
        if (target.has(id)) return true;
        if (inA.has(id)) continue;
        const e = net.edges.get(id);
        if (!e || e.kind !== 'rail') continue;
        const o = e.a === n ? e.b : e.a, nd = d + e.len;
        if (nd > reach || (best.get(o) ?? Infinity) <= nd) continue;
        best.set(o, nd);
        queue.push({ n: o, d: nd });
      }
    }
    return false;
  }

  /** Own plain single tracks running side by side (0.3-1.7 apart, parallel, 15+ units): edge pairs with the length. */
  private *sideBySide(): Generator<void, { a: number; b: number; len: number }[]> {
    const g = this.g, net = g.world.net;
    const C = 4, cells = new Map<number, number[]>(), key = (x: number, z: number) => Math.floor(x / C) * 65536 + Math.floor(z / C);
    const P: { e: number; x: number; z: number; tx: number; tz: number }[] = [];
    let work = 0;
    for (const e of net.edges.values()) {
      if (e.kind !== 'rail' || e.owner !== this.me || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) continue;
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
      if (!e || e.kind !== 'rail' || e.owner !== this.me || e.station >= 0 || e.depot >= 0) return -1;
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

  /** Lines (any company) whose route between consecutive stops runs over these edges (own lines' routes cached). */
  private linesOver(edges: Set<number>): number[] {
    const out: number[] = [];
    for (const l of this.g.lines.map.values()) {
      if (l.kind !== 'rail') continue;
      if (this.pairsOf(l).some(([a, b]) => (this.route(a, b, l.owner) ?? []).some((id) => edges.has(id)))) out.push(l.id);
    }
    return out;
  }

  /** Clear the signals on plain nodes between these edges (a pairing that left a line without a way: two-way again). */
  private clearSignals(edges: number[]) {
    const g = this.g, net = g.world.net, set = new Set(edges);
    for (const id of edges) {
      const e = net.edges.get(id);
      if (!e) continue;
      for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid);
        if (!n || !n.signal || n.edges.length !== 2 || !n.edges.every((x) => set.has(x))) continue;
        n.signal = 0;
        delete n.signalKind; delete n.signalPass;
        g.world.markObjArea(n.x - 2, n.z - 2, n.x + 2, n.z + 2);
      }
    }
    net.version++;
    g.onNetworkChanged();
  }

  private *pairTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.pairAsDoubleTrack) return;
    const cands = yield* this.sideBySide();
    yield;
    let done = 0;
    for (const c of cands.slice(0, 8)) {
      if (done >= 2) break;
      const ea = net.edges.get(c.a), eb = net.edges.get(c.b);
      if (!ea || !eb) continue;
      const key = `pair${Math.min(c.a, c.b)}:${Math.max(c.a, c.b)}`;
      if (this.cared(key)) continue;
      const A = this.plainChain(ea), B = this.plainChain(eb);
      if (A.some((id) => B.includes(id))) continue;
      // already one double track (crossovers / turnouts near): nothing to do
      if (this.connectedNear(A, B, c.len + 40)) { this.careFor(key, 720); continue; }
      yield;
      const busy = this.busyEdges();
      if ([...A, ...B].some((id) => busy.has(id))) { this.careFor(key, 20); continue; }
      const lines = this.linesOver(new Set([...A, ...B]));
      yield;
      if (!this.canSpend(150_000, 0.3)) return;
      const res = OPS.pairAsDoubleTrack(g, A, B, me);
      if (res.error && !res.signals && !res.crossovers) { this.careFor(key, 720); this.note(`could not pair two tracks: ${res.error}`); continue; }
      // every line over them still finds its way, else the tracks stay two-way
      if (!this.linesRoute(lines)) {
        this.clearSignals([...this.plainChain(net.edges.get(A[0]) ?? ea), ...this.plainChain(net.edges.get(B[0]) ?? eb)]);
        this.careFor(key, 1080);
        this.note('paired tracks left two-way (a line found no way)');
        continue;
      }
      for (const lid of lines) if (g.lines.get(lid)?.owner === me) this.signal(lid);
      this.careFor(key, 720);
      this.bump('paired');
      done++;
      this.note(`paired two single tracks into a double track (${Math.round(c.len)} u side by side, ${res.crossovers} crossovers, ${res.signals} signals)`);
      yield;
    }
  }

  // ================================================================ crossovers at the stations (9k)
  private *crossoversTask(): Generator<void, void> {
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
    for (const l of [...g.lines.map.values()]) {
      if (l.owner !== me || l.kind !== 'rail' || !g.lines.map.has(l.id)) continue;
      const E = new Set<number>();
      for (const [a, b] of this.pairsOf(l)) for (const r of [this.route(a, b), this.route(b, a)]) for (const id of r ?? []) { const e = net.edges.get(id); if (e && e.owner === me && e.station < 0) E.add(id); }
      yield;
      if (![...E].some((id) => near.has(id))) continue;
      for (const id of legs.keys()) E.add(id);
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
        && (e.owner === this.me || g.canUse(this.me, e.owner)));
      if (!a) continue;
      net.pointAt(a.edge, a.s, p, d);
      const b = net.nearestEdge(p.x, p.z, 1.8, 'rail', (e) => e.id !== a.edge.id && e.station < 0 && e.depot < 0
        && e.type === a.edge.type && (e.owner === this.me || g.canUse(this.me, e.owner)));
      if (!b || b.d < 0.25) continue;
      net.pointAt(b.edge, b.s, p, d);
      const dl = Math.hypot(d.x, d.z) || 1, dot = (d.x * tx + d.z * tz) / dl;
      if (Math.abs(dot) < 0.97) continue;
      const sb = b.s + (dot > 0 ? 8 : -8);
      if (sb < 1 || sb > b.edge.len - 1) continue;
      const plan = OPS.planConnection(g, a.edge.id, a.s, b.edge.id, sb, this.me, { search: 2 });
      if (!plan.ok || !this.eco.canAfford(plan.cost)) continue;
      if (!OPS.commitConnection(g, plan).error) return;
    }
  }

  private *connectTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const P = { x: 0, y: 0, z: 0 }, D = { x: 0, y: 0, z: 0 };
    let built = 0;
    for (const st of [...g.stations.map.values()]) {
      if (built >= 1) return;
      if (st.owner !== me || !st.rail || railModeOf(st.rail.trackType) !== 'mainline' || (st.rail.level ?? 'ground') !== 'ground') continue;
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
        for (const e of net.edgesNear(cx - 60, cz - 60, cx + 60, cz + 60)) {
          if (e.kind !== 'rail' || e.station >= 0 || e.depot >= 0 || mine.has(e.id) || g.stations.throughStationOf(e.id) >= 0) continue;
          if (e.owner !== me && !(g.canUse(me, e.owner) && g.accessPolicy(e.owner) === 'open')) continue;
          if (railModeOf(e.type) !== 'mainline') continue;
          for (let s = 2; s <= e.len - 2; s += 3) {
            net.pointAt(e, s, P, D);
            const dx = P.x - cx, dz = P.z - cz, d = Math.hypot(dx, dz);
            if (d < 14 || d > 60 || (dx * fx + dz * fz) / d < 0.55 || net.sectionAt(e, s) !== 'ground') continue;
            if (Math.abs(P.y - r.y) > 0.02 * d) continue;
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
          if (!S2?.rail || (S2.owner !== me && !g.canUse(me, S2.owner)) || railModeOf(S2.rail.trackType) !== 'mainline') continue;
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
        if (!prop.ok || !this.demolitionOk(prop.demolish)) { this.note(`no junction from ${st.name} towards ${g.stations.get(best.dest)?.name}: ${prop.errors[0] ?? 'buildings in the way'}`); continue; }
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
    const g = this.g, w = g.world, cm = mode === 'mainline' ? 'rail' : mode;
    const shapes = railCatchShapes(x, z, angle, length, true, cm, 0);
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
    if (pj.ok && pj.demolish.length <= 1 && this.canSpend(pj.cost, 0.1) && !commitProposal(g, pj)) g.stations.refreshAccess(true);
  }

  /**
   * Insert a through station into own track at (edge, s), trying a little either way along `steps` (edge, s)
   * where the plan fails (straight level track needed). Returns the new station id or -1 ('busy': -2).
   */
  private *insertAt(spots: { e: number; s: number }[], length: number, why: string, maxCost: number, opts: { tracks?: number; accept?: (p: OnTrackPlanLike) => boolean } = {}): Generator<void, number> {
    const g = this.g, me = this.me;
    if (!OPS.planStationOnTrack || !OPS.commitStationOnTrack) return -1;
    let firstErr = '';
    for (let i = 0; i < spots.length; i++) {
      const sp = spots[i];
      if (!g.world.net.edges.has(sp.e)) continue;
      const plan = OPS.planStationOnTrack(g, sp.e, sp.s, { length, tracks: opts.tracks, style: 'none' }, me);
      if (i % 3 === 2) yield;
      if (!plan.ok) { firstErr ||= plan.error ?? ''; continue; }
      if (opts.accept && !opts.accept(plan)) { firstErr ||= 'too far from the other station'; continue; }
      if (plan.cost > maxCost || !this.canSpend(plan.cost * 1.1, 0.3)) { this.note(`${why}: too expensive (${Math.round(plan.cost / 1000)}k)`); return -1; }
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
      if (!e || e.owner !== this.me || e.station >= 0 || e.depot >= 0 || e.len < 4 || g.stations.throughStationOf(e.id) >= 0) continue;
      for (let s = 2; s <= e.len - 2; s += step) {
        net.pointAt(e, s, q);
        const d = Math.hypot(q.x - x, q.z - z);
        if (d <= maxD) out.push({ e: e.id, s, d });
      }
    }
    return out.sort((a, b) => a.d - b.d);
  }

  private *insertTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planStationOnTrack) return;
    const q = { x: 0, y: 0, z: 0 }, dq = { x: 0, y: 0, z: 0 };
    const cover = new Map<string, Map<number, boolean>>();
    for (const l of [...g.lines.map.values()]) {
      if (l.owner !== me || l.kind !== 'rail' || this.cared('ins' + l.id) || !this.fleet(l).ours.length) continue;
      this.careFor('ins' + l.id, 180);
      const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s?.rail);
      if (sts.length < 2) continue;
      const mode = railModeOf(sts[0].rail!.trackType);
      let covered = cover.get(mode);
      if (!covered) cover.set(mode, covered = new Map());
      const existing = [...g.stations.map.values()].filter((s) => s.rail && railModeOf(s.rail.trackType) === mode)
        .flatMap((s) => g.stations.catchmentShapes(s, true));
      const spacing = MIN_SPACING[mode], R = CATCHMENT_RADIUS[mode === 'mainline' ? 'rail' : mode];
      const platform = this.platformFor(l);
      let best: { e: number; s: number; pop: number; x: number; z: number; a: number; b: number } | null = null;
      for (const [a, b] of this.pairsOf(l)) {
        const A = g.stations.get(a), B = g.stations.get(b);
        if (!A || !B || Math.hypot(A.x - B.x, A.z - B.z) < spacing * 2) continue;
        const r = this.route(a, b);
        yield;
        if (!r) continue;
        let k = 0;
        for (const id of r) {
          const e = net.edges.get(id);
          if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0 || e.len < 6 || g.stations.throughStationOf(e.id) >= 0) continue;
          for (let s = 3; s <= e.len - 3; s += 6) {
            net.pointAt(e, s, q, dq);
            // dense spacing rules: clear of every rail station of the mode (any line, any company)
            let near = false;
            for (const o of g.stations.footprintsNear(q.x, q.z, spacing)) if (o.rail && railModeOf(o.rail.trackType) === mode && Math.hypot(o.rail.x - q.x, o.rail.z - q.z) < spacing) { near = true; break; }
            if (near) continue;
            if (++k % 6 === 0) yield;
            // (open country: nothing to cover)
            if (!g.world.bgrid.query(q.x - R, q.z - R, q.x + R, q.z + R).length) continue;
            const pop = this.uncovered(q.x, q.z, Math.atan2(dq.x, dq.z), platform, mode, covered, existing);
            networkProfile.decisions['insert.maxPop'] = Math.max(networkProfile.decisions['insert.maxPop'] ?? 0, pop);
            if (pop >= INSERT_POP[mode] * networkOptions.insertPop && (!best || pop > best.pop)) best = { e: e.id, s, pop, x: q.x, z: q.z, a, b };
          }
        }
      }
      if (!best) continue;
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
        if (!st || [...g.stations.map.values()].some((o) => o.rail && railModeOf(o.rail.trackType) === mode && Math.hypot(o.x - st.x, o.z - st.z) < spacing)) return false;
        const pop = this.uncovered(st.x, st.z, st.angle, st.length, mode, covered!, existing);
        if (pop < INSERT_POP[mode] * networkOptions.insertPop || p.cost > Math.max(0, pop * value - upkeep) * 8) return false;
        servedPop = pop;
        return true;
      };
      const id = yield* this.insertAt(spots, platform, `no station site in ${town?.name ?? 'town'} on ${l.name}`, maxCost, { tracks: 2, accept });
      if (id === -2) { this.careFor('ins' + l.id, 15); continue; }
      if (id < 0) continue;
      const st = g.stations.get(id)!;
      this.roadAccess(st);
      const served = this.addToLines(id, before);
      this.bump('netInserted');
      this.note(`station ${st.name} on ${served.map((x) => x.name).join(', ') || l.name} (${servedPop} residents beyond the stations' reach)`);
      this.news(`opens ${st.name} station on ${l.name}: the town has grown along the line.`, st.x, st.z);
      return;
    }
  }

  // ================================================================ interchange stations (9l)
  /** Fit the trains actually using the line, rather than requiring its longest existing platforms. */
  private platformFor(l: Line): number {
    const st = this.g.stations.get(l.stops[0]);
    let length = defaultPlatformLength(st?.rail?.trackType);
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

  private *interchangeTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planStationOnTrack) return;
    const rail = [...g.lines.map.values()].filter((l) => l.kind === 'rail' && l.stops.length >= 2 && l.vehicles.length);
    const ours = rail.filter((l) => l.owner === me && this.fleet(l).ours.length);
    if (!ours.length) return;
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
      if (s1.some((a) => { const c = complexOf(a); return s2.some((b) => c.has(b)); })) continue;
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
      if (!meet) continue;
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

  // ================================================================ one station per town (9g consolidation)
  private *consolidateTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const mine = [...g.stations.map.values()].filter((s) => s.owner === me && s.rail && railModeOf(s.rail.trackType) === 'mainline' && (s.rail.level ?? 'ground') === 'ground' && s.townId >= 0);
    for (let i = 0; i < mine.length; i++) for (let j = 0; j < mine.length; j++) {
      const A = mine[i], B = mine[j];
      if (i === j || A.townId !== B.townId || !g.stations.get(A.id) || !g.stations.get(B.id)) continue;
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
    const appA = [...this.approachOf(A, 70)].map((id) => net.edges.get(id)!).filter((e) => e && (e.owner === me || g.canUse(me, e.owner)) && e.station < 0 && e.depot < 0 && e.len > 4 && !this.oneWayAround(e));
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
      if (pc.ok && (!pc.proposal || this.demolitionOk(pc.proposal.demolish))) { plan = pc; break; }
      reason ||= pc.error ?? 'buildings in the way';
      yield;
    }
    if (!plan) { this.note(`${B.name} and ${A.name}: no junction between their approaches${reason ? ' (' + reason + ')' : ''}`); return; }
    if (!this.canSpend(plan.cost * 1.3 + 300_000, 0.25)) return;
    const dem = [...(plan.proposal?.demolish ?? [])];
    const { result: res, edges: made } = this.builtEdges(() => OPS.commitConnection!(g, plan!));
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
  private *stopsTask(): Generator<void, void> {
    const g = this.g, me = this.me;
    const stopOnly = [...g.stations.map.values()].filter((s) => !s.rail && s.stops.length);
    const tram = (st: Station) => st.stops.some((p) => g.world.net.edges.get(p.edge)?.tram);
    let k = 0;
    for (const a of stopOnly) {
      if (a.owner !== me || !g.stations.get(a.id)) continue;
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
  private *tidyTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    const busy = this.busyEdges();
    let k = 0;
    // rail: dead ends of ours that lead nowhere (never one on a bridge)
    for (const n of [...net.nodes.values()]) {
      if (n.kind !== 'rail' || n.edges.length !== 1) continue;
      const e = net.edges.get(n.edges[0]);
      if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0 || g.stations.throughStationOf(e.id) >= 0) continue;
      if (++k % 10 === 0) yield;
      const onBridge = net.sectionAt(e, e.a === n.id ? 0 : e.len) === 'bridge';
      const len = this.takeUpStub(n.id, onBridge ? 400 : 120, busy);
      if (len) this.note(`took up ${Math.round(len)} u of dead-end track${onBridge ? ' ending on a bridge' : ''}`);
    }
    // roads of ours ending on a bridge: back to the last junction
    for (const n of [...net.nodes.values()]) {
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
  private *relevelTask(): Generator<void, void> {
    const g = this.g, net = g.world.net, me = this.me;
    if (!OPS.planRelevel || !OPS.commitRelevel) return;
    if (this.eco.yearTotals.length && this.eco.lastYearProfit < 0) return;
    for (const st of [...g.stations.map.values()]) {
      if (st.owner !== me || !st.rail || (st.rail.level ?? 'ground') !== 'ground' || railModeOf(st.rail.trackType) !== 'mainline' || this.cared('lift' + st.id)) continue;
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
      const edges = [...st.rail.edges, ...this.straightOut(st, 50)];
      const plan = OPS.planRelevel(g, edges, 'elevated', me);
      if (!plan.ok || !this.canSpend(plan.cost * 1.1, 0.25)) { if (!plan.ok) this.note(`${st.name} cannot be lifted: ${plan.error ?? ''}`); continue; }
      const err = errorOf(OPS.commitRelevel(g, plan));
      if (err) { if (err === 'busy') this.careFor('lift' + st.id, 20); continue; }
      for (const l of this.linesAt(st.id)) if (l.owner === me && l.kind === 'rail') this.signal(l.id);
      this.bump('netRelevelled');
      this.note(`lifted ${st.name} onto a viaduct (${crossings} level crossings${split ? ', the town on both sides' : ''})`);
      this.news(`lifts ${st.name} and its approaches onto a viaduct: the streets pass beneath.`, st.x, st.z);
      return;
    }
  }
}
