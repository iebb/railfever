// AI competitors: companies that plan and build bus networks, tram lines and intercity railways using the same
// construction API as the player (findSnap / planEdge / commitProposal, stations, depots, lines, vehicles).
// Each company has a configuration (activeness, focus, risk, track access policy and multiplier); it may run
// trains on other companies' railways under a track access agreement, and buy struggling rivals.
import type { Game, AccessPolicy } from './game';
import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import { planStationUpgrade, commitStationUpgrade, relocateStation } from './stations';
import { planDoubleTrack, commitDoubleTrack, DoublePlan } from './trackops';
import type { NEdge } from './network';
import type { Line } from './lines';
import { WATER_Y, TRACK_TYPES, KMH_TO_UPS, DAY_SECONDS } from './constants';
import { planEdge, commitProposal, findSnap, BuildOptions, Snap, Proposal } from './construction';
import { Train, depotReaches, findRailRoute, railNext } from './train';
import { RoadVehicle, roadDepotReaches } from './roadvehicle';
import { RNG } from './rng';
import { Economy } from './economy';
import { availableModels, VehicleModel, MODEL_BY_ID } from './vehicle-types';
import { fare } from './vehicle';
import { endTangent } from './geom';
import { TramPlanner } from './ai-tram';
import {
  OPoint, P2, ChainProfile, chainProfile, chainGen, routeConflictGen, routeGen, estimateChainCost, railPairGen, stationEnds,
  buildRailDepot, buildDepotOnLine, roadDepotGen, removeEdges, nodeSnap, nodeAt, depotAtEnd, depotFits, stationSiteGen, leadsMeet,
} from './routing';

export * from './routing';

export const AI_NAMES = [
  'Northern Star Rail', 'Blue Valley Transit', 'Crimson Express', 'Evergreen Lines', 'Violet Coast Railways',
  'Teal Harbour Transport', 'Rosewood Tramways', 'Silverline Metro', 'Golden Arrow Rail', 'Amber Hills Transit',
];

// ============================================================================ configuration

export interface AIConfig {
  /** 0.25 (passive) … 2 (aggressive): how often it starts projects, work per day, how far it borrows and expands */
  activeness: number;
  /** relative preference for railways, buses (and country roads) and trams; 0 = never */
  focus: { rail: number; road: number; tram: number };
  /** 0 … 1: loan appetite and the payback it accepts (0 cautious, 1 bold); bold companies also buy rivals */
  risk: number;
  /** cash at the start (the first 5M of it is borrowed) */
  startMoney: number;
  /** 0 … 3: weight of other companies' usage when they share the maintenance of this company's network (see Game) */
  accessMultiplier: number;
  /** answers to access requests: judge each (cautious companies refuse competitors), or always yes / no */
  accessPolicy: AccessPolicy;
}

/** AI companies share their tracks permissively by default: everyone may use them, at a 1x usage share. */
export const DEFAULT_AI_CONFIG: AIConfig = { activeness: 1, focus: { rail: 1, road: 1, tram: 1 }, risk: 0.5, startMoney: 5_000_000, accessMultiplier: 1, accessPolicy: 'auto-approve' };

/** Ready-made personalities for the new-game and company screens. */
export const AI_PRESETS: { id: string; name: string; hint: string; config: AIConfig }[] = [
  { id: 'balanced', name: 'Balanced', hint: 'Railways, buses and trams in equal measure', config: DEFAULT_AI_CONFIG },
  { id: 'cautious', name: 'Cautious', hint: 'Builds rarely, avoids debt', config: { activeness: 0.35, focus: { rail: 1, road: 1, tram: 1 }, risk: 0.15, startMoney: 4_000_000, accessMultiplier: 1, accessPolicy: 'auto-approve' } },
  { id: 'aggressive', name: 'Aggressive', hint: 'Expands fast on borrowed money, buys struggling rivals', config: { activeness: 1.6, focus: { rail: 1.2, road: 1, tram: 1 }, risk: 0.85, startMoney: 8_000_000, accessMultiplier: 1, accessPolicy: 'auto-approve' } },
  { id: 'rail', name: 'Rail baron', hint: 'Intercity railways first', config: { activeness: 1.1, focus: { rail: 3, road: 0.4, tram: 0.3 }, risk: 0.6, startMoney: 6_000_000, accessMultiplier: 1, accessPolicy: 'auto-approve' } },
  { id: 'bus', name: 'Bus operator', hint: 'Long-distance coaches and town buses', config: { activeness: 1, focus: { rail: 0.25, road: 3, tram: 0.6 }, risk: 0.4, startMoney: 4_000_000, accessMultiplier: 1, accessPolicy: 'auto-approve' } },
  { id: 'tram', name: 'Tram builder', hint: 'Tram lines in the big towns', config: { activeness: 1, focus: { rail: 0.4, road: 0.7, tram: 3 }, risk: 0.5, startMoney: 5_000_000, accessMultiplier: 1, accessPolicy: 'auto-approve' } },
];

const clamp = (x: number, a: number, b: number) => (Number.isFinite(x) ? Math.max(a, Math.min(b, x)) : a);

/** A complete, clamped configuration (missing fields from `base`). */
export function normalizeAIConfig(c?: Partial<AIConfig> | null, base: AIConfig = DEFAULT_AI_CONFIG): AIConfig {
  const f = { ...base.focus, ...(c?.focus ?? {}) };
  return {
    activeness: clamp(c?.activeness ?? base.activeness, 0.25, 2),
    focus: { rail: clamp(f.rail, 0, 5), road: clamp(f.road, 0, 5), tram: clamp(f.tram, 0, 5) },
    risk: clamp(c?.risk ?? base.risk, 0, 1),
    startMoney: clamp(c?.startMoney ?? base.startMoney, 0, 1e9),
    accessMultiplier: clamp(c?.accessMultiplier ?? base.accessMultiplier, 0, 3),
    accessPolicy: c?.accessPolicy === 'ask' || c?.accessPolicy === 'auto-approve' || c?.accessPolicy === 'auto-reject' ? c.accessPolicy : base.accessPolicy,
  };
}

// ============================================================================ vehicles

/** A long-distance coach for the year (the fastest value for money); a town bus when there are none. */
export function pickCoach(year: number): VehicleModel | null {
  const coaches = availableModels(year, 'bus').filter((m) => m.style === 'coach');
  const value = (m: VehicleModel) => (m.capacity * m.speed) / (m.cost + m.running * 8);
  return coaches.sort((a, b) => value(b) - value(a))[0] ?? pickBus(year);
}

/** Coaches that fit a platform behind a locomotive (1..5). */
export function coachesFitting(platform: number, loco: VehicleModel, wag: VehicleModel): number {
  return Math.max(1, Math.min(5, Math.floor((platform - 0.8 - loco.length) / (wag.length + 0.1))));
}

/** Coaches of a new AI train: short at opening (2, or 3 between big towns); trains grow when passengers pile up. */
export function openingCoaches(popA: number, popB: number): number { return Math.sqrt(Math.max(0, popA * popB)) >= 4500 ? 3 : 2; }

/**
 * Platform length (units) of a new AI railway's stations by demand: 8–10, 12 only for heavy demand (10 where the
 * trains of `year` need it for a locomotive and two coaches).
 */
export function aiPlatformLength(popA: number, popB: number, year?: number): number {
  const d = Math.sqrt(Math.max(0, popA * popB));
  const L = d < 1200 ? 8 : d < 4500 ? 10 : 12;
  // room for a locomotive and two coaches of the day at least
  if (L < 10 && year !== undefined && (pickTrain(year, L, 100, 2)?.length ?? 0) < 3) return 10;
  return L;
}

/**
 * Rail vehicles for the year: a cost-efficient locomotive (the fastest on long lines) and `coaches` coaches
 * (at most what the platform takes).
 */
export function pickTrain(year: number, platform: number, lineLen: number, coaches = 2): VehicleModel[] | null {
  const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon');
  if (!locos.length || !wagons.length) return null;
  const value = (m: VehicleModel) => (Math.min(m.speed, lineLen > 220 ? 300 : 150) * (0.5 + m.power / 5000)) / (m.cost + m.running * 8);
  const loco = [...locos].sort((a, b) => value(b) - value(a))[0];
  const fit = wagons.filter((w) => w.speed >= Math.min(loco.speed, 150));
  const wag = (fit.length ? fit : wagons).sort((a, b) => b.capacity - a.capacity)[0];
  const n = Math.max(1, Math.min(coachesFitting(platform, loco, wag), coaches));
  return [loco, ...Array<VehicleModel>(n).fill(wag)];
}

export function pickBus(year: number, townPop = 3000): VehicleModel | null {
  const buses = availableModels(year, 'bus').filter((m) => m.style !== 'coach');
  // small towns: smaller buses
  const value = (m: VehicleModel) => (Math.min(m.capacity, townPop / 40) * Math.min(m.speed, 60)) / (m.cost + m.running * 8);
  return buses.sort((a, b) => value(b) - value(a))[0] ?? null;
}

export interface AIStats {
  railStations: number; busStops: number; track: number; road: number; bridges: number; tunnels: number;
  lines: number; vehicles: number; failed: number; spent: number; sold: number;
  /** tram lines opened, railways run under track access, companies bought */
  trams: number; shared: number; acquired: number;
  /** railways started from one of our stations (network extensions), lines upgraded to double track, block signals */
  reused: number; doubled: number; signals: number;
  /** passing loops laid on the open line (lines that could only be doubled in parts) */
  loops: number;
  /** walking transfers set up between a new station or stop and stations nearby (transfer complexes) */
  transfers: number;
  /** long-distance coach lines opened */
  coaches: number;
  /** track units: laid as a second track (upgrades), and of other companies' railways our trains run on */
  trackDouble: number; trackShared: number;
}

type ProjectKind = 'rail' | 'bus' | 'road' | 'tram' | 'share' | 'coach' | 'double';

interface Project {
  kind: ProjectKind;
  towns: number[];
  stations: number[];
  edges: number[];
  depots: number[];
  line: number;
  started: number;
  /** share: the network owner whose access agreement this project signed (-1: none) */
  access?: number;
  /** construction started (a failure then cost money; failed plans are retried sooner) */
  built?: boolean;
}

interface LineInfo {
  /** bus: town buses or long-distance coaches (two towns) */
  kind: 'rail' | 'bus' | 'tram'; towns: number[]; depot: number; maxVehicles: number; opened: number; lastSold?: number;
  /** trains run on this company's network under a track access agreement */
  shared?: number;
  /** rail: upgraded to double track with block signals; day of the last failed upgrade */
  double?: boolean; upgradeFailed?: number;
  /** rail: passing loops laid on the open line (where the whole track could not be doubled) */
  loops?: number;
}

export interface AIState {
  phase: string;
  cooldown: number;
  projects: number;
  rng?: number;
  failed?: [string, number][];
  stats?: AIStats;
  lines?: [number, LineInfo][];
  project?: Project | null;
  /** day of the last company acquisition */
  lastAcq?: number;
}

/** Optional members of the tram planner used here (see ai-tram.ts). */
interface TramPlannerExt {
  project?: { town: number; line: number; depot: number } | null;
  status?: string;
  reason?: string;
  candidates?(): Town[];
  record?(): unknown;
}
const tramExt = (t: TramPlanner) => t as unknown as TramPlannerExt;

const LEAD = 20;
/** Smallest town that gets an AI bus network. */
const BUS_MIN_POP = 1500;

/**
 * An AI company. Plans one project at a time (a bus network or a tram line in a large town, an intercity
 * railway, trains on another company's railway, or a country road) as an incremental job; `daily()` runs a
 * number of work units (each well under a few milliseconds), `monthly()` manages loans, vehicles, track access
 * and acquisitions. Uses only the public construction API. `config` may be changed at any time.
 */
export class AIController {
  state: AIState = { phase: 'idle', cooldown: 10, projects: 0 };
  stats: AIStats = {
    railStations: 0, busStops: 0, track: 0, road: 0, bridges: 0, tunnels: 0, lines: 0, vehicles: 0, failed: 0, spent: 0, sold: 0, trams: 0, shared: 0, acquired: 0,
    reused: 0, doubled: 0, signals: 0, loops: 0, transfers: 0, trackDouble: 0, trackShared: 0, coaches: 0,
  };
  private cfg: AIConfig;
  /** the company's settings (assigning normalizes: missing fields from the defaults, values clamped) */
  get config(): AIConfig { return this.cfg; }
  set config(c: AIConfig) { this.cfg = normalizeAIConfig(c); }
  /** debugging: note work units slower than slowMs */
  static profile = false;
  static slowMs = 8;
  /** railways between towns with sqrt(popA * popB) at least this get their second track when they open */
  static trunkPop = 4500;
  log: string[] = [];
  /** the company was bought: the controller does nothing any more */
  disposed = false;
  private rng: RNG;
  private failed = new Map<string, number>();
  private lines = new Map<number, LineInfo>();
  private project: Project | null = null;
  private job: Generator<void, void> | null = null;
  private errorLogged = false;
  private tram: TramPlanner | null = null;
  private lastAcq = -1e9;
  /** trains to replace by longer ones: [train, depot, car model ids] */
  private relengthen: [number, number, string[]][] = [];
  private readonly splitListener = (old: NEdge, e1: NEdge, e2: NEdge) => {
    const p = this.project;
    if (!p) return;
    const i = p.edges.indexOf(old.id);
    if (i >= 0) p.edges.splice(i, 1, e1.id, e2.id);
  };

  constructor(public game: Game, public companyId: number, config?: Partial<AIConfig>) {
    this.cfg = normalizeAIConfig(config);
    this.rng = new RNG((game.options.seed * 977 + companyId * 7919) >>> 0);
    this.state.cooldown = Math.round((12 + companyId * 9) / this.config.activeness);
    game.world.net.onSplit.push(this.splitListener);
  }

  private get eco(): Economy { return this.game.company(this.companyId).economy; }
  private get name() { return this.game.company(this.companyId).name; }

  /** Work units per game day (more for active companies). */
  get budget(): number { return Math.max(3, Math.min(16, Math.round(8 * Math.pow(this.config.activeness, 0.6)))); }

  /** Share of the credit line the company is willing to use. */
  get loanAppetite(): number { const c = this.config; return clamp(0.35 + 0.5 * c.risk + 0.12 * (c.activeness - 1), 0.15, 0.95); }

  /** Money that can be committed: cash plus unused credit (within the appetite), minus a safety reserve. */
  available(): number {
    const e = this.eco;
    return e.money + Math.max(0, e.maxLoan * this.loanAppetite - e.loan) - 1_000_000 - this.game.maintenanceOf(this.companyId) * 0.5;
  }

  /** What the company is doing (for the UI). */
  get phase(): string { return this.disposed ? 'bought' : this.state.phase; }

  private tramPlanner(): TramPlanner {
    if (!this.tram) {
      const tp = new TramPlanner(this.game, this.companyId);
      // the planner picks its town from our candidates (failures remembered in our saved state, so a loaded game
      // chooses alike)
      (tp as unknown as { candidates: () => Town[] }).candidates = () => this.tramCandidates();
      this.tram = tp;
    }
    return this.tram;
  }

  /** Towns for a tram line: big enough, no tram line of ours yet, not failed recently (biggest first). */
  private tramCandidates(): Town[] {
    const g = this.game, served = new Set<number>();
    for (const l of g.lines.map.values()) {
      if (l.owner !== this.companyId || l.kind !== 'tram') continue;
      for (const s of l.stops) { const st = g.stations.get(s); if (st && st.townId >= 0) served.add(st.townId); }
    }
    return g.towns.list.filter((t) => t.pop >= TramPlanner.minPop && !served.has(t.id) && !this.isFailed('tram' + t.id))
      .sort((a, b) => b.pop - a.pop || a.id - b.id);
  }

  /** Is there room for a rail depot behind a planned station (stub or switch for multi-track)? */
  private depotSiteFor(plan: StationPlan, toward: P2, tracks: number): boolean {
    const g = this.game;
    const ax = Math.sin(plan.angle), az = Math.cos(plan.angle);
    const sgn = ax * (toward.x - plan.x) + az * (toward.z - plan.z) > 0 ? -1 : 1;
    const bx = ax * sgn, bz = az * sgn;
    const back = { x: plan.x + bx * plan.length / 2, z: plan.z + bz * plan.length / 2 };
    const lens = tracks > 1 ? [18, 22, 26] : [5, 8, 11, 15, 20];
    for (const L of lens) {
      const x = back.x + bx * L, z = back.z + bz * L;
      // single track can fall back to a siding off the line, so only the double-track stub needs level ground
      if (g.world.inside(x, z, 8) && depotFits(g, x, z, -bx, -bz, this.companyId, 30, tracks > 1 ? plan.y : undefined)) return true;
    }
    return false;
  }

  private note(s: string) {
    this.log.push(`${this.game.dateString()}: ${s}`);
    if (this.log.length > 40) this.log.shift();
  }

  private onError(e: unknown) {
    if (!this.errorLogged) { this.errorLogged = true; console.warn(`AI ${this.name}:`, e); }
    this.note('error: ' + String((e as Error)?.message ?? e));
    try { if (this.project) this.abandon(this.project); } catch { /* ignore */ }
    this.project = null;
    this.job = null;
    this.state.phase = 'idle';
    this.state.cooldown = 30;
  }

  /** Keep a config edited from outside (UI) within range. */
  private checkConfig() {
    const c = this.config;
    const ok = (x: unknown, a: number, b: number) => typeof x === 'number' && x >= a && x <= b;
    if (!c || !ok(c.activeness, 0.25, 2) || !ok(c.risk, 0, 1) || !c.focus || !ok(c.focus.rail, 0, 5) || !ok(c.focus.road, 0, 5) || !ok(c.focus.tram, 0, 5) || !ok(c.startMoney, 0, 1e9) || !ok(c.accessMultiplier, 0, 3) || !['ask', 'auto-approve', 'auto-reject'].includes(c.accessPolicy)) {
      this.config = c; // the setter normalizes (a field changed in place)
    }
  }

  /** Called once per game day while AI is enabled. */
  daily() {
    if (this.disposed) return;
    this.checkConfig();
    try {
      if (this.relengthen.length) this.replaceTrains();
      // a project's work units run spread over the day (see work)
      if (this.job) return;
      if (this.state.cooldown > 0) { this.state.cooldown--; return; }
      this.chooseProject();
    } catch (e) { this.onError(e); }
  }

  /**
   * The current project's work units, `budget` per game day spread evenly over the day (each company at its
   * own phase), so planning never stalls a frame: called every simulation tick with the day fraction before
   * and after the tick (after + whole days passed).
   */
  work(f0: number, f1: number) {
    if (this.disposed || !this.job) return;
    const n = this.budget, ph = (this.companyId * 0.37) % 1;
    let units = Math.floor(f1 * n + ph) - Math.floor(f0 * n + ph);
    try {
      for (; units > 0 && this.job; units--) {
        const t0 = AIController.profile ? performance.now() : 0;
        if (this.job.next().done) this.job = null;
        if (AIController.profile) { const dt = performance.now() - t0; if (dt > AIController.slowMs) this.note(`slow step ${dt.toFixed(1)} ms in "${this.state.phase}"`); }
      }
      if (!this.job) this.endProject();
    } catch (e) { this.onError(e); }
  }

  /** Called once per game month while AI is enabled. */
  monthly() {
    if (this.disposed) return;
    this.checkConfig();
    try { this.manage(); } catch (e) { this.onError(e); }
  }

  /** The company was bought: stop and remove a half-built project. */
  dispose() {
    if (this.disposed) return;
    try { if (this.project) this.abandon(this.project); } catch { /* ignore */ }
    this.project = null;
    this.job = null;
    this.disposed = true;
    this.state.phase = 'bought';
    const ls = this.game.world.net.onSplit, i = ls.indexOf(this.splitListener);
    if (i >= 0) ls.splice(i, 1);
  }

  /** Debug/test hook: start a specific project now (returns false if busy); rail from our station `hub` in towns[0]. */
  startProject(kind: 'rail' | 'bus' | 'road' | 'tram' | 'coach', towns: number[], hub = -1): boolean {
    if (this.job || this.disposed) return false;
    const g = this.game, T = towns.map((id) => g.towns.list[id]);
    if (kind === 'tram') return this.startTram();
    this.project = { kind, towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = kind === 'rail' ? this.railJob(T[0], T[1], hub) : kind === 'bus' ? this.busJob(T[0]) : kind === 'coach' ? this.coachJob(T[0], T[1]) : this.roadJob(T[0], T[1]);
    this.state.projects++;
    return true;
  }

  /** Debug/test hook: run trains on `owner`'s railway between its stations a and b (track access). */
  startShare(owner: number, a: number, b: number): boolean {
    if (this.job || this.disposed) return false;
    this.project = { kind: 'share', towns: [], stations: [], edges: [], depots: [], line: -1, started: this.game.day };
    this.job = this.shareJob(owner, a, b);
    this.state.projects++;
    return true;
  }

  /**
   * Debug/test hook: lay the second track of one of our single-track railway lines now (all of it, or passing
   * loops where that is not possible); true if anything was built.
   */
  upgradeLine(lineId: number): boolean {
    const l = this.game.lines.get(lineId), info = this.lines.get(lineId);
    if (!l || !info || info.kind !== 'rail' || info.double || info.loops || info.shared) return false;
    const job = this.doubleGen(l, info);
    while (!job.next().done) { /* run to the end */ }
    return !!info.double || !!info.loops;
  }

  /** Is a project in progress? */
  get busy() { return !!this.job; }

  /** Lines this controller runs (for the UI / tests). */
  managedLines(): number[] { return [...this.lines.keys()]; }

  // ---------------------------------------------------------------- choosing projects
  private pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
  private isFailed(key: string) { const d = this.failed.get(key); return d !== undefined && d > this.game.day; }
  private markFailed(key: string, days: number) { this.failed.set(key, this.game.day + days); this.stats.failed++; }

  /** Recent railway failures per town (from the failed town pairs). */
  private railTownFailures(): Map<number, number> {
    const m = new Map<number, number>();
    for (const [k, d] of this.failed) {
      if (d <= this.game.day) continue;
      const r = /^(\d+)-(\d+)$/.exec(k);
      if (!r) continue;
      for (const t of [Number(r[1]), Number(r[2])]) m.set(t, (m.get(t) ?? 0) + 1);
    }
    return m;
  }

  /** Trips per month between towns (both ways) and within a town, from the regional demand model. */
  private townDemand(): { pair: (a: number, b: number) => number; local: (t: number) => number } {
    const g = this.game, m = g.demand, R = m.regions, n = R.length, nt = g.towns.list.length;
    if (!n) m.rebuild();
    const P = new Float64Array(nt * nt);
    for (let r = 0; r < R.length; r++) {
      const a = R[r].town;
      if (a < 0 || a >= nt) continue;
      for (let q = 0; q < R.length; q++) {
        const b = R[q].town;
        if (q === r || b < 0 || b >= nt) continue;
        const t = R[r].produced * m.od[r * R.length + q];
        P[a * nt + b] += t;
        if (a !== b) P[b * nt + a] += t;
      }
    }
    return { pair: (a, b) => P[a * nt + b], local: (t) => P[t * nt + t] };
  }

  /** Bus and tram lines (of all companies) running within a town (coaches to other towns do not count). */
  private localLines(T: Town): number {
    const g = this.game;
    let n = 0;
    for (const l of g.lines.map.values()) {
      if (l.kind === 'rail' || l.stops.length < 2) continue;
      if (l.stops.every((s) => g.stations.get(s)?.townId === T.id)) n++;
    }
    return n;
  }

  /** May one more bus or tram line open in this town? Few early on; more as the town grows and the years pass. */
  private localRoom(T: Town): boolean {
    return this.localLines(T) < 1 + Math.floor(T.pop / 3000) + Math.floor(this.game.day / 1080);
  }

  /** Lines (rail and coach, every company) per town pair (pairKey). */
  private servedPairs(): Map<string, number> {
    const g = this.game, out = new Map<string, number>();
    for (const l of g.lines.map.values()) {
      if (l.kind === 'tram' || l.stops.length < 2) continue;
      const towns = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) { const k = this.pairKey(towns[i], towns[j]); out.set(k, (out.get(k) ?? 0) + 1); }
    }
    return out;
  }

  /** Town pairs (pairKey) connected by other companies' railways. */
  private rivalRailPairs(): Set<string> {
    const g = this.game, out = new Set<string>();
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.owner === this.companyId || l.stops.length < 2) continue;
      const towns = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      for (let i = 0; i < towns.length; i++) for (let j = i + 1; j < towns.length; j++) out.add(this.pairKey(towns[i], towns[j]));
    }
    return out;
  }

  private chooseProject() {
    const g = this.game, c = this.config, act = c.activeness, focus = c.focus;
    const avail = this.available();
    const own = [...this.lines.values()];
    const railLines = own.filter((l) => l.kind === 'rail').length, busLines = own.filter((l) => l.kind === 'bus').length, tramLines = own.filter((l) => l.kind === 'tram').length;
    // don't overbuild: keep the debt serviceable
    const yearNet = this.eco.yearTotals.length ? this.eco.lastYearProfit : 0;
    if (this.eco.loan > this.eco.maxLoan * Math.min(0.97, this.loanAppetite + 0.2) || (own.length >= 3 && yearNet < -1_500_000 * (0.5 + c.risk))) {
      this.state.phase = 'consolidating'; this.state.cooldown = Math.round(90 / Math.sqrt(act)); return;
    }
    // every option is scored by its expected return: yearly revenue from the regional OD demand at distance-based
    // fares, minus running costs and upkeep, over the outlay (focus and network effects on top)
    const opts: { score: number; kind: ProjectKind; towns: number[]; share?: [number, number, number]; hub?: number }[] = [];
    const D = this.townDemand();
    const fareAt = (d: number, kmh: number) => fare(d, d / (kmh * KMH_TO_UPS * DAY_SECONDS * 0.5), 1);
    // return on the outlay, compressed (sqrt) so that cheap projects do not crowd out everything else, plus a
    // little for doing what the company likes; focus weights count squared (personalities differ clearly);
    // existing lines on the same towns share the demand
    const roi = (revenue: number, yearly: number, outlay: number) => Math.sqrt(Math.max(0, (revenue - yearly) / Math.max(1, outlay))) + 0.15;
    const fw = (f: number) => f * f;
    const served = this.servedPairs();
    const share = (a: number, b: number) => 1 / (1 + (served.get(this.pairKey(a, b)) ?? 0));
    // intercity railways: preferably extending our network from a station we have (hubs and branches)
    if (focus.rail > 0 && avail > 3_000_000) {
      const townFails = this.railTownFailures();
      const rivals = this.rivalRailPairs();
      const T = g.towns.list;
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
        const A = T[i], B = T[j];
        if (A.pop < 250 || B.pop < 250 || Math.abs(A.x - B.x) > 250 || Math.abs(A.z - B.z) > 250) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 60 || d > 250) continue;
        if (this.isFailed(this.pairKey(A.id, B.id)) || own.some((l) => l.kind === 'rail' && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        const trips = D.pair(A.id, B.id);
        // no copy of a rival's railway between the same towns unless demand is large (trains on it under track access are cheaper)
        if (rivals.has(this.pairKey(A.id, B.id)) && trips < 250) continue;
        const hubA = this.hubFor(A, B), hubB = hubA ? null : this.hubFor(B, A);
        const hub = hubA ?? hubB;
        const len = d * 1.3, L = aiPlatformLength(A.pop, B.pop, g.year);
        const outlay = len * 13_000 + (hub ? 1 : 2) * (2 * L * 9000 + 120_000) + 1_400_000;
        // two trains of up to ~200 seats, a trip a month or so each way
        const carried = Math.min(trips * 0.5 * 12 * share(A.id, B.id), 2 * 200 * 2 * (360 / (len / 4 + 10)));
        let score = roi(carried * fareAt(d, 120), 180_000 + len * 330 + 60_000, outlay);
        // towns where railways keep failing (no station site in a dense centre, crowded corridors): try others
        score *= Math.pow(0.6, (townFails.get(A.id) ?? 0) + (townFails.get(B.id) ?? 0));
        if (rivals.has(this.pairKey(A.id, B.id))) score *= 0.4;
        if (hub) score *= 1.3; // the new line also feeds our network
        opts.push({ score: score * (railLines === 0 ? 1.3 : 1) * fw(focus.rail), kind: 'rail', towns: hubB ? [B.id, A.id] : [A.id, B.id], hub: hub?.id });
      }
    }
    // trains on another company's railway (track access): much cheaper than building
    if (focus.rail > 0 && avail > 1_800_000) this.shareOptions(opts, own, D);
    // long-distance coaches over the country roads between towns
    if (focus.road > 0 && avail > 900_000 && pickCoach(g.year)) {
      const T = g.towns.list;
      for (let i = 0; i < T.length; i++) for (let j = i + 1; j < T.length; j++) {
        const A = T[i], B = T[j];
        if (A.pop < 300 || B.pop < 300 || Math.abs(A.x - B.x) > 220 || Math.abs(A.z - B.z) > 220) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 50 || d > 220 || this.isFailed('coach' + this.pairKey(A.id, B.id))) continue;
        if (own.some((l) => l.kind !== 'tram' && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        // no third service between the same towns unless demand is large
        const trips = D.pair(A.id, B.id);
        if ((served.get(this.pairKey(A.id, B.id)) ?? 0) >= (trips > 300 ? 3 : 2)) continue;
        // two coaches of ~45 seats
        const carried = Math.min(D.pair(A.id, B.id) * 0.25 * 12 * share(A.id, B.id), 2 * 45 * 2 * (360 / (d * 1.3 / 2.5 + 6)));
        const score = roi(carried * fareAt(d, 90), 2 * 32_000 + 12_000, 700_000);
        opts.push({ score: score * fw(focus.road), kind: 'coach', towns: [A.id, B.id] });
      }
    }
    // town buses in larger towns (between their districts), few lines per town
    if (focus.road > 0 && avail > 900_000) {
      for (const T of g.towns.list) {
        if (T.pop < BUS_MIN_POP || this.isFailed('bus' + T.id) || own.some((l) => l.kind === 'bus' && l.towns.length === 1 && l.towns.includes(T.id)) || !this.localRoom(T)) continue;
        const score = roi(D.local(T.id) * 0.3 * 12 * fareAt(22, 45), 3 * 22_000 + 15_000, 650_000);
        opts.push({ score: score * (busLines === 0 ? 1.15 : 1) * fw(focus.road), kind: 'bus', towns: [T.id] });
      }
    }
    // tram lines in big towns (ai-tram.ts)
    if (focus.tram > 0 && avail > 1_500_000 && !this.isFailed('tram')) {
      const tp = this.tramPlanner();
      if (tp.available()) {
        const town = tramExt(tp).candidates?.()[0];
        if (town && this.localRoom(town)) {
          const score = roi(D.local(town.id) * 0.45 * 12 * fareAt(25, 40), 3 * 30_000 + 60_000, 2_200_000);
          opts.push({ score: score * (tramLines === 0 ? 1.15 : 1) * fw(focus.tram), kind: 'tram', towns: [town.id] });
        }
      }
    }
    // occasionally a country road between neighbouring towns (for coaches)
    if (focus.road > 0 && avail > 2_000_000 && this.rng.chance(Math.min(0.5, 0.15 * act))) {
      for (const A of g.towns.list) for (const B of g.towns.list) {
        if (A.id >= B.id || this.isFailed('road' + this.pairKey(A.id, B.id))) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 50 || d > 130) continue;
        opts.push({ score: 0.6 * roi(D.pair(A.id, B.id) * 0.2 * 12 * fareAt(d, 90), 80_000, 1_200_000 + d * 4000) * fw(focus.road), kind: 'road', towns: [A.id, B.id] });
      }
    }
    // a company with a clear favourite saves up for it rather than spending on kinds it barely cares for (unless
    // it has opened nothing for a year)
    const wOf = (k: ProjectKind) => fw(k === 'rail' || k === 'share' ? focus.rail : k === 'tram' ? focus.tram : focus.road);
    const wMax = Math.max(fw(focus.rail), fw(focus.road), fw(focus.tram));
    const lastOpened = own.reduce((a, l) => Math.max(a, l.opened), 0);
    const restless = g.day - lastOpened > 360;
    for (let i = opts.length - 1; i >= 0; i--) if (!(opts[i].score > 0) || (!restless && wOf(opts[i].kind) < 0.1 * wMax)) opts.splice(i, 1);
    if (!opts.length) { this.state.phase = 'idle'; this.state.cooldown = Math.round(60 / act); return; }
    // one of the best few, the better ones (squared score) much more likely
    opts.sort((a, b) => b.score - a.score);
    const top = opts.slice(0, 4);
    let r = this.rng.next() * top.reduce((a, o) => a + o.score * o.score, 0), pick = top[0];
    for (const o of top) { r -= o.score * o.score; if (r <= 0) { pick = o; break; } }
    if (pick.kind === 'tram') {
      if (!this.startTram()) { this.markFailed('tram', 120); this.state.cooldown = 20; }
      return;
    }
    const towns = pick.towns.map((id) => g.towns.list[id]);
    this.project = { kind: pick.kind, towns: pick.towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    // a railway starts at the hub, else at the bigger town
    const railEnds = pick.kind !== 'rail' || pick.hub !== undefined || towns[0].pop >= towns[1].pop ? towns : [towns[1], towns[0]];
    this.job = pick.kind === 'rail' ? this.railJob(railEnds[0], railEnds[1], pick.hub ?? -1)
      : pick.kind === 'share' ? this.shareJob(pick.share![0], pick.share![1], pick.share![2])
      : pick.kind === 'coach' ? this.coachJob(towns[0], towns[1])
      : pick.kind === 'bus' ? this.busJob(towns[0]) : this.roadJob(towns[0], towns[1]);
    this.state.projects++;
  }

  private endProject() {
    const p = this.project;
    this.project = null;
    this.state.phase = 'idle';
    const act = this.config.activeness;
    this.state.cooldown = p && p.line >= 0 ? Math.round((60 + this.rng.int(70)) / act)
      : p && !p.built ? Math.round((4 + this.rng.int(8)) / Math.sqrt(act)) : Math.round((20 + this.rng.int(20)) / Math.sqrt(act));
  }

  /** Remove what an unfinished project built. */
  private abandon(p: Project) {
    const g = this.game;
    if (p.kind === 'tram') { this.tram?.cleanup(); return; }
    if (p.line >= 0) {
      const l = g.lines.get(p.line);
      if (l) { for (const vid of [...l.vehicles]) g.vehicles.sell(vid); g.lines.delete(l.id); }
      this.lines.delete(p.line);
    }
    for (const d of p.depots) g.depots.remove(d);
    removeEdges(g, p.edges, this.companyId);
    for (const s of p.stations) { const st = g.stations.get(s); if (st && st.owner === this.companyId) g.stations.removeStation(s); }
    p.edges = []; p.stations = []; p.depots = [];
    if (p.access !== undefined && p.access >= 0) { g.cancelAccessRequest(this.companyId, p.access); this.endUnusedAccess(p.access); p.access = -1; }
  }

  /** Record edges created since `fromId` (owned by this company) in the current project. */
  private track(fromId: number) {
    const p = this.project, net = this.game.world.net;
    if (!p) return;
    for (let id = fromId; id < net.nextEdge; id++) {
      const e = net.edges.get(id);
      if (e && e.owner === this.companyId && !p.edges.includes(id)) p.edges.push(id);
    }
  }

  private borrowFor(amount: number) {
    const e = this.eco;
    while (e.money < amount + 300_000 && e.borrow()) { /* borrow in steps */ }
    return e.money >= amount;
  }

  // ---------------------------------------------------------------- rail
  /**
   * Our rail station in town T whose platform ends towards `toward` are all free (a hub a new line can start from),
   * with its axis pointing roughly that way.
   */
  hubFor(T: Town, toward: P2): Station | null {
    const g = this.game, net = g.world.net;
    for (const st of g.stations.map.values()) {
      if (st.owner !== this.companyId || st.townId !== T.id || !st.rail) continue;
      const r = st.rail, ax = Math.sin(r.angle), az = Math.cos(r.angle);
      const dx = toward.x - st.x, dz = toward.z - st.z, dl = Math.hypot(dx, dz) || 1;
      const along = (ax * dx + az * dz) / dl;
      if (Math.abs(along) < 0.55) continue; // the line would have to turn too sharply
      const ends = stationEnds(g, st).map((e) => (along > 0 ? e.front : e.back));
      if (ends.length && ends.every((id) => net.nodes.get(id)?.edges.length === 1)) return st;
    }
    return null;
  }

  /**
   * A railway between towns A and B: stations with a passing loop (two platform tracks; or our existing station
   * `hubId` in A, extending our network from there), a single-track main line (upgraded to double track when
   * traffic grows, see manage), a depot on a siding (station ends stay free for extensions), and a line with
   * short trains. A line ending at the hub is extended to B (through trains) instead of a new line.
   */
  private *railJob(A: Town, B: Town, hubId = -1): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = this.pairKey(A.id, B.id);
    const hub = hubId >= 0 ? g.stations.get(hubId) ?? null : null;
    this.state.phase = hub ? `planning a railway ${hub.name} - ${B.name}` : `planning railway ${A.name} - ${B.name}`;
    const fail = (why: string, days = 900) => { this.note(`railway ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    const PLATFORM = aiPlatformLength(A.pop, B.pop, g.year), ST = 2, tracks = 1;
    const grade = TRACK_TYPES.standard.maxGrade * 0.8;
    let pr: { a: StationPlan; b: StationPlan } | null = null;
    if (hub && hub.rail) {
      const r = hub.rail;
      const pa = { ok: true, x: r.x, z: r.z, y: r.y, angle: r.angle, length: r.length, tracks: r.tracks, cost: 0 } as StationPlan;
      const pb = yield* stationSiteGen(g, B, pa, { tracks: ST, length: PLATFORM, owner, front: LEAD + 2, back: 22, accept: (q) => leadsMeet(pa, q, LEAD), quick: true });
      if (pb && Math.abs(pa.y - pb.y) <= grade * Math.hypot(pa.x - pb.x, pa.z - pb.z) * 1.15) pr = { a: pa, b: pb };
    } else pr = yield* railPairGen(g, A, B, { tracks: ST, length: PLATFORM, owner, front: LEAD + 2, back: 22, quick: true });
    if (!pr) return fail('no station sites');
    const planning = this.state.phase;
    this.state.phase = `${planning}: route`;
    const lenA = hub ? hub.rail!.length : PLATFORM;
    // the A end faces B: a new station's front, or the hub's free end
    const sa = hub ? (Math.sin(pr.a.angle) * (pr.b.x - pr.a.x) + Math.cos(pr.a.angle) * (pr.b.z - pr.a.z) > 0 ? 1 : -1) : 1;
    const fa = { x: Math.sin(pr.a.angle) * sa, z: Math.cos(pr.a.angle) * sa }, fb = { x: Math.sin(pr.b.angle), z: Math.cos(pr.b.angle) };
    const frontA = { x: pr.a.x + fa.x * lenA / 2, z: pr.a.z + fa.z * lenA / 2 }, frontB = { x: pr.b.x + fb.x * PLATFORM / 2, z: pr.b.z + fb.z * PLATFORM / 2 };
    const from: OPoint = { x: frontA.x + fa.x * LEAD, z: frontA.z + fa.z * LEAD, tx: fa.x, tz: fa.z };
    const to: OPoint = { x: frontB.x + fb.x * LEAD, z: frontB.z + fb.z * LEAD, tx: -fb.x, tz: -fb.z };
    const avoid = [
      { x0: frontA.x - fa.x * lenA, z0: frontA.z - fa.z * lenA, x1: from.x - fa.x * 4, z1: from.z - fa.z * 4, r: 4 },
      { x0: frontB.x - fb.x * PLATFORM, z0: frontB.z - fb.z * PLATFORM, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
    ];
    const start: OPoint = { x: frontA.x, z: frontA.z, tx: fa.x, tz: fa.z };
    const plan = yield* routeGen(g, from, to, { kind: 'rail', owner, tracks, y0: pr.a.y, y1: pr.b.y, pre: [start], post: [{ x: frontB.x, z: frontB.z, tx: -fb.x, tz: -fb.z }], avoid, minR: 14, retries: 3 }, 500);
    if (typeof plan === 'string') return fail(plan, plan.startsWith('route runs') ? 720 : 900);
    this.state.phase = `${planning}: costs`;
    const way = plan.way;
    let prof: ChainProfile | null = plan.prof;
    const len = plan.prof.s[plan.prof.s.length - 1];
    const dist = Math.hypot(pr.a.x - pr.b.x, pr.a.z - pr.b.z);
    if (len > dist * 1.55 + 25) return fail('detour too long');
    yield;
    const big = Math.sqrt(A.pop * B.pop) >= 2500;
    const cars = pickTrain(g.year, PLATFORM, len, openingCoaches(A.pop, B.pop));
    if (!cars) return fail('no trains available');
    const nTrains = big ? 2 : 1;
    const trainCost = cars.reduce((a, c) => a + c.cost, 0);
    const est = estimateChainCost(prof, tracks, 'rail', 'standard').cost * 1.15;
    const total = est + (hub ? 0 : pr.a.cost) + pr.b.cost + 260_000 + trainCost * nTrains;
    if (total > this.available()) return fail('too expensive', 360);
    yield;
    // rough yearly result: two trains on the single track (passing at the stations), grown to the platform length
    // (trains open short and get longer as passengers pile up; fare model in vehicle.ts); bold companies accept a
    // longer payback
    const days = len / 3.2 + 9;
    const tripsYear = 360 / days;
    // (trains grow to the length of platforms rebuilt to 12 units where passengers pile up)
    const full = pickTrain(g.year, Math.max(PLATFORM, 12), len, 5) ?? cars;
    const cap = full.reduce((a, c) => a + c.capacity, 0);
    const income = 2 * tripsYear * cap * 0.7 * fare(dist, days - 6, 1);
    const running = 2 * full.reduce((a, c) => a + c.running, 0);
    const maint = len * 300 + (hub ? 0 : 40_000) + 40_000 + 12_000 + est * 0.01;
    const k = (x: number) => `${Math.round(x / 1000)}k`;
    const need = (total - trainCost * nTrains) * (0.075 - 0.05 * this.config.risk) + total * 0.03;
    if (income - running - maint < need) return fail(`not profitable (${k(income - running - maint)} a year on ${k(total)}, ${k(need)} needed)`, 1500);
    // ---- build
    this.state.phase = `building railway ${hub ? hub.name : A.name} - ${B.name}`;
    if (!this.borrowFor(total)) return fail('no money', 360);
    p.built = true;
    const spent0 = this.eco.money;
    for (const sp of hub ? [pr.b] : [pr.a, pr.b]) {
      const re = g.stations.planRail(sp.x, sp.z, sp.angle, PLATFORM, ST, owner);
      const id = g.stations.nextId;
      if (!re.ok || g.stations.commitRail(re, owner)) return fail('station site taken', 360);
      p.stations.push(id);
      this.track(net.nextEdge - ST);
      const nst = g.stations.get(id);
      yield;
      if (nst) { yield* this.roadAccessGen(nst); this.linkTransfers(id); }
      yield;
    }
    const stA = hub ?? g.stations.get(p.stations[0])!, stB = g.stations.get(p.stations[hub ? 0 : 1])!;
    if (!stA.rail || !stB.rail) return fail('station gone', 360);
    const facing = (st: Station, o: Station) => { const r = st.rail!; return Math.sin(r.angle) * (o.x - st.x) + Math.cos(r.angle) * (o.z - st.z) > 0; };
    // the main line leaves from the platform track with the other one on the same side (travelling A -> B) at both
    // stations, so that a second track can later run straight into the free platforms at both ends
    const outOf = (st: Station, o: Station) => { const r = st.rail!, f = facing(st, o) ? 1 : -1; return { x: Math.sin(r.angle) * f, z: Math.cos(r.angle) * f }; };
    const mainFirst = (ends: number[], t: P2) => {
      const n0 = net.nodes.get(ends[0]), n1 = net.nodes.get(ends[1]);
      if (!n0 || !n1) return ends;
      return (n1.x - n0.x) * -t.z + (n1.z - n0.z) * t.x > 0 ? ends : [ends[1], ends[0], ...ends.slice(2)];
    };
    const oA = outOf(stA, stB), oB = outOf(stB, stA);
    const fAs = mainFirst(stationEnds(g, stA).map((e) => (facing(stA, stB) ? e.front : e.back)), oA);
    const fBs = mainFirst(stationEnds(g, stB).map((e) => (facing(stB, stA) ? e.front : e.back)), { x: -oB.x, z: -oB.z });
    const exclude = new Set<number>([...stA.rail.edges, ...stB.rail.edges]);
    // the planned heights stand when the stations came out at the planned heights
    if (!prof || Math.abs(stA.rail.y - pr.a.y) > 1e-6 || Math.abs(stB.rail.y - pr.b.y) > 1e-6) {
      prof = chainProfile(g, [start, ...way], tracks, stA.rail.y, stB.rail.y, 'rail', exclude);
      if (!prof) return fail('too steep');
      yield;
    }
    if (yield* routeConflictGen(g, prof, 'rail', tracks, exclude, 40)) return fail('route runs along other tracks or roads', 720);
    yield;
    const e0 = net.nextEdge;
    const chain = chainGen(g, fAs[0], way, { kind: 'rail', type: 'standard', tracks, heightOffset: 0, crossing: 'auto', owner }, fBs[0], prof);
    let r = chain.next();
    while (!r.done) { this.track(e0); yield; r = chain.next(); }
    this.track(e0);
    const res = r.value;
    if (!res.ok) return fail('construction failed: ' + (res.error ?? ''), 720);
    this.stats.track += res.built; this.stats.bridges += res.bridges; this.stats.tunnels += res.tunnels;
    yield;
    // ---- a trunk line between big towns gets its second track at once (into the free platforms, directional with
    // block signals); else, or where that fails, passing loops at the stations
    const trunk = !hub && Math.sqrt(A.pop * B.pop) >= AIController.trunkPop && this.available() > est + 1_000_000;
    let early: { line: Line; info: LineInfo } | null = null;
    if (trunk) {
      const line = g.lines.create('rail', owner);
      line.stops = [stA.id, stB.id];
      p.line = line.id;
      const info: LineInfo = { kind: 'rail', towns: [A.id, B.id], depot: -1, maxVehicles: 2, opened: g.day };
      this.lines.set(line.id, info);
      early = { line, info };
      const t0 = net.nextEdge;
      yield* this.doubleGen(line, info);
      this.track(t0);
      this.state.phase = `building railway ${A.name} - ${B.name}`;
    }
    // ---- passing loops: the other platform tracks join the main line a little way out
    if (!early?.info.double) for (const [st, ends] of [[stA, fAs], [stB, fBs]] as [Station, number[]][]) {
      const n0 = net.nodes.get(ends[0]);
      if (!n0) continue;
      const out = { x: Math.sin(st.rail!.angle) * (facing(st, st === stA ? stB : stA) ? 1 : -1), z: Math.cos(st.rail!.angle) * (facing(st, st === stA ? stB : stA) ? 1 : -1) };
      for (let i = 1; i < ends.length; i++) {
        const ni = net.nodes.get(ends[i]);
        if (!ni || ni.edges.length !== 1) continue;
        const t0 = net.nextEdge;
        for (const L of [14, 12, 16]) {
          const sn = findSnap(g, 'rail', n0.x + out.x * L, n0.z + out.z * L, 0.4);
          if (sn.kind !== 'edge') continue;
          const pj = planEdge(g, nodeSnap(g, ends[i], 'rail'), sn, { kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'auto', owner });
          if (pj.ok && !commitProposal(g, pj)) break;
        }
        this.track(t0);
      }
    }
    yield;
    // ---- depot: one of ours that reaches both stations, else on a siding off the new line (station ends stay
    // free for extensions), else behind a station
    const d0 = net.nextEdge;
    let dep = -1;
    for (const d of g.depots.map.values()) if (d.owner === owner && d.kind === 'rail' && depotReaches(g, d, stA.id) && depotReaches(g, d, stB.id)) { dep = d.id; break; }
    const ownDepot = dep < 0;
    if (dep < 0) dep = yield* this.depotNearLine([...p.edges], stB.x, stB.z, 60);
    if (dep < 0) dep = yield* this.depotNearLine([...p.edges], stA.x, stA.z, 60);
    for (const [st, o] of [[stB, stA], [stA, stB]] as [Station, Station][]) if (dep < 0) dep = this.depotSwitch(st, { x: o.x - st.x, z: o.z - st.z });
    this.track(d0);
    if (dep < 0) return fail('no depot site', 720);
    if (ownDepot) p.depots.push(dep);
    const dp = g.depots.get(dep)!;
    if (!depotReaches(g, dp, stA.id) && !depotReaches(g, dp, stB.id)) return fail('depot cut off', 720);
    yield;
    // ---- line: extend our line ending at the hub (through trains), or a new one
    const ext = hub ? [...this.lines].find(([lid, info]) => {
      const l = g.lines.get(lid);
      return info.kind === 'rail' && !info.shared && !!l && new Set(l.stops).size === 2 && l.stops.includes(hub.id);
    }) : undefined;
    let line = ext ? g.lines.get(ext[0])! : early?.line ?? null;
    if (line && ext) {
      const other = line.stops.find((s) => s !== hub!.id)!;
      line.stops = [other, hub!.id, stB.id, hub!.id];
      ext[1].towns = [...new Set([...ext[1].towns, B.id])];
      ext[1].maxVehicles = Math.max(ext[1].maxVehicles, 3);
      g.lines.rebuild();
      for (const vid of line.vehicles) g.vehicles.get(vid)?.onLineChanged();
    } else {
      if (!line) { line = g.lines.create('rail', owner); p.line = line.id; }
      // the first stop is one the depot reaches
      line.stops = depotReaches(g, dp, stA.id) ? [stA.id, stB.id] : [stB.id, stA.id];
      if (early) g.lines.rebuild();
    }
    let bought = 0;
    for (let i = 0; i < nTrains; i++) {
      const t = g.vehicles.buyTrain(dep, cars, line.id);
      if (typeof t !== 'string') { bought++; this.stats.vehicles++; }
    }
    if (!bought && !ext) return fail('could not buy a train', 360);
    if (!ext) {
      const info: LineInfo = early?.info ?? { kind: 'rail', towns: [A.id, B.id], depot: dep, maxVehicles: 2, opened: g.day };
      info.depot = dep;
      this.lines.set(line.id, info);
    }
    if (ext) p.line = line.id;
    this.stats.lines += ext ? 0 : 1; this.stats.railStations += hub ? 1 : 2;
    if (hub) this.stats.reused++;
    this.stats.spent += Math.max(0, spent0 - this.eco.money) + total - est;
    g.postNews(hub ? `${this.name} extends its railway from ${hub.name} to ${B.name} (${(len / 100).toFixed(1)} km).`
      : `${this.name} opens a railway between ${A.name} and ${B.name} (${(len / 100).toFixed(1)} km).`, 'ai', (stA.x + stB.x) / 2, (stA.z + stB.z) / 2);
    this.note(`${hub ? 'extended railway ' + hub.name + '-' + B.name + (ext ? ' (line ' + line.name + ')' : '') : 'opened railway ' + A.name + '-' + B.name}: ${Math.round(len)} u, ${res.bridges} bridges, ${res.tunnels} tunnels`);
  }

  /**
   * Walking transfers from a new station or stop of ours to the stations nearby (transfer range): rail stations
   * (ours, or of companies whose network we may use, or who may use ours) and our own stops. Passengers then change
   * between the lines of the complex.
   */
  private linkTransfers(id: number) {
    const g = this.game, me = this.companyId;
    try {
      for (const o of g.stations.transferOptions(id)) {
        if (o.linked || o.link !== null) continue;
        const st = g.stations.get(o.id);
        if (!st || (!st.rail && st.owner !== me)) continue;
        if (!g.stations.link(id, o.id)) { this.stats.transfers++; this.note(`walking transfer ${g.stations.get(id)?.name ?? ''} - ${st.name}`); }
      }
    } catch (e) { this.note('transfer link failed: ' + String((e as Error)?.message ?? e)); }
  }

  /**
   * A ground station attracts passengers only when it is connected to the roads (stations.ts builds an access
   * street when it can): if it has none, a street from the station building to the nearest road.
   */
  private *roadAccessGen(st: Station): Generator<void, void> {
    const g = this.game, net = g.world.net;
    if (!st.rail || g.stations.hasAccess(st)) return;
    // a street from the station building to the nearest road
    const b = st.rail.building;
    const ne = net.nearestEdge(b.x, b.z, 40, 'road', (e) => e.depot < 0);
    if (ne) {
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(ne.edge, ne.s, q);
      const d = Math.hypot(q.x - b.x, q.z - b.z) || 1;
      const off = Math.max(b.w, b.d) / 2 + 0.8;
      const from = { kind: 'free' as const, x: b.x + ((q.x - b.x) / d) * off, z: b.z + ((q.z - b.z) / d) * off, y: 0 };
      const to = findSnap(g, 'road', q.x, q.z, 0.6);
      if (to.kind !== 'free') {
        const pj = planEdge(g, from, to, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.companyId });
        if (pj.ok && pj.demolish.length <= 1 && pj.cost < this.available() * 0.2 && !commitProposal(g, pj)) {
          g.stations.refreshAccess(true);
          if (g.stations.hasAccess(st)) { this.note(`access road for ${st.name}`); return; }
        }
      }
    }
    // else the station rebuilt in place with its building on the other side (where a road may be)
    const r = st.rail;
    for (const side of [1, -1] as const) {
      yield;
      if (!g.stations.get(st.id)) return;
      const plan = g.stations.planRail(r.x, r.z, r.angle, r.length, r.tracks, this.companyId, { buildingSide: side, ignoreStation: st.id });
      if (!plan.ok || !plan.roadAccess || plan.cost > this.available() * 0.3 || !this.borrowFor(plan.cost)) continue;
      if (!relocateStation(g, st.id, plan)) { this.note(`rebuilt ${st.name} facing a road`); return; }
    }
  }

  /** A depot on a siding off our edges near (x, z) (as buildDepotNearLine, a try per step). */
  private *depotNearLine(edges: number[], x: number, z: number, maxDist: number): Generator<void, number> {
    const g = this.game, net = g.world.net, owner = this.companyId;
    const cands: { id: number; s: number; d: number }[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (const id of edges) {
      const e = net.edges.get(id);
      if (!e || e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || e.depot >= 0 || e.len < 8) continue;
      for (let s = 3; s <= e.len - 3; s += 5) {
        if (net.sectionAt(e, s) !== 'ground') continue;
        net.pointAt(e, s, p);
        const d = Math.hypot(p.x - x, p.z - z);
        if (d <= maxDist) cands.push({ id, s, d });
      }
    }
    cands.sort((a, b) => a.d - b.d || a.id - b.id);
    let tries = 0;
    for (const c of cands) {
      if (!net.edges.has(c.id)) continue;
      const dep = buildDepotOnLine(g, c.id, c.s, owner);
      if (dep >= 0) return dep;
      if (++tries >= 12) break;
      yield;
    }
    return -1;
  }

  /** Depot for a multi-track terminus: a switch behind the back ends feeding every platform track. */
  private depotSwitch(st: Station, frontDir: P2): number {
    const g = this.game, net = g.world.net, owner = this.companyId;
    const r = st.rail!;
    const ax = Math.sin(r.angle), az = Math.cos(r.angle);
    const sgn = ax * frontDir.x + az * frontDir.z > 0 ? -1 : 1; // direction of the back ends
    const bx = ax * sgn, bz = az * sgn;
    const ends = stationEnds(g, st).map((e) => (sgn > 0 ? e.front : e.back));
    const o = (h: number): BuildOptions => ({ kind: 'rail', type: 'standard', tracks: 1, heightOffset: h, crossing: 'auto', owner });
    const backC = { x: r.x + bx * r.length / 2, z: r.z + bz * r.length / 2 };
    for (const L of [12, 16, 20]) {
      const S = { x: backC.x + bx * L, z: backC.z + bz * L }, D = { x: S.x + bx * 6, z: S.z + bz * 6 };
      if (!g.world.inside(D.x, D.z, 8) || !depotFits(g, D.x, D.z, -bx, -bz, owner, 30, r.y)) continue;
      const n0 = net.nodes.get(ends[0]);
      if (!n0 || n0.edges.length !== 1) return buildRailDepot(g, st, owner, frontDir);
      const p1 = planEdge(g, nodeSnap(g, ends[0], 'rail'), { kind: 'free', x: S.x, z: S.z, y: 0 }, o(r.y - g.world.heightAt(S.x, S.z) || 1e-3));
      if (!p1.ok || commitProposal(g, p1)) continue;
      const sNode = nodeAt(g, 'rail', S.x, S.z);
      if (!sNode) return -1;
      const p2 = planEdge(g, nodeSnap(g, sNode.id, 'rail'), { kind: 'free', x: D.x, z: D.z, y: 0 }, o(r.y - g.world.heightAt(D.x, D.z) || 1e-3));
      if (!p2.ok || commitProposal(g, p2)) { removeEdges(g, [...sNode.edges], owner); continue; }
      for (let i = 1; i < ends.length; i++) {
        const p3 = planEdge(g, nodeSnap(g, ends[i], 'rail'), nodeSnap(g, sNode.id, 'rail'), o(0));
        if (p3.ok) commitProposal(g, p3);
      }
      const dNode = nodeAt(g, 'rail', D.x, D.z);
      const id = dNode ? depotAtEnd(g, dNode.id, owner) : -1;
      if (id >= 0) return id;
      return -1;
    }
    return buildRailDepot(g, st, owner, frontDir);
  }

  // ---------------------------------------------------------------- trains on another company's railway
  /** Railways of other companies (that grant access) between two towns we don't connect: [owner, station A, station B]. */
  private shareOptions(opts: { score: number; kind: ProjectKind; towns: number[]; share?: [number, number, number] }[], own: LineInfo[], D: { pair: (a: number, b: number) => number }) {
    const g = this.game, me = this.companyId;
    const trainsAt = new Map<number, number>();
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail') continue;
      for (const s of new Set(l.stops)) trainsAt.set(s, (trainsAt.get(s) ?? 0) + l.vehicles.length);
    }
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.owner === me || l.stops.length < 2 || !l.vehicles.length) continue;
      const o = l.owner, co = g.companies[o];
      if (!co || co.defunct || g.accessPolicy(o) === 'auto-reject' || g.isBlocked(o, me) || g.requestsBy(me).some((q) => q.owner === o)) continue;
      const sA = g.stations.get(l.stops[0]);
      if (!sA || !sA.rail || sA.owner !== o) continue;
      let sB: Station | undefined, bd = 0;
      for (const sid of l.stops) { const s = g.stations.get(sid); const d = s ? Math.hypot(s.x - sA.x, s.z - sA.z) : 0; if (s && d > bd) { bd = d; sB = s; } }
      if (!sB || !sB.rail || sB.owner !== o || bd < 60 || bd > 260) continue;
      const A = g.towns.list[sA.townId], B = g.towns.list[sB.townId];
      if (!A || !B || A === B) continue;
      const key = 'share' + o + ':' + this.pairKey(sA.id, sB.id);
      if (this.isFailed(key) || own.some((x) => x.kind === 'rail' && x.towns.includes(A.id) && x.towns.includes(B.id))) continue;
      // a free platform for our train at both ends (each train waits for a free path, so this cannot jam)
      const room = Math.min(sA.rail.tracks, sB.rail.tracks) - Math.max(trainsAt.get(sA.id) ?? 0, trainsAt.get(sB.id) ?? 0);
      if (room < 1) continue;
      // a train and a depot; the fees are our usage share of the line's upkeep (the owner's multiplier)
      const m = g.accessMultiplier(o), upkeep = bd * 1.3 * 330 + 60_000;
      const net = D.pair(A.id, B.id) * 0.3 * 12 * fare(bd, bd / 9, 1) - 100_000 - upkeep * (m / (1 + m));
      const score = Math.sqrt(Math.max(0, net / 1_000_000)) * this.config.focus.rail * this.config.focus.rail;
      opts.push({ score, kind: 'share', towns: [A.id, B.id], share: [o, sA.id, sB.id] });
    }
  }

  /** Run our own trains between two stations of another company under a track access agreement. */
  private *shareJob(owner: number, a: number, b: number): Generator<void, void> {
    const g = this.game, me = this.companyId, net = g.world.net;
    const p = this.project!;
    const stA = g.stations.get(a), stB = g.stations.get(b);
    const oName = g.company(owner).name;
    const key = 'share' + owner + ':' + this.pairKey(a, b);
    const fail = (why: string, days = 1500) => { this.note(`trains on ${oName}'s railway abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    if (!stA || !stB || !stA.rail || !stB.rail) return fail('stations gone');
    this.state.phase = `negotiating track access with ${oName}`;
    if (!g.hasAccess(me, owner)) {
      const r = g.requestAccess(me, owner, `trains between ${stA.name} and ${stB.name}`);
      if (r === 'pending') {
        this.state.phase = `waiting for track access from ${oName}`;
        p.access = owner;
        while (g.requestsBy(me).some((q) => q.owner === owner)) yield;
      }
      if (!g.hasAccess(me, owner)) return fail(r === 'pending' ? 'access not granted' : 'access ' + r, 3000);
      p.access = owner;
    }
    yield;
    const span = Math.hypot(stA.x - stB.x, stA.z - stB.z);
    const TA = g.towns.list[stA.townId], TB = g.towns.list[stB.townId];
    const cars = pickTrain(g.year, Math.min(stA.rail.length, stB.rail.length), span * 1.25, openingCoaches(TA?.pop ?? 0, TB?.pop ?? 0));
    if (!cars) return fail('no trains available');
    const cost = cars.reduce((s, c) => s + c.cost, 0) + 450_000;
    if (cost > this.available()) return fail('too expensive', 360);
    if (!this.borrowFor(cost)) return fail('no money', 360);
    this.state.phase = `building a depot at ${stA.name}`;
    p.built = true;
    // our depot on a stub behind one of the stations (the line's side stays free)
    const e0 = net.nextEdge;
    // a siding off the owner's line near a station (we may connect to its track: our trains then join the main
    // line instead of waiting behind the owner's platforms), else a stub behind one of the stations
    let dep = -1;
    {
      const q = { x: 0, y: 0, z: 0 };
      for (const st of [stA, stB]) {
        if (dep >= 0) break;
        const cands: { id: number; s: number; d: number }[] = [];
        for (const e of net.edgesNear(st.x - 90, st.z - 90, st.x + 90, st.z + 90)) {
          if (e.kind !== 'rail' || e.owner !== owner || e.station >= 0 || e.depot >= 0 || e.len < 6) continue;
          for (let s = 3; s <= e.len - 3; s += 4) { if (net.sectionAt(e, s) !== 'ground') continue; net.pointAt(e, s, q); const d = Math.hypot(q.x - st.x, q.z - st.z); if (d > 16) cands.push({ id: e.id, s, d }); }
        }
        cands.sort((a, b) => a.d - b.d || a.id - b.id);
        for (const c of cands.slice(0, 16)) { if (!net.edges.has(c.id)) continue; dep = buildDepotOnLine(g, c.id, c.s, me); if (dep >= 0) break; }
        yield;
      }
    }
    for (const [st, o] of [[stA, stB], [stB, stA]] as [Station, Station][]) {
      if (dep >= 0) break;
      dep = buildRailDepot(g, st, me, { x: o.x - st.x, z: o.z - st.z });
      yield;
    }
    this.track(e0);
    if (dep < 0) return fail('no depot site');
    p.depots.push(dep);
    const dp = g.depots.get(dep)!;
    // trains leave a siding one way: the first stop is a station they reach (they reverse there for the other)
    const ra = depotReaches(g, dp, a), rb = depotReaches(g, dp, b);
    if (!ra && !rb) return fail('stations not reachable');
    yield;
    const line = g.lines.create('rail', me);
    line.stops = ra ? [a, b] : [b, a];
    p.line = line.id;
    const t = g.vehicles.buyTrain(dep, cars, line.id);
    if (typeof t === 'string') return fail('could not buy a train: ' + t, 360);
    this.stats.vehicles++;
    const A = g.towns.list[stA.townId], B = g.towns.list[stB.townId];
    this.lines.set(line.id, { kind: 'rail', towns: [A?.id ?? -1, B?.id ?? -1], depot: dep, maxVehicles: 1, opened: g.day, shared: owner });
    this.stats.lines++; this.stats.shared++;
    p.access = -1;
    g.postNews(`${this.name} runs trains on ${oName}'s railway between ${A?.name ?? stA.name} and ${B?.name ?? stB.name} (track access).`, 'ai', (stA.x + stB.x) / 2, (stA.z + stB.z) / 2);
    this.note(`trains on ${oName}'s railway ${stA.name}-${stB.name}`);
  }

  /** Remove a depot no line of ours uses any more, with the track leading to it up to a junction or foreign track. */
  private removeDepotBranch(depId: number) {
    const g = this.game, net = g.world.net, me = this.companyId;
    for (const x of this.lines.values()) if (x.depot === depId) return;
    const dp = g.depots.get(depId);
    if (!dp || dp.owner !== me) return;
    const exit = dp.node;
    if (g.depots.remove(depId)) return;
    const ids: number[] = [];
    let node = exit;
    for (let k = 0; k < 10; k++) {
      const n = net.nodes.get(node);
      if (!n) break;
      const rest = n.edges.filter((id) => !ids.includes(id));
      if (rest.length !== 1) break;
      const e = net.edges.get(rest[0]);
      if (!e || e.owner !== me || e.station >= 0 || e.depot >= 0) break;
      ids.push(e.id);
      node = e.a === node ? e.b : e.a;
    }
    if (ids.length) removeEdges(g, ids, me);
  }

  /** End access agreements as user that no line of ours relies on any more. */
  private endUnusedAccess(only = -1) {
    const g = this.game, me = this.companyId;
    for (const a of [...g.access]) {
      if (a.user !== me || (only >= 0 && a.owner !== only)) continue;
      let used = false;
      for (const l of g.lines.map.values()) {
        if (l.owner !== me) continue;
        if (l.stops.some((s) => g.stations.get(s)?.owner === a.owner)) { used = true; break; }
      }
      if (!used) for (const info of this.lines.values()) if (info.shared === a.owner) { used = true; break; }
      if (!used) { g.endAccess(me, a.owner); this.note(`ended track access to ${g.company(a.owner).name}`); }
    }
  }

  // ---------------------------------------------------------------- bus
  private *busJob(T: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    this.state.phase = `planning buses in ${T.name}`;
    const fail = (why: string) => { this.note(`buses in ${T.name} abandoned: ${why}`); this.markFailed('bus' + T.id, 1200); this.abandon(p); };
    const model = pickBus(g.year, T.pop);
    if (!model) return fail('no buses available');
    // stop candidates on streets: middle of street edges, away from other companies' stops; a stop that joins our
    // rail station in the town comes first (one transfer complex: passengers change between trains and buses)
    const cands: { x: number; z: number; d: number; rail?: boolean }[] = [];
    let k = 0;
    for (const e of g.towns.streets(T, 0)) {
      if (e.len < 4) continue;
      if (++k % 20 === 0) yield; // grid towns have many streets: spread the stop planning over days
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const bp = g.stations.planBusStop(q.x, q.z, owner);
      if (!bp.ok || (bp.join && !(bp.join.rail && bp.join.owner === owner && bp.join.townId === T.id))) continue;
      let clash = false;
      for (const st of g.stations.map.values()) if (st.owner !== owner && st.stops.some((s) => Math.hypot(s.x - q.x, s.z - q.z) < 8)) { clash = true; break; }
      if (!clash) cands.push({ x: q.x, z: q.z, d: Math.hypot(q.x - T.x, q.z - T.z), rail: !!bp.join });
    }
    yield;
    if (cands.length < 2) return fail('no stop sites');
    cands.sort((a, b) => (a.rail ? 0 : 1) - (b.rail ? 0 : 1) || a.d - b.d);
    if (cands[0].rail) this.stats.reused++;
    const stops = [cands[0]];
    const nStops = T.pop > 2000 ? 3 : 2;
    for (const c of cands) {
      if (stops.length >= nStops) break;
      if (stops.every((s) => { const d = Math.hypot(s.x - c.x, s.z - c.z); return d > 11 && d < 34; })) stops.push(c);
    }
    if (stops.length < 2) return fail('stops too close');
    const cost = stops.length * 30000 + 120_000 + model.cost * (stops.length + 1);
    if (!this.borrowFor(cost)) return fail('no money');
    this.state.phase = `building buses in ${T.name}`;
    p.built = true;
    const ids: number[] = [];
    for (const s of stops) {
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) continue;
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const d = Math.hypot(q.x - s.x, q.z - s.z); if (d < bd) { bd = d; sid = st.id; } }
      if (sid >= 0 && !ids.includes(sid)) ids.push(sid);
      if (g.stations.nextId > before) { p.stations.push(before); yield; this.linkTransfers(before); }
      this.stats.busStops++;
      yield;
    }
    if (ids.length < 2) return fail('stops not built');
    const d0 = net.nextEdge;
    const dep = yield* roadDepotGen(g, stops[0].x, stops[0].z, owner);
    this.track(d0);
    if (dep < 0) return fail('no depot site');
    p.depots.push(dep);
    yield;
    const line = g.lines.create('road', owner);
    line.stops = ids;
    p.line = line.id;
    const n = Math.min(3, ids.length);
    for (let i = 0; i < n; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (typeof v !== 'string') this.stats.vehicles++; }
    this.lines.set(line.id, { kind: 'bus', towns: [T.id], depot: dep, maxVehicles: 5, opened: g.day });
    this.stats.lines++;
    g.postNews(`${this.name} starts a bus service in ${T.name}.`, 'ai', T.x, T.z);
    this.note(`opened bus line in ${T.name} (${ids.length} stops, ${n} buses)`);
  }

  // ---------------------------------------------------------------- long-distance coaches
  /** A stop for coaches in a town: at our rail station (a transfer hub) or on a central street. */
  private *coachStopGen(T: Town): Generator<void, { x: number; z: number } | null> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    let best: { x: number; z: number; d: number } | null = null, k = 0;
    for (const e of g.towns.streets(T, 2)) {
      if (e.len < 4) continue;
      if (++k % 8 === 0) yield;
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const bp = g.stations.planBusStop(q.x, q.z, owner);
      if (!bp.ok || (bp.join && !(bp.join.owner === owner && bp.join.townId === T.id))) continue;
      const d = Math.hypot(q.x - T.x, q.z - T.z) - (bp.join?.rail ? 30 : 0);
      if (!best || d < best.d) best = { x: q.x, z: q.z, d };
    }
    return best;
  }

  /** A coach line between two towns over the roads (stops at central streets or our rail stations, a depot, coaches). */
  private *coachJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = 'coach' + this.pairKey(A.id, B.id);
    this.state.phase = `planning coaches ${A.name} - ${B.name}`;
    const fail = (why: string, days = 1500) => { this.note(`coaches ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    const model = pickCoach(g.year);
    if (!model) return fail('no coaches available');
    if (!this.roadConnected(A, B)) return fail('no road between the towns', 720);
    yield;
    const sa = yield* this.coachStopGen(A), sb = yield* this.coachStopGen(B);
    if (!sa || !sb) return fail('no stop sites');
    const cost = 2 * 30_000 + 80_000 + model.cost * 2;
    if (cost > this.available() || !this.borrowFor(cost)) return fail('no money', 360);
    this.state.phase = `building coaches ${A.name} - ${B.name}`;
    p.built = true;
    const ids: number[] = [];
    for (const s of [sa, sb]) {
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) return fail('stop site taken', 360);
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const d = Math.hypot(q.x - s.x, q.z - s.z); if (d < bd) { bd = d; sid = st.id; } }
      if (g.stations.nextId > before) { p.stations.push(before); yield; this.linkTransfers(before); }
      if (sid < 0 || ids.includes(sid)) return fail('stops not built', 360);
      ids.push(sid);
      this.stats.busStops++;
      yield;
    }
    const d0 = net.nextEdge;
    const dep = yield* roadDepotGen(g, sa.x, sa.z, owner);
    this.track(d0);
    if (dep < 0) return fail('no depot site', 720);
    p.depots.push(dep);
    const dp = g.depots.get(dep)!;
    if (!roadDepotReaches(g, dp, ids[0]) || !roadDepotReaches(g, dp, ids[1])) return fail('no road route', 720);
    yield;
    const line = g.lines.create('road', owner);
    line.stops = ids;
    p.line = line.id;
    let bought = 0;
    for (let i = 0; i < 2; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (typeof v !== 'string') { bought++; this.stats.vehicles++; } }
    if (!bought) return fail('could not buy coaches', 360);
    this.lines.set(line.id, { kind: 'bus', towns: [A.id, B.id], depot: dep, maxVehicles: 4, opened: g.day });
    this.stats.lines++; this.stats.coaches++;
    g.postNews(`${this.name} starts coaches between ${A.name} and ${B.name}.`, 'ai', (A.x + B.x) / 2, (A.z + B.z) / 2);
    this.note(`opened coach line ${A.name}-${B.name} (${Math.round(Math.hypot(A.x - B.x, A.z - B.z))} u, ${bought} coaches)`);
  }

  // ---------------------------------------------------------------- tram (ai-tram.ts does the planning and building)
  private startTram(): boolean {
    const g = this.game, tp = this.tramPlanner();
    if (!tp.start()) return false;
    const town = tramExt(tp).project?.town ?? -1;
    this.project = { kind: 'tram', towns: town >= 0 ? [town] : [], stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = this.tramJob(g.towns.list[town]);
    this.state.projects++;
    return true;
  }

  private *tramJob(T: Town | undefined): Generator<void, void> {
    const g = this.game, tp = this.tramPlanner(), x = tramExt(tp);
    const p = this.project!;
    const where = T ? T.name : 'town';
    this.state.phase = `planning trams in ${where}`;
    for (;;) {
      const r = tp.step(1);
      if (r === 'running') { if (x.status) this.state.phase = x.status; yield; continue; }
      if (r === 'failed') {
        this.note(`trams in ${where} abandoned: ${x.reason || 'failed'}`);
        if (T) this.markFailed('tram' + T.id, 720); else this.stats.failed++;
        tp.cleanup();
        return;
      }
      // done: the planner opened a line; we manage it from now on
      const pr = x.project;
      const line = pr ? g.lines.get(pr.line) : undefined;
      if (line) {
        p.line = line.id;
        this.lines.set(line.id, { kind: 'tram', towns: T ? [T.id] : [], depot: pr!.depot, maxVehicles: 4, opened: g.day });
        this.stats.lines++; this.stats.trams++; this.stats.vehicles += line.vehicles.length;
        g.postNews(`${this.name} opens a tram line in ${where}.`, 'ai', T?.x, T?.z);
        this.note(`opened tram line in ${where} (${new Set(line.stops).size} stops, ${line.vehicles.length} trams)`);
      }
      tp.cleanup();
      return;
    }
  }

  // ---------------------------------------------------------------- road
  /** Are two towns connected by roads? (bounded search over the road graph) */
  private roadConnected(A: Town, B: Town): boolean {
    const net = this.game.world.net;
    const start = net.nearestNode(A.x, A.z, A.radius + 6, 'road', (n) => n.edges.length > 0);
    if (!start) return false;
    const seen = new Set<number>([start.id]);
    const queue = [start.id];
    while (queue.length && seen.size < 6000) {
      const id = queue.shift()!;
      const n = net.nodes.get(id)!;
      if (Math.hypot(n.x - B.x, n.z - B.z) < B.radius) return true;
      for (const eid of n.edges) {
        const e = net.edges.get(eid);
        if (!e || e.depot >= 0) continue;
        const o = e.a === id ? e.b : e.a;
        if (!seen.has(o)) { seen.add(o); queue.push(o); }
      }
    }
    return false;
  }

  /** Outermost street point of a town in direction u (within a corridor). */
  private townEdge(T: Town, ux: number, uz: number): { x: number; z: number; d: number } | null {
    const net = this.game.world.net;
    let best: { x: number; z: number; d: number } | null = null;
    for (const e of this.game.towns.streets(T, 4)) {
      const geo = net.geo(e);
      for (let i = 0; i < geo.n; i += 4) {
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
        const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
        if (lat > 14 || along < 0) continue;
        if (!best || along > best.d) best = { x, z, d: along };
      }
    }
    return best;
  }

  /**
   * Where a country road can leave a town towards direction u: a dead-end street facing that way
   * (extended straight), else a side exit from the outermost street. Returns the join proposal.
   */
  private townExit(T: Town, ux: number, uz: number): { prop: Proposal; x: number; z: number; tx: number; tz: number } | null {
    const g = this.game, net = g.world.net;
    const so: BuildOptions = { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: this.companyId };
    const cands: { sn: Snap; tx: number; tz: number; score: number }[] = [];
    for (const e of g.towns.streets(T, 4)) {
      for (const nid of [e.a, e.b]) {
        const n = net.nodes.get(nid)!;
        if (n.edges.length !== 1) continue;
        const along = (n.x - T.x) * ux + (n.z - T.z) * uz, lat = Math.abs((n.x - T.x) * uz - (n.z - T.z) * ux);
        const d = net.leaveDir(e, nid);
        const tx = -d.x, tz = -d.z;
        const facing = tx * ux + tz * uz;
        if (along < -5 || lat > 30 || facing < 0.5) continue;
        cands.push({ sn: { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }, tx, tz, score: along - lat * 0.5 + facing * 20 });
      }
    }
    // side exits from the outermost streets
    const pts: { x: number; z: number; along: number }[] = [];
    for (const e of g.towns.streets(T, 4)) {
      const geo = net.geo(e);
      for (let i = 2; i < geo.n - 2; i += 6) {
        const x = geo.pts[i * 3], z = geo.pts[i * 3 + 2];
        const along = (x - T.x) * ux + (z - T.z) * uz, lat = Math.abs((x - T.x) * uz - (z - T.z) * ux);
        if (lat < 20 && along > 0) pts.push({ x, z, along });
      }
    }
    pts.sort((p, q) => q.along - p.along);
    for (const q of pts.slice(0, 6)) { const sn = findSnap(g, 'road', q.x, q.z, 0.4); if (sn.kind !== 'free') cands.push({ sn, tx: ux, tz: uz, score: q.along - 1000 }); }
    cands.sort((p, q) => q.score - p.score);
    for (const c of cands.slice(0, 10)) {
      const x = c.sn.x + c.tx * 8, z = c.sn.z + c.tz * 8;
      if (!g.world.inside(x, z, 6) || g.world.heightAt(x, z) < WATER_Y + 0.2) continue;
      const pj = planEdge(g, c.sn, { kind: 'free', x, z, y: 0 }, so);
      if (pj.ok && pj.demolish.length <= 2 && pj.stats.minRadius >= 3) {
        const end = endTangent(pj.tracks[0].bez);
        return { prop: pj, x, z, tx: end.x, tz: end.z };
      }
    }
    return null;
  }

  private *roadJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = 'road' + this.pairKey(A.id, B.id);
    this.state.phase = `planning road ${A.name} - ${B.name}`;
    const fail = (why: string, days = 3000) => { this.note(`road ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    if (this.roadConnected(A, B)) return fail('already connected', 1e9);
    yield;
    const d = Math.hypot(B.x - A.x, B.z - A.z);
    const ux = (B.x - A.x) / d, uz = (B.z - A.z) / d;
    const xa = this.townExit(A, ux, uz), xb = this.townExit(B, -ux, -uz);
    if (!xa || !xb) return fail('no way out of the towns');
    const from: OPoint = { x: xa.x, z: xa.z, tx: xa.tx, tz: xa.tz };
    const to: OPoint = { x: xb.x, z: xb.z, tx: -xb.tx, tz: -xb.tz };
    const gap = (to.x - from.x) * ux + (to.z - from.z) * uz;
    if (gap < 15) return fail('towns touch', 1e9);
    yield;
    const plan = yield* routeGen(g, from, to, {
      kind: 'road', owner, tracks: 1, y0: xa.prop.tracks[0].prof[xa.prop.tracks[0].prof.length - 1], y1: xb.prop.tracks[0].prof[xb.prop.tracks[0].prof.length - 1],
      buildingCost: 3, lead: 6, rmax: 80, rgood: 12, minR: 5, roadJunctions: true,
    }, 500);
    if (typeof plan === 'string') return fail(plan, plan.startsWith('route runs') ? 1500 : 3000);
    const al = { way: plan.way };
    let prof: ChainProfile | null = plan.prof;
    if (prof.s[prof.s.length - 1] > gap * 2 + 20) return fail('detour too long');
    const est = estimateChainCost(prof, 1, 'road', 'road').cost * 1.2 + xa.prop.cost + xb.prop.cost + 50_000;
    if (est > this.available() * 0.4) return fail('too expensive', 720);
    if (!this.borrowFor(est)) return fail('no money', 360);
    this.state.phase = `building road ${A.name} - ${B.name}`;
    p.built = true;
    const o: BuildOptions = { kind: 'road', type: 'road', tracks: 1, heightOffset: 0, crossing: 'auto', owner };
    const e0 = net.nextEdge;
    if (commitProposal(g, xa.prop) || commitProposal(g, xb.prop)) { this.track(e0); return fail('could not join the towns'); }
    this.track(e0);
    const nA = nodeAt(g, 'road', from.x, from.z), nB = nodeAt(g, 'road', to.x, to.z);
    if (!nA || !nB) return fail('could not join the towns');
    yield;
    prof = chainProfile(g, al.way, 1, nA.y, nB.y, 'road', new Set(), true);
    if (!prof) return fail('too steep');
    const chain = chainGen(g, nA.id, al.way.slice(1), o, nB.id, prof);
    let r = chain.next();
    while (!r.done) { this.track(e0); yield; r = chain.next(); }
    this.track(e0);
    if (!r.value.ok) return fail('construction failed: ' + (r.value.error ?? ''));
    this.stats.road += r.value.built + 16;
    this.stats.bridges += r.value.bridges; this.stats.tunnels += r.value.tunnels;
    g.postNews(`${this.name} builds a road between ${A.name} and ${B.name}.`, 'ai', (A.x + B.x) / 2, (A.z + B.z) / 2);
    this.note(`built road ${A.name}-${B.name} (${Math.round(r.value.built + 16)} u)`);
    this.failed.set(key, 1e12); // done for good
    this.project = null;
  }

  // ---------------------------------------------------------------- management
  /** Take over lines of ours that no project registered (bought companies, older saves). */
  private adoptLines() {
    const g = this.game, me = this.companyId;
    for (const l of g.lines.map.values()) {
      if (l.owner !== me || this.lines.has(l.id) || (this.project && this.project.line === l.id)) continue;
      const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
      const dep = vs.length ? (vs[0] as Train | RoadVehicle).depotId : -1;
      if (dep === undefined || dep < 0 || !g.depots.get(dep)) continue;
      const towns = [...new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
      const kind = l.kind === 'rail' ? 'rail' : l.kind === 'tram' ? 'tram' : 'bus';
      this.lines.set(l.id, { kind, towns, depot: dep, maxVehicles: kind === 'rail' ? Math.max(1, vs.length) : kind === 'tram' ? Math.max(4, vs.length) : Math.max(5, vs.length), opened: g.day - 360 });
    }
  }

  private manage() {
    const g = this.game, e = this.eco, c = this.config, act = c.activeness;
    // loans: keep a cash cushion, repay when rich (cautious companies repay sooner)
    if (e.money < 500_000) { while (e.money < 1_000_000 && e.borrow()) { /* */ } }
    else if (!this.job && e.money > 3_000_000 * (0.6 + c.risk) && e.loan > 0) { while (e.money > 2_000_000 && e.loan > 0 && e.repay()) { /* */ } }
    this.adoptLines();
    for (const [lid, info] of [...this.lines]) {
      const l = g.lines.get(lid);
      if (!l) { this.lines.delete(lid); continue; }
      const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
      // a line that lost its stops (track access ended, stations gone): close it
      if (new Set(l.stops).size < 2) {
        for (const v of vs) { g.vehicles.sell(v.id); this.stats.sold++; }
        g.lines.delete(lid);
        this.lines.delete(lid);
        if (info.shared !== undefined) this.removeDepotBranch(info.depot);
        this.note(`closed ${l.name}`);
        continue;
      }
      // sell chronically unprofitable vehicles (keep one per line unless money is tight)
      for (const v of vs) {
        if (v.age < 2.5 || v.profitLast >= -0.25 * v.runningCost || v.profitYear > 0) continue;
        if (vs.length > 1 || e.money < 0) { g.vehicles.sell(v.id); this.stats.sold++; info.lastSold = g.day; this.note(`sold ${v.name}`); break; }
      }
      // more capacity when passengers pile up on a line that pays (active companies expand sooner): railways
      // first get longer trains (up to the platforms), then more trains
      const grow = Math.sqrt(act);
      if (!vs.length || g.day - (info.lastSold ?? -1e9) < 180) continue;
      const young = g.day - info.opened < 360;
      if (!young && l.incomeLast < l.costLast * 1.2 + 10_000) continue;
      let waiting = 0;
      for (const sid of l.stops) { const st = g.stations.get(sid); if (st) for (const w of st.waiting.values()) if (w.line === lid) waiting += w.count; }
      const v0 = vs[0];
      if (waiting < (v0.capacity * 2.5) / grow) continue;
      if (info.kind === 'rail' && vs.every((v) => v instanceof Train) && this.lengthenTrain(l, info, vs as Train[], waiting)) continue;
      // a single-track railway full of trains: lay the second track (block signals, more trains)
      if (info.kind === 'rail' && !info.double && !info.loops && !info.shared && vs.length >= info.maxVehicles && g.day - (info.upgradeFailed ?? -1e9) > 720 && !this.job) {
        this.project = { kind: 'double', towns: [...info.towns], stations: [], edges: [], depots: [], line: -1, started: g.day, built: true };
        this.job = this.doubleGen(l, info);
        continue;
      }
      const maxV = info.kind === 'bus' ? Math.min(Math.round(info.maxVehicles * grow), l.stops.length * 2)
        : info.kind === 'tram' ? Math.min(Math.round(info.maxVehicles * grow), 2 + l.stops.length) : info.maxVehicles;
      if (vs.length >= maxV || this.available() < v0.value * 1.5) continue;
      if (info.kind === 'rail' && v0 instanceof Train) {
        const t = g.vehicles.buyTrain(info.depot, [...v0.cars].sort((a, b) => (a.kind === 'loco' ? -1 : 0) - (b.kind === 'loco' ? -1 : 0)), lid);
        if (typeof t !== 'string') { this.stats.vehicles++; this.note(`added a train to ${l.name}`); }
      } else if (v0 instanceof RoadVehicle && v0.model) {
        const model = v0.model;
        if (!this.borrowFor(model.cost)) continue;
        const b = g.vehicles.buyRoad(info.depot, model, lid);
        if (typeof b !== 'string') { this.stats.vehicles++; this.note(`added a ${info.kind === 'tram' ? 'tram' : 'bus'} to ${l.name}`); }
      }
    }
    if (!this.job && g.access.length) this.endUnusedAccess();
    this.considerAcquisition();
  }

  /**
   * Lengthen the trains of a line up to its platforms: a short train standing at a platform is replaced by one
   * with more coaches (a current locomotive). True while some train is still short (no trains are added then).
   */
  private lengthenTrain(l: Line, info: LineInfo, trains: Train[], waiting: number): boolean {
    const g = this.game;
    let platform = Infinity, span = 0;
    const s0 = g.stations.get(l.stops[0]);
    for (const sid of l.stops) {
      const st = g.stations.get(sid);
      if (st?.rail) platform = Math.min(platform, st.rail.length);
      if (st && s0) span = Math.max(span, Math.hypot(st.x - s0.x, st.z - s0.z));
    }
    if (!isFinite(platform)) return false;
    let short = false, atPlatform = 0;
    for (const t of trains) {
      const n = t.cars.filter((c) => c.kind === 'wagon').length;
      const want = Math.min(5, n + (waiting > t.capacity * 4 ? 2 : 1));
      const cars = pickTrain(g.year, platform, span * 1.2, want);
      if (!cars || cars.length - 1 <= n) { if (n < 5) atPlatform++; continue; }
      short = true;
      // replaced by a longer one when it next stands at a platform (see replaceTrains)
      if (!this.relengthen.some((q) => q[0] === t.id)) this.relengthen.push([t.id, info.depot, cars.map((c) => c.id)]);
      return true;
    }
    // trains as long as the platforms and still crowded: longer platforms (station rebuild) when money allows, up
    // to 12 units (compact stations)
    if (!short && atPlatform && platform < 12 && this.extendPlatforms(l, Math.min(12, platform + 2))) return true;
    return short;
  }

  /** Rebuild a line's stations with longer platforms (trackops / stations API), when no train stands in them. */
  private extendPlatforms(l: Line, length: number): boolean {
    const g = this.game;
    let done = false;
    for (const sid of new Set(l.stops)) {
      const st = g.stations.get(sid);
      if (!st || !st.rail || st.owner !== this.companyId || st.rail.length >= length) continue;
      if (st.rail.edges.some((e) => g.vehicles.isEdgeBusy(e))) continue; // never strand a train: next month
      try {
        const plan = planStationUpgrade(g, sid, { length });
        if (!plan || !plan.ok || this.available() < plan.cost * 1.5 + 500_000 || !this.borrowFor(plan.cost)) continue;
        const err = commitStationUpgrade(g, plan);
        if (err) continue;
        done = true;
        this.note(`rebuilt ${st.name} with ${length}-unit platforms`);
      } catch (e) { this.note('station rebuild failed: ' + String((e as Error)?.message ?? e)); }
    }
    if (done) g.postNews(`${this.name} rebuilds the stations of ${l.name} with longer platforms.`, 'ai');
    return done;
  }

  /** Trains waiting to be replaced by longer ones: replaced when they stand at a platform. */
  private replaceTrains() {
    const g = this.game;
    for (let i = this.relengthen.length - 1; i >= 0; i--) {
      const [tid, dep, ids] = this.relengthen[i];
      const t = g.vehicles.get(tid);
      const l = t?.line;
      if (!(t instanceof Train) || !l || l.owner !== this.companyId || !g.depots.get(dep)) { this.relengthen.splice(i, 1); continue; }
      if (t.state !== 'loading') continue;
      this.relengthen.splice(i, 1);
      const cars = ids.map((id) => MODEL_BY_ID.get(id)).filter((m): m is VehicleModel => !!m);
      const cost = cars.reduce((a, c) => a + c.cost, 0);
      if (cars.length < 2 || this.available() < cost - g.vehicles.resaleValue(t) + 500_000 || !this.borrowFor(cost)) continue;
      const nt = g.vehicles.buyTrain(dep, cars, l.id);
      if (typeof nt === 'string') continue;
      const name = t.name;
      g.vehicles.sell(t.id);
      this.stats.vehicles++; this.stats.sold++;
      this.note(`lengthened ${name} to ${cars.length - 1} coaches on ${l.name}`);
    }
  }

  /** The main track of a railway line between its end stations (our single-track chain, no platforms or depots). */
  private mainTrack(l: Line): { edges: number[]; len: number; a: Station; b: Station } | null {
    const g = this.game, net = g.world.net, me = this.companyId;
    const sts = [...new Set(l.stops)].map((id) => g.stations.get(id)).filter((s): s is Station => !!s && !!s.rail);
    if (sts.length < 2) return null;
    const a = sts[0];
    let b = sts[1], bd = 0;
    for (const s of sts) { const d = Math.hypot(s.x - a.x, s.z - a.z); if (d > bd) { bd = d; b = s; } }
    for (const eid of a.rail!.edges) {
      const e = net.edges.get(eid);
      if (!e) continue;
      for (const dir of [1, -1]) {
        const r = findRailRoute(g, railNext(g, e, dir, me), b.id, me, -1, 30000);
        if (!r) continue;
        const edges = r.conts.map((c) => c.edge).filter((x) => x.station < 0 && x.depot < 0 && x.owner === me);
        return { edges: edges.map((x) => x.id), len: edges.reduce((s, x) => s + x.len, 0), a, b };
      }
    }
    return null;
  }

  /**
   * Upgrade a busy single-track railway (trackops): a second track beside the whole main line (one-way running
   * with block signals, crossovers before the stations), else passing loops on the stretches where a parallel
   * track fits (steep curves, structures, nearby track and roads leave single-track gaps); more trains may then
   * run. A job: plans and builds in steps (each plan built in the next step).
   */
  private *doubleGen(l: Line, info: LineInfo): Generator<void, void> {
    const g = this.game, me = this.companyId, net = g.world.net;
    info.upgradeFailed = g.day;
    const m = this.mainTrack(l);
    if (!m || m.edges.length === 0) return;
    const phase = this.state.phase;
    this.state.phase = `doubling ${l.name}`;
    // each stretch between stations (a line through a hub has several); the throats (platform tracks joining the
    // main line) stay as they are: the second track starts beyond them
    const chains = this.stretches(m.edges).map((c) => this.trimThroats(c)).sort((a, b) => b.length - a.length);
    let built = 0, full = true, newLen = 0, signals = 0, crossovers = 0, err = '', why = '', plans = 0, fullParts = 0;
    const build = (pl: DoublePlan): boolean => {
      if (this.available() < pl.cost * 1.2 + 500_000 || !this.borrowFor(pl.cost)) { err = 'not enough money'; return false; }
      const res = commitDoubleTrack(g, pl);
      if (res.error) { err = res.error; return false; }
      built++;
      newLen += res.edges.reduce((s2, id) => s2 + (net.edges.get(id)?.len ?? 0), 0);
      signals += res.signals; crossovers += res.crossovers;
      if (res.finishError) err = res.finishError;
      return true;
    };
    // a plan that could not be built: the piece where it failed is the trouble
    const unbuilt = (pl: DoublePlan): DoublePlan => {
      const at = /at (\d+) m/.exec(err);
      return { ...pl, ok: false, proposals: [], errors: at ? [err, `Piece at ${at[1]} m`] : [err] };
    };
    for (const chain of chains) {
      if (err === 'not enough money' || plans >= 16) { full = false; break; }
      // the whole stretch, either side
      const whole: DoublePlan[] = [];
      let whole1 = false;
      for (const side of [1, -1] as const) {
        const pl = planDoubleTrack(g, chain, side, me);
        plans++;
        // (planning and building are separate steps: each is a few milliseconds)
        if (pl.ok) { yield; whole1 = build(pl); if (whole1 || err === 'not enough money') break; whole.push(unbuilt(pl)); }
        else { why ||= pl.errors[0] ?? ''; whole.push(pl); }
        yield;
      }
      if (whole1) { fullParts++; continue; }
      full = false;
      // else passing loops: the stretches clear of the trouble, on the side with less of it (the other side tried
      // for each stretch too); a stretch that fails is split again
      if (err !== 'not enough money' && whole.length === 2) {
        const clear = (pl: DoublePlan) => this.clearRuns(pl).reduce((s2, r) => s2 + r.length, 0);
        const order: (1 | -1)[] = clear(whole[0]) >= clear(whole[1]) ? [1, -1] : [-1, 1];
        const first = whole[order[0] === 1 ? 0 : 1];
        let queue = this.clearRuns(first);
        while (queue.length && plans < 16 && err !== 'not enough money') {
          const run = queue.shift()!;
          let done = false, failed: DoublePlan | null = null;
          for (const side of order) {
            const pl = planDoubleTrack(g, run, side, me);
            plans++;
            if (pl.ok) {
              yield;
              if (build(pl)) { done = true; break; }
              // built nothing: split where the new track could not be laid
              failed = unbuilt(pl);
              break;
            }
            if (side === order[0]) failed = pl;
          }
          yield;
          if (!done && failed) queue = [...this.clearRuns(failed), ...queue];
        }
      }
    }
    full = full && fullParts === chains.length;
    this.state.phase = phase;
    if (!built) {
      // short of money: try again in half a year
      if (err === 'not enough money') info.upgradeFailed = g.day - 540;
      this.note(`could not double ${l.name}: ${err || why}`);
      return;
    }
    info.upgradeFailed = undefined;
    if (full) info.double = true; else info.loops = (info.loops ?? 0) + built;
    // directional running with block signals takes more trains (each loop one more)
    info.maxVehicles = Math.max(info.maxVehicles, full ? (err ? 3 : 4) : Math.min(4, 2 + built));
    this.stats.doubled++;
    if (!full) this.stats.loops += built - fullParts;
    this.stats.trackDouble += newLen;
    this.stats.signals += signals;
    g.postNews(full ? `${this.name} doubles the track of ${l.name}.` : `${this.name} lays ${built > 1 ? built + ' passing loops' : 'a passing loop'} on ${l.name}.`, 'ai', (m.a.x + m.b.x) / 2, (m.a.z + m.b.z) / 2);
    this.note(`${full ? 'doubled' : `${built} passing loop${built > 1 ? 's' : ''} on`} ${l.name} (${Math.round(newLen)} u new track of ${Math.round(m.len)} u, ${signals} signals, ${crossovers} crossovers${err ? ', ' + err : ''})`);
  }

  /** A route's edges (in travel order) split into continuous stretches (between the stations it passes). */
  private stretches(edges: number[]): number[][] {
    const net = this.game.world.net;
    const out: number[][] = [];
    let cur: number[] = [];
    for (let i = 0; i < edges.length; i++) {
      const e = net.edges.get(edges[i]), f = i > 0 ? net.edges.get(edges[i - 1]) : undefined;
      if (cur.length && (!e || !f || (e.a !== f.a && e.a !== f.b && e.b !== f.a && e.b !== f.b))) { out.push(cur); cur = []; }
      if (e) cur.push(e.id);
    }
    if (cur.length) out.push(cur);
    return out;
  }

  /** A chain of edges (in order) without its throat pieces: up to the last junction within 30 units of each end. */
  private trimThroats(edges: number[]): number[] {
    const net = this.game.world.net;
    const deg = (e: NEdge, f: NEdge) => net.nodes.get(e.a === f.a || e.a === f.b ? e.a : e.b)?.edges.length ?? 0;
    let i = 0, j = edges.length - 1;
    for (let k = 0, u = 0; k + 1 < edges.length; k++) {
      const e = net.edges.get(edges[k]), f = net.edges.get(edges[k + 1]);
      if (!e || !f) break;
      u += e.len;
      if (u > 30) break;
      if (deg(e, f) >= 3) i = k + 1;
    }
    for (let k = edges.length - 1, u = 0; k - 1 >= i; k--) {
      const e = net.edges.get(edges[k]), f = net.edges.get(edges[k - 1]);
      if (!e || !f) break;
      u += e.len;
      if (u > 30) break;
      if (deg(e, f) >= 3) j = k - 1;
    }
    return j - i >= 1 ? edges.slice(i, j + 1) : edges;
  }

  /**
   * After a failed doubling plan, the stretches of its track (edge runs in chain order) clear of the trouble:
   * pieces that could not be planned, a branch on the new track's side, an end without room for the turnout,
   * a piece that could not be built; each long enough for a passing loop.
   */
  private clearRuns(pl: DoublePlan): number[][] {
    const net = this.game.world.net;
    const steps = pl.steps;
    if (steps.length < 1) return [];
    let u = 0;
    const span = steps.map((st) => { const len = net.edges.get(st.edge)?.len ?? 0; const r = { id: st.edge, len, u0: u, u1: u + len }; u += len; return r; });
    const U = u, bad: [number, number][] = [];
    const P = pl.points;
    pl.proposals.forEach((pr, k) => { if (!pr.ok && P[k] && P[k + 1]) bad.push([P[k].u, P[k + 1].u]); });
    for (const e of pl.errors) {
      const at = /(?:\(|at )(\d+) m/.exec(e);
      if (e.startsWith('No room for the turnout at the start')) bad.push([0, 28]);
      else if (e.startsWith('No room for the turnout at the end')) bad.push([U - 28, U]);
      else if (at && (e.startsWith('A branch') || e.startsWith('Piece at'))) { const x = Number(at[1]) / 10; bad.push([x - 3, x + 3]); }
    }
    if (!bad.length) return [];
    const out: number[][] = [];
    let cur: typeof span = [];
    const flush = () => {
      const len = cur.reduce((s2, x) => s2 + x.len, 0);
      // long enough for a loop that trains can pass in, and not the same stretch again
      if (len >= 40 && cur.length < steps.length) out.push(cur.map((x) => x.id));
      cur = [];
    };
    for (const sp of span) {
      if (bad.some(([a, b]) => sp.u0 < b + 1 && sp.u1 > a - 1)) { flush(); continue; }
      cur.push(sp);
    }
    flush();
    return out;
  }

  /** Signals on our track. */
  private signalCount(): number {
    let n = 0;
    for (const nd of this.game.world.net.nodes.values()) if (nd.signal && nd.owner === this.companyId) n++;
    return n;
  }

  /** Bold, active companies buy struggling rivals (never the player). */
  private considerAcquisition() {
    const g = this.game, c = this.config, e = this.eco;
    if (!g.aiAcquisitions || this.job || c.activeness < 0.9 || c.risk < 0.45 || g.day < 720 || g.day - this.lastAcq < 720) return;
    if (!this.rng.chance(0.1 * c.activeness)) return;
    for (const co of g.companies) {
      if (!co.ai || co.defunct || co.id === this.companyId) continue;
      const ce = co.economy;
      const last2 = ce.yearTotals.slice(-2);
      const losing = last2.length === 2 && last2.every((y) => Object.values(y.v).reduce((a, b) => a + b, 0) < 0);
      if (!(ce.money < 0 || ce.loan >= ce.maxLoan * 0.95 || losing)) continue;
      const price = g.buyoutPrice(co.id);
      if (price > e.money - 1_500_000 || price > this.available() * 0.5) continue;
      const name = co.name;
      if (!g.buyCompany(this.companyId, co.id)) {
        this.lastAcq = g.day;
        this.stats.acquired++;
        this.note(`bought ${name}`);
        this.adoptLines();
        return;
      }
    }
  }

  // ---------------------------------------------------------------- save / load
  toJSON(): unknown {
    const tram = this.project?.kind === 'tram' && this.tram ? tramExt(this.tram).record?.() ?? null : null;
    return {
      companyId: this.companyId,
      config: this.config,
      state: {
        ...this.state, rng: this.rng.state, failed: [...this.failed], stats: this.stats, lines: [...this.lines],
        project: this.project, lastAcq: this.lastAcq, tram, relengthen: this.relengthen,
      },
    };
  }

  load(data: any) {
    if (data?.config) this.config = normalizeAIConfig(data.config);
    const s = data?.state;
    if (!s) return;
    this.state = { phase: s.phase ?? 'idle', cooldown: s.cooldown ?? 10, projects: s.projects ?? 0 };
    if (typeof s.rng === 'number') this.rng.state = s.rng;
    if (Array.isArray(s.failed)) this.failed = new Map(s.failed);
    if (s.stats) this.stats = { ...this.stats, ...s.stats };
    if (Array.isArray(s.lines)) this.lines = new Map(s.lines);
    if (typeof s.lastAcq === 'number') this.lastAcq = s.lastAcq;
    if (Array.isArray(s.relengthen)) this.relengthen = s.relengthen.map((q: [number, number, string[]]) => [q[0], q[1], [...q[2]]]);
    // an interrupted project is cleaned up (jobs are not persisted)
    if (s.project) {
      const p: Project = {
        kind: s.project.kind, towns: s.project.towns ?? [], stations: s.project.stations ?? [], edges: s.project.edges ?? [], depots: s.project.depots ?? [],
        line: s.project.line ?? -1, started: s.project.started ?? 0, access: s.project.access ?? -1,
      };
      try {
        if (p.kind === 'tram') { if (s.tram) TramPlanner.abandon(this.game, this.companyId, s.tram); }
        else this.abandon(p);
      } catch { /* ignore */ }
      this.state.phase = 'idle';
      this.state.cooldown = 5;
    }
  }
}

// keep type imports referenced
export type { Town, Station, StationPlan, NEdge };
