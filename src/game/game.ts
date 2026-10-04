// The game: owns all simulation state and advances time.
import { World } from './world';
import { Towns } from './towns';
import { Stations, entranceUpkeep, lostShare } from './stations';
import { Lines } from './lines';
import { Vehicles } from './vehicles';
import { Depots } from './build-ops';
import { Economy, Company, COMPANY_COLORS } from './economy';
import { Shares, SHARE_COUNT } from './shares';
import { generateHeights, generateTrees, Hilliness, WaterAmount } from './terrain-gen';
import { generateIntercityRoads } from './roads';
import { DAY_SECONDS, DAYS_PER_MONTH, MONTHS_PER_YEAR, TRACK_TYPES, ROAD_TYPES, TRAM, MAIL_UNIT_T } from './constants';
import { RNG } from './rng';
import { MODELS } from './vehicle-types';
import type { Vehicle } from './vehicle';
import type { Station } from './stations';
import type { RoadVehicle } from './roadvehicle';
import type { NEdge } from './network';
import { AIController, AI_NAMES, AIConfig, normalizeAIConfig } from './ai';
import { DemandModel, GEN_RATE } from './demand';
import { resolveDeadlocks, lineCongestion } from './train';
import { trackMaintenance, billTrackWear } from './opcosts';
import { MailModel } from './mail';

export interface NewGameOptions {
  size: number;
  seed: number;
  towns: number;
  hilliness: Hilliness;
  water: WaterAmount;
  startYear: number;
  /** number of AI competitors (0..7; at least as many as aiConfigs) */
  aiCompanies?: number;
  /** per-AI settings (entry i for the i-th AI company); missing entries and fields use the defaults */
  aiConfigs?: Partial<AIConfig>[];
  playerName?: string;
}

export type NewsKind = 'info' | 'good' | 'bad' | 'vehicle' | 'ai';
export interface News { day: number; text: string; kind: NewsKind; x?: number; z?: number }

/**
 * A track access agreement: `user` may run trains and trams on `owner`'s tracks, tram tracks and stations.
 * Users pay for it monthly: every item (track edge, tram tracks, station) that carried other companies' traffic
 * has its monthly maintenance split by usage (distance travelled on tracks, stops at stations), the owner's own
 * usage counting once and each user's `accessMultiplier(owner)` times (0..3, default 2). So with m = 2 and a
 * 50/50 split the user pays 2/3 of the item's maintenance; m = 0 is free; an item only others used is paid in full.
 */
export interface AccessAgreement {
  user: number;
  owner: number;
  since: number;
  /** last month: the user's share of the traffic on the owner's items it used, weighted by their maintenance (0..1) */
  usageShareLastMonth: number;
  /** fees paid for last month and in total */
  paidLastMonth: number;
  paidTotal: number;
}

export const DEFAULT_ACCESS_MULTIPLIER = 2;
export const MAX_ACCESS_MULTIPLIER = 3;

/**
 * How an owner shares its network: open (the default: every company not blocked may use it without asking; an
 * agreement for the fees is made on first use), ask (requests wait for the player; AI owners judge each case),
 * or answer every request yes / no.
 */
export type AccessPolicy = 'open' | 'ask' | 'auto-approve' | 'auto-reject';
export const ACCESS_POLICIES: AccessPolicy[] = ['open', 'ask', 'auto-approve', 'auto-reject'];
export const DEFAULT_ACCESS_POLICY: AccessPolicy = 'open';
/** A request waiting for the owner's answer (expires after ACCESS_REQUEST_DAYS: rejected). */
export interface AccessRequest { id: number; user: number; owner: number; day: number; reason?: string }
export type AccessResult = 'granted' | 'pending' | 'rejected' | 'blocked';
export const ACCESS_REQUEST_DAYS = 60;

/** Infrastructure, depots and vehicles of a company, valued at their depreciated cost. */
export interface CompanyAssets { track: number; road: number; tram: number; stations: number; depots: number; vehicles: number; total: number }

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const PLAYER = 0;
export const MAX_AI_COMPANIES = 7;
/** Infrastructure counts at this share of its replacement cost in a company's value. */
const INFRA_DEPRECIATION = 0.6;
/** Upkeep and value of elevated and underground stations relative to a ground station. */
const STATION_LEVEL_FACTOR: Record<string, number> = { ground: 1, elevated: 3, underground: 6 };
const BUYOUT_PREMIUM = 1.25;
export { GEN_RATE };
/** Every committed simulation tick advances this many seconds, at every game speed. */
export const TICK = 0.05;
export const TICKS_PER_DAY = Math.round(DAY_SECONDS / TICK);
if (Math.abs(DAY_SECONDS / TICK - TICKS_PER_DAY) > 1e-9) throw new Error('DAY_SECONDS must contain an integer number of simulation ticks');
/** Shared wall-time cap for simulation pacing, camera smoothing and visual effects. */
export const MAX_FRAME_SECONDS = 8 * TICK;
/** A frame may release fewer ticks when simulation work is expensive. */
const FRAME_BUDGET_MS = 20;

export class Game {
  world: World;
  towns: Towns;
  stations: Stations;
  depots: Depots;
  lines: Lines;
  vehicles: Vehicles;
  /** regional passenger demand (districts, OD matrix, station catchment shares) */
  demand: DemandModel;
  /** mail: posting, destinations, ratings and mail's own random stream (mail.ts) */
  mail: MailModel;
  companies: Company[] = [];
  /** Corporate shareholders, dividends and subsidiary choices. */
  shares = new Shares(this);
  /** pseudo company for town-owned infrastructure (never shown) */
  private townCompany: Company = { id: -1, name: 'Towns', color: '#888888', ai: false, economy: new Economy() };
  ais: AIController[] = [];
  /** AI companies only build while enabled (their vehicles keep running) */
  aiEnabled = true;
  /** may AI companies buy struggling rivals? */
  aiAcquisitions = true;
  /** track access agreements */
  access: AccessAgreement[] = [];
  /** may other companies sign access agreements for this company's network? (by company id; = policy is not auto-reject) */
  allowAccess: Record<number, boolean> = {};
  /** access requests waiting for an answer */
  accessRequests: AccessRequest[] = [];
  private nextRequestId = 1;
  /** answer policies of non-AI owners (AI owners keep theirs in their config) */
  private accessPolicies: Record<number, AccessPolicy> = {};
  /** per owner: companies that may not use its network nor ask */
  private blocked: Record<number, number[]> = {};
  /** access fees earned (by owner id): last month and in total */
  accessEarned: Record<number, { lastMonth: number; total: number }> = {};
  private accessKeys = new Set<number>();
  /** by owner id: 1 when its network is open (policy 'open'); blocked (owner * 4096 + user) keys (see refreshAccess) */
  private openNet = new Uint8Array(0);
  private blockedKeys = new Set<number>();
  /** v2.2 saves: their default policies become open access when the AIs are restored */
  private legacyAccess = false;
  /** weight of others' usage of a company's network (non-AI owners; AI owners keep it in their config) */
  private accessMult: Record<number, number> = {};
  /** usage this month: item key (rail edge id*4, tram tracks id*4+1, station id*4+2) -> amount by company id */
  private usage = new Map<number, number[]>();
  /** owners whose infrastructure is metered this month (they have, or had, an agreement) */
  private metered = new Set<number>();
  options: NewGameOptions;
  /** Number of committed simulation ticks (40 per game day). */
  tick = 0;
  /** Clock constants through the instance, keeping subsystem imports of Game type-only. */
  get tickSeconds() { return TICK; }
  get ticksPerDay() { return TICKS_PER_DAY; }
  get day() { return Math.floor(this.tick / TICKS_PER_DAY); }
  // Retain writable calendar properties for headless fixtures that jump to a date.
  set day(day: number) { this.tick = Math.trunc(day) * TICKS_PER_DAY + this.tick % TICKS_PER_DAY; }
  get dayFrac() { return (this.tick % TICKS_PER_DAY) / TICKS_PER_DAY; }
  set dayFrac(f: number) {
    // Direct physics fixtures accumulate seconds before setting the calendar: tolerate boundary roundoff.
    this.tick = this.day * TICKS_PER_DAY + Math.floor(Math.max(0, f) * TICKS_PER_DAY + 1e-7);
  }
  speed = 1;
  // Pause freezes the interpolation remainder and previous vehicle poses too.
  paused = false;
  /** Wall-time remainder belongs to the scheduler, never the saved simulation. */
  private accumulator = 0;
  get alpha() { return this.accumulator / TICK; }
  rng: RNG;
  news: News[] = [];
  firstArrival = new Set<number>();
  /** time-of-day for the visual cycle, 0..1 */
  get visualTime() { return (0.36 + (this.tick % (TICKS_PER_DAY * 120)) / (TICKS_PER_DAY * 120)) % 1; }
  listeners = {
    news: [] as ((n: News) => void)[],
    income: [] as ((amount: number, v: Vehicle, st: Station) => void)[],
    network: [] as (() => void)[],
  };
  networkVersion = 0;
  private networkDirty = false;
  private lostSince = new Map<number, number>();
  /** day each congested player line was last reported */
  private congestionTold = new Map<number, number>();
  private assetCache = new Map<number, { key: string; a: CompanyAssets }>();
  /** the demand model came with the save (older saves: rebuilt once the world is loaded) */
  private demandSaved = false;
  /** the monthly catchment recompute waits for the next tick */
  private deferCatchment = false;

  constructor(opts: NewGameOptions, world?: World) {
    this.options = opts;
    this.world = world ?? new World(opts.size);
    this.rng = new RNG(opts.seed * 101 + 7);
    this.towns = new Towns(this);
    this.stations = new Stations(this);
    this.depots = new Depots(this);
    this.lines = new Lines(this);
    this.vehicles = new Vehicles(this);
    this.demand = new DemandModel(this);
    this.mail = new MailModel(this);
    this.companies.push({ id: PLAYER, name: opts.playerName || 'Railfever Transport', color: COMPANY_COLORS[0], ai: false, economy: new Economy() });
    this.companies[PLAYER].code = this.freeCompanyCode(this.companies[PLAYER].name);
    this.allowAccess[PLAYER] = true;
    this.accessPolicies[PLAYER] = DEFAULT_ACCESS_POLICY;
    this.accessMult[PLAYER] = DEFAULT_ACCESS_MULTIPLIER;
    // metered usage follows edges that are split
    this.world.net.onSplit.push((old, e1, e2) => {
      for (const k of [0, 1]) {
        const u = this.usage.get(old.id * 4 + k);
        if (!u) continue;
        this.usage.delete(old.id * 4 + k);
        const f = old.len > 0 ? e1.len / old.len : 0.5;
        this.usage.set(e1.id * 4 + k, u.map((x) => x * f));
        this.usage.set(e2.id * 4 + k, u.map((x) => x * (1 - f)));
      }
    });
  }

  static create(opts: NewGameOptions): Game {
    const g = new Game(opts);
    generateHeights(g.world, { seed: opts.seed, hilliness: opts.hilliness, water: opts.water });
    g.towns.generate(opts.towns, opts.seed);
    generateIntercityRoads(g);
    generateTrees(g.world, opts.seed);
    g.demand.rebuild();
    g.world.dirtyObj.clear();
    g.world.dirtyTerrain.clear();
    g.refreshAccess();
    const n = Math.max(0, Math.min(MAX_AI_COMPANIES, Math.max(opts.aiCompanies ?? 0, opts.aiConfigs?.length ?? 0)));
    for (let i = 0; i < n; i++) g.addAICompany(opts.aiConfigs?.[i] ?? {});
    g.vehicles.manageAmbient();
    g.postNews(`Welcome to Railfever! Connect the towns of this region with rail and bus lines. Press F1 for a quick guide.`, 'info');
    return g;
  }

  /** Companies still in business (bought ones are kept for their ids but hidden). */
  get activeCompanies(): Company[] { return this.companies.filter((c) => !c.defunct); }
  canAddAI(): boolean { return this.companies.filter((c) => c.ai && !c.defunct).length < MAX_AI_COMPANIES; }

  /** Add an AI competitor (up to MAX_AI_COMPANIES active ones); throws when there are already that many. */
  addAICompany(config: Partial<AIConfig> = {}, name?: string, color?: string): Company {
    if (!this.canAddAI()) throw new Error(`At most ${MAX_AI_COMPANIES} AI companies`);
    const id = this.companies.length;
    const cfg = normalizeAIConfig(config);
    const live = this.activeCompanies;
    const usedNames = new Set(this.companies.map((c) => c.name));
    const usedColors = new Set(live.map((c) => c.color.toLowerCase()));
    const nm = name?.trim() || AI_NAMES.find((n) => !usedNames.has(n)) || `${AI_NAMES[(id - 1) % AI_NAMES.length]} ${id}`;
    const col = color || COMPANY_COLORS.slice(1).find((c) => !usedColors.has(c.toLowerCase())) || COMPANY_COLORS[1 + ((id - 1) % (COMPANY_COLORS.length - 1))];
    const economy = new Economy();
    economy.money = cfg.startMoney;
    economy.loan = Math.min(cfg.startMoney, 5_000_000);
    const co: Company = { id, name: nm, color: col, ai: true, economy, code: this.freeCompanyCode(nm) };
    this.companies.push(co);
    this.allowAccess[id] = cfg.accessPolicy !== 'auto-reject';
    this.ais.push(new AIController(this, id, cfg));
    this.refreshAccess();
    return co;
  }

  company(id: number): Company { return this.companies[id] ?? this.townCompany; }

  /** A company letter for JR-style station numbers: its initials first, then its other letters, then any free one. */
  freeCompanyCode(name: string, except = -1): string {
    const taken = new Set(this.companies.filter((c) => c.id !== except && c.code).map((c) => c.code!));
    const words = name.toUpperCase().replace(/[^A-Z]+/g, ' ').trim().split(' ').filter(Boolean);
    for (const c of [...words.map((w) => w[0]), ...words.join(''), ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ']) if (!taken.has(c)) return c;
    for (const a of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') for (const b of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') if (!taken.has(a + b)) return a + b;
    return '?';
  }
  get player(): Company { return this.companies[PLAYER]; }
  /** Player economy (shortcut for the UI) */
  get economy(): Economy { return this.companies[PLAYER].economy; }
  aiOf(id: number): AIController | undefined { return this.ais.find((a) => a.companyId === id); }

  // ------------------------------------------------------------ track access
  /** May company `user` run vehicles on infrastructure owned by `owner`? (own, public = -1, or an access agreement) */
  /** May `user` run vehicles on `owner`'s tracks and stop at its stations? (own, agreed, or open and not blocked) */
  canUse(user: number, owner: number): boolean {
    return owner === user || owner < 0 || this.accessKeys.has(user * 4096 + owner) || (this.openNet[owner] === 1 && user >= 0 && !this.blockedKeys.has(owner * 4096 + user));
  }
  hasAccess(user: number, owner: number): boolean { return this.accessKeys.has(user * 4096 + owner); }
  agreement(user: number, owner: number): AccessAgreement | undefined { return this.access.find((a) => a.user === user && a.owner === owner); }
  /** Agreements of a company: networks it uses, and companies using its network. */
  agreementsOf(id: number): { using: AccessAgreement[]; usedBy: AccessAgreement[] } {
    return { using: this.access.filter((a) => a.user === id), usedBy: this.access.filter((a) => a.owner === id) };
  }
  private rebuildAccessKeys() {
    this.accessKeys.clear();
    for (const a of this.access) this.accessKeys.add(a.user * 4096 + a.owner);
  }
  /** Open networks and blocks for canUse (after policy changes; every tick too, as the UI edits AI configs). */
  refreshAccess() {
    const n = this.companies.length;
    if (this.openNet.length !== n) this.openNet = new Uint8Array(n);
    for (let i = 0; i < n; i++) this.openNet[i] = !this.companies[i].defunct && this.accessPolicy(i) === 'open' ? 1 : 0;
    this.blockedKeys.clear();
    for (const k in this.blocked) for (const u of this.blocked[k]) this.blockedKeys.add(Number(k) * 4096 + u);
  }
  /**
   * First use of an open network: the agreement that books `user`'s usage-share fees to `owner` (no request;
   * news only when the player is involved).
   */
  private openAccess(user: number, owner: number) {
    if (user < 0 || owner < 0 || user === owner || this.accessKeys.has(user * 4096 + owner) || !this.canUse(user, owner)) return;
    const u = this.companies[user], o = this.companies[owner];
    if (!u || !o || u.defunct || o.defunct) return;
    this.access.push({ user, owner, since: this.day, usageShareLastMonth: 0, paidLastMonth: 0, paidTotal: 0 });
    this.accessKeys.add(user * 4096 + owner);
    this.metered.add(owner);
    if (owner === PLAYER) this.postNews(`${u.name} runs on your network (open access: it pays its share of the upkeep).`, 'info');
    else if (user === PLAYER) this.postNews(`You run on ${o.name}'s network (open access: you pay your share of the upkeep).`, 'info');
  }

  /** How `owner` answers access requests. */
  accessPolicy(owner: number): AccessPolicy {
    const ai = this.aiOf(owner);
    const p = ai ? ai.config.accessPolicy : this.accessPolicies[owner];
    return ACCESS_POLICIES.includes(p) ? p : DEFAULT_ACCESS_POLICY;
  }
  setAccessPolicy(owner: number, p: AccessPolicy) {
    if (!ACCESS_POLICIES.includes(p)) return;
    this.accessPolicies[owner] = p;
    const ai = this.aiOf(owner);
    if (ai) ai.config = { ...ai.config, accessPolicy: p };
    this.allowAccess[owner] = p !== 'auto-reject';
    this.refreshAccess();
    // a decision for the waiting requests
    if (p !== 'ask') for (const r of this.accessRequests.filter((q) => q.owner === owner)) p === 'auto-reject' ? this.rejectAccess(r.id) : this.approveAccess(r.id);
    this.onNetworkChanged();
  }
  isBlocked(owner: number, user: number): boolean { return !!this.blocked[owner]?.includes(user); }
  /** Companies `owner` has blocked. */
  blockedBy(owner: number): number[] { return [...(this.blocked[owner] ?? [])]; }
  /** Block `user` from `owner`'s network: its agreement ends (vehicles re-route), its requests are dropped and refused. */
  blockCompany(owner: number, user: number) {
    if (owner === user || owner < 0) return;
    const list = this.blocked[owner] ?? (this.blocked[owner] = []);
    if (!list.includes(user)) list.push(user);
    this.refreshAccess();
    this.accessRequests = this.accessRequests.filter((q) => !(q.owner === owner && q.user === user));
    if (this.hasAccess(user, owner)) this.endAccess(user, owner);
    else { this.lines.dropForeignStops(user, owner); this.onNetworkChanged(); }
  }
  unblockCompany(owner: number, user: number) {
    const list = this.blocked[owner];
    if (list) this.blocked[owner] = list.filter((x) => x !== user);
    this.refreshAccess();
    this.onNetworkChanged();
  }
  /** Requests waiting for `owner`'s answer (e.g. the player's inbox). */
  requestsTo(owner: number): AccessRequest[] { return this.accessRequests.filter((q) => q.owner === owner); }
  /** `user`'s requests still waiting for an answer. */
  requestsBy(user: number): AccessRequest[] { return this.accessRequests.filter((q) => q.user === user); }

  /** Do two companies compete: lines of both serve the same pair of towns? */
  competes(a: number, b: number): boolean {
    const pairs = new Set<number>();
    const townsOf = (l: { stops: number[] }) => [...new Set(l.stops.map((s) => this.stations.get(s)?.townId ?? -1).filter((t) => t >= 0))];
    for (const l of this.lines.map.values()) {
      if (l.owner !== b) continue;
      const t = townsOf(l);
      for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) pairs.add(Math.min(t[i], t[j]) * 4096 + Math.max(t[i], t[j]));
    }
    if (!pairs.size) return false;
    for (const l of this.lines.map.values()) {
      if (l.owner !== a) continue;
      const t = townsOf(l);
      for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) if (pairs.has(Math.min(t[i], t[j]) * 4096 + Math.max(t[i], t[j]))) return true;
    }
    return false;
  }

  /**
   * Ask for a track access agreement (`user` would run trains and trams on `owner`'s tracks and stop at its
   * stations, sharing their maintenance by usage). By the owner's policy: granted at once, refused, or (the
   * player's default, 'ask') pending until the owner approves or rejects it (or it expires). AI owners decide
   * at once: yes, unless refusing everyone, or cautious and the requester competes with them.
   */
  requestAccess(user: number, owner: number, reason?: string): AccessResult {
    if (user === owner || owner < 0) return 'rejected';
    const u = this.companies[user], o = this.companies[owner];
    if (!u || !o || u.defunct || o.defunct) return 'rejected';
    if (this.hasAccess(user, owner)) return 'granted';
    if (this.isBlocked(owner, user)) return 'blocked';
    if (this.accessRequests.some((q) => q.user === user && q.owner === owner)) return 'pending';
    const policy = this.accessPolicy(owner), ai = this.aiOf(owner);
    if (policy === 'auto-reject') return this.refused(user, owner);
    if (policy === 'open') return this.grant(user, owner);
    // AI owners answer at once: auto-approve (their default) grants everyone; set to 'ask', a cautious AI keeps
    // competitors off its tracks
    if (ai) return policy === 'ask' && ai.config.risk < 0.6 && this.competes(user, owner) ? this.refused(user, owner) : this.grant(user, owner);
    if (policy === 'auto-approve') return this.grant(user, owner);
    const q: AccessRequest = { id: this.nextRequestId++, user, owner, day: this.day };
    if (reason) q.reason = reason;
    this.accessRequests.push(q);
    if (owner === PLAYER) this.postNews(`${u.name} requests access to your tracks${reason ? ` (${reason})` : ''}.`, 'ai');
    return 'pending';
  }

  /** The owner approves a pending request (null = OK). */
  approveAccess(requestId: number): string | null {
    const q = this.accessRequests.find((r) => r.id === requestId);
    if (!q) return 'No such request';
    this.accessRequests = this.accessRequests.filter((r) => r !== q);
    const u = this.companies[q.user], o = this.companies[q.owner];
    if (!u || !o || u.defunct || o.defunct) return 'No such company';
    this.grant(q.user, q.owner);
    return null;
  }

  /** The owner rejects a pending request. */
  rejectAccess(requestId: number) {
    const q = this.accessRequests.find((r) => r.id === requestId);
    if (!q) return;
    this.accessRequests = this.accessRequests.filter((r) => r !== q);
    this.refused(q.user, q.owner);
  }

  /** Withdraw `user`'s pending request to `owner`. */
  cancelAccessRequest(user: number, owner: number) {
    this.accessRequests = this.accessRequests.filter((q) => !(q.user === user && q.owner === owner));
  }

  private grant(user: number, owner: number): 'granted' {
    if (!this.hasAccess(user, owner)) {
      this.access.push({ user, owner, since: this.day, usageShareLastMonth: 0, paidLastMonth: 0, paidTotal: 0 });
      this.rebuildAccessKeys();
      this.metered.add(owner);
      this.onNetworkChanged();
      if (user === PLAYER || owner === PLAYER) this.postNews(`${this.company(user).name} signs a track access agreement with ${this.company(owner).name}.`, 'info');
    }
    return 'granted';
  }

  private refused(user: number, owner: number): 'rejected' {
    if (user === PLAYER) this.postNews(`${this.company(owner).name} refuses you access to its tracks.`, 'bad');
    return 'rejected';
  }

  /** Daily: unanswered requests expire (rejected). */
  private expireRequests() {
    const old = this.accessRequests.filter((q) => this.day - q.day >= ACCESS_REQUEST_DAYS);
    if (!old.length) return;
    this.accessRequests = this.accessRequests.filter((q) => this.day - q.day < ACCESS_REQUEST_DAYS);
    for (const q of old) if (q.user === PLAYER) this.postNews(`Your request for access to ${this.company(q.owner).name}'s tracks expired.`, 'info');
  }

  /**
   * End an agreement (either side may): `user`'s lines lose their stops at `owner`'s stations, and its vehicles
   * re-route (or report that they have no route) without `owner`'s tracks. Null = OK.
   */
  endAccess(user: number, owner: number): string | null {
    const i = this.access.findIndex((a) => a.user === user && a.owner === owner);
    if (i < 0) return 'No agreement';
    this.access.splice(i, 1);
    this.rebuildAccessKeys();
    const stops = this.lines.dropForeignStops(user, owner);
    this.onNetworkChanged();
    if (user === PLAYER || owner === PLAYER) {
      this.postNews(`The track access agreement between ${this.company(user).name} and ${this.company(owner).name} ends${stops ? ` (${stops} stop${stops > 1 ? 's' : ''} removed from lines)` : ''}.`, 'info');
    }
    return null;
  }

  /** Open or close `owner`'s network: closing rejects all requests (policy auto-reject) and ends the agreements. */
  setAllowAccess(owner: number, allow: boolean) {
    this.setAccessPolicy(owner, allow ? 'open' : 'auto-reject');
    if (!allow) for (const a of [...this.access]) if (a.owner === owner) this.endAccess(a.user, a.owner);
  }

  /** What ending an agreement would affect: `user`'s lines with stops at `owner`'s stations, their vehicles, trains on `owner`'s track now. */
  accessImpact(user: number, owner: number): { lines: number[]; stops: number; vehicles: number; onTrack: number } {
    const lines: number[] = [];
    let stops = 0, vehicles = 0, onTrack = 0;
    for (const l of this.lines.map.values()) {
      if (l.owner !== user) continue;
      const n = l.stops.filter((s) => this.stations.get(s)?.owner === owner).length;
      if (n) { lines.push(l.id); stops += n; vehicles += l.vehicles.length; }
    }
    const net = this.world.net;
    for (const v of this.vehicles.map.values()) {
      if (v.owner !== user) continue;
      if (v.kind === 'train') { if ((v as unknown as { occupiedEdges(): number[] }).occupiedEdges().some((id) => net.edges.get(id)?.owner === owner)) onTrack++; }
      else { const s = (v as RoadVehicle).seg; const e = s ? net.edges.get(s.e) : undefined; if (e && e.tram && e.tramOwner === owner) onTrack++; }
    }
    return { lines, stops, vehicles, onTrack };
  }

  /** Weight (0..3) of other companies' usage when the maintenance of `owner`'s shared items is split. */
  accessMultiplier(owner: number): number {
    const ai = this.aiOf(owner);
    const m = ai ? ai.config.accessMultiplier : this.accessMult[owner];
    return typeof m === 'number' && m >= 0 ? Math.min(MAX_ACCESS_MULTIPLIER, m) : DEFAULT_ACCESS_MULTIPLIER;
  }
  setAccessMultiplier(owner: number, m: number) {
    const v = Math.max(0, Math.min(MAX_ACCESS_MULTIPLIER, Number.isFinite(m) ? m : DEFAULT_ACCESS_MULTIPLIER));
    this.accessMult[owner] = v;
    const ai = this.aiOf(owner);
    if (ai) ai.config = { ...ai.config, accessMultiplier: v };
  }
  /** Access fees `owner` earned last month and in total. */
  accessEarnings(owner: number): { lastMonth: number; total: number } { return this.accessEarned[owner] ?? { lastMonth: 0, total: 0 }; }
  /**
   * What `user` pays for `owner`'s infrastructure: the multiplier, the share of an item's maintenance it pays
   * when it uses the item as much as the owner (m / (1 + m)), or alone (all), and last month's actual figures.
   */
  estimateAccessShare(owner: number, user: number): { multiplier: number; equalUseShare: number; soleUserShare: number; usageShareLastMonth: number; paidLastMonth: number } {
    const m = this.accessMultiplier(owner), a = this.agreement(user, owner);
    return { multiplier: m, equalUseShare: m / (1 + m), soleUserShare: m > 0 ? 1 : 0, usageShareLastMonth: a?.usageShareLastMonth ?? 0, paidLastMonth: a?.paidLastMonth ?? 0 };
  }

  /** Metering: a vehicle of `user` travelled `units` on a rail edge (or its tram tracks). Own usage counts too. */
  recordTrackUse(user: number, e: NEdge, units: number, tram = false) {
    const owner = tram ? e.tramOwner ?? -1 : e.owner;
    if (owner < 0 || user < 0 || e.depot >= 0) return;
    if (owner !== user && !this.accessKeys.has(user * 4096 + owner)) this.openAccess(user, owner);
    if (!this.metered.has(owner)) return;
    this.addUsage(e.id * 4 + (tram ? 1 : 0), user, units);
  }
  /** Metering: a vehicle stops at a station (called when it serves the station). */
  recordStop(v: Vehicle, st: Station) {
    if (st.owner < 0 || v.owner < 0) return;
    if (st.owner !== v.owner && !this.accessKeys.has(v.owner * 4096 + st.owner)) this.openAccess(v.owner, st.owner);
    if (!this.metered.has(st.owner)) return;
    this.addUsage(st.id * 4 + 2, v.owner, 1);
  }
  private addUsage(key: number, user: number, x: number) {
    let a = this.usage.get(key);
    if (!a) { a = []; this.usage.set(key, a); }
    while (a.length <= user) a.push(0);
    a[user] += x;
  }
  /** Trams on metered tram tracks: distance sampled once a day (speed x one day). */
  private meterTrams() {
    if (!this.metered.size) return;
    const net = this.world.net;
    for (const v of this.vehicles.map.values()) {
      if (v.kind !== 'road') continue;
      const rv = v as RoadVehicle;
      if (!rv.seg || !(rv.speed > 0) || rv.model?.kind !== 'tram') continue;
      const e = net.edges.get(rv.seg.e);
      if (e && e.tram) this.recordTrackUse(v.owner, e, rv.speed * DAY_SECONDS, true);
    }
  }

  /** Yearly maintenance of one rail or road edge (as in maintenanceOf). */
  edgeMaintenance(e: NEdge): number {
    // (ops) base upkeep including overhead wire; wear by train passages is billed on top monthly
    return trackMaintenance(e);
  }
  /**
   * Yearly maintenance of a station (platforms and stops; the platform tracks count as edges): an elevated
   * station costs about 3x a ground one, an underground one about 6x; entrances added later by their kind.
   */
  stationMaintenance(st: Station): number {
    return (st.rail ? (20000 + st.rail.tracks * st.rail.length * 500) * (STATION_LEVEL_FACTOR[st.rail.level] ?? 1) + entranceUpkeep(st.rail) : 0) + st.stops.length * 3000;
  }

  /**
   * Month end: users of other companies' items pay their usage share of each item's monthly maintenance to the
   * owner. Weights: owner usage x 1, each user's usage x the owner's multiplier.
   */
  billAccess() {
    // (ops) owners pay the month's track wear; on shared track it counts towards the cost users share
    const wear = billTrackWear(this);
    for (const a of this.access) { a.usageShareLastMonth = 0; a.paidLastMonth = 0; }
    for (const k in this.accessEarned) this.accessEarned[k].lastMonth = 0;
    if (this.usage.size) {
      const net = this.world.net;
      /** per (user, owner): maintenance-weighted usage share numerator and the maintenance of the items used */
      const shares = new Map<number, { u: number; c: number }>();
      for (const [key, arr] of this.usage) {
        const id = Math.floor(key / 4), kind = key % 4;
        let owner = -1, cost = 0;
        if (kind === 2) { const st = this.stations.get(id); if (!st) continue; owner = st.owner; cost = this.stationMaintenance(st) / 12; }
        else {
          const e = net.edges.get(id);
          if (!e) continue;
          if (kind === 1) { owner = e.tramOwner ?? -1; cost = (e.len * TRAM.maintPerUnit) / 12; } else { owner = e.owner; cost = this.edgeMaintenance(e) / 12 + (wear.get(id) ?? 0); }
        }
        if (owner < 0 || !this.companies[owner] || this.companies[owner].defunct) continue;
        const uo = arr[owner] ?? 0;
        let su = 0;
        for (let i = 0; i < arr.length; i++) if (i !== owner) su += arr[i];
        if (!(su > 0)) continue;
        const m = this.accessMultiplier(owner), W = uo + m * su;
        for (let i = 0; i < arr.length; i++) {
          if (i === owner || !(arr[i] > 0)) continue;
          const k = i * 4096 + owner, sh = shares.get(k) ?? { u: 0, c: 0 };
          sh.u += (cost * arr[i]) / (uo + su); sh.c += cost;
          shares.set(k, sh);
          if (m > 0 && W > 0) this.payAccess(i, owner, (cost * m * arr[i]) / W);
        }
      }
      for (const [k, sh] of shares) {
        const a = this.agreement(Math.floor(k / 4096), k % 4096);
        if (a) a.usageShareLastMonth = sh.c > 0 ? sh.u / sh.c : 0;
      }
    }
    this.usage.clear();
    this.metered = new Set(this.access.map((a) => a.owner));
    return wear;
  }

  /** `user` pays `owner` an access fee (booked as fees / fee income). */
  private payAccess(user: number, owner: number, amount: number) {
    const payer = this.companies[user], payee = this.companies[owner];
    if (!payer || !payee || payer.defunct || !(amount > 0)) return;
    payer.economy.spend(amount, 'trackFees', true);
    payee.economy.earn(amount, 'trackIncome');
    const a = this.agreement(user, owner);
    if (a) { a.paidLastMonth += amount; a.paidTotal += amount; }
    const e = this.accessEarned[owner] ?? (this.accessEarned[owner] = { lastMonth: 0, total: 0 });
    e.lastMonth += amount; e.total += amount;
  }

  // ------------------------------------------------------------ company value and buyouts
  /** Depreciated value of a company's infrastructure and vehicles (cached for the day). */
  companyAssets(id: number): CompanyAssets {
    const key = `${this.day}:${this.networkVersion}:${this.vehicles.map.size}:${this.stations.map.size}:${this.depots.map.size}`;
    const c = this.assetCache.get(id);
    if (c && c.key === key) return c.a;
    const a: CompanyAssets = { track: 0, road: 0, tram: 0, stations: 0, depots: 0, vehicles: 0, total: 0 };
    for (const e of this.world.net.edges.values()) {
      if (e.tram && e.tramOwner === id && e.depot < 0) a.tram += e.len * TRAM.costPerUnit;
      if (e.owner !== id || e.station >= 0 || e.depot >= 0) continue;
      const per = e.kind === 'rail' ? (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).costPerUnit : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).costPerUnit;
      let v = per * e.len;
      for (const s of e.sections) v += (s.s1 - s.s0) * per * (s.type === 'tunnel' ? 8 : 5);
      if (e.kind === 'rail') a.track += v; else a.road += v;
    }
    for (const st of this.stations.map.values()) {
      if (st.owner !== id) continue;
      // what it cost to build (older saves: an estimate by size and level)
      if (st.rail) a.stations += st.rail.cost ?? (st.rail.tracks * st.rail.length * 9000 + 120000) * (STATION_LEVEL_FACTOR[st.rail.level] ?? 1);
      a.stations += st.stops.length * 30000;
    }
    for (const d of this.depots.map.values()) if (d.owner === id) a.depots += d.kind === 'rail' ? 90000 : d.kind === 'road' ? 60000 : 120000;
    a.track *= INFRA_DEPRECIATION; a.road *= INFRA_DEPRECIATION; a.tram *= INFRA_DEPRECIATION;
    a.stations *= INFRA_DEPRECIATION; a.depots *= INFRA_DEPRECIATION;
    for (const v of this.vehicles.map.values()) if (v.owner === id) a.vehicles += this.vehicles.resaleValue(v);
    a.total = a.track + a.road + a.tram + a.stations + a.depots + a.vehicles;
    this.assetCache.set(id, { key, a });
    return a;
  }

  /** Net worth: cash − loan + depreciated assets (track, roads, tram tracks, stations, depots, vehicles). */
  companyValue(id: number): number {
    const co = this.companies[id];
    if (!co || co.defunct) return 0;
    return co.economy.money - co.economy.loan + this.companyAssets(id).total;
  }

  /** Buyout/share valuation before purchase premiums: net assets plus two years of positive profit. */
  acquisitionValue(id: number): number {
    const co = this.companies[id];
    if (!co || co.defunct) return 0;
    const value = this.companyValue(id) + Math.max(0, co.economy.lastYearProfit) * 2;
    const floor = 500_000 + this.companyAssets(id).total * 0.15;
    return Math.max(value, floor / BUYOUT_PREMIUM);
  }

  /** Price to buy a company: its valuation with a premium; at least the existing buyout floor. */
  buyoutPrice(id: number): number {
    return Math.round(this.acquisitionValue(id) * BUYOUT_PREMIUM / 1000) * 1000;
  }

  /** Why `buyer` cannot buy `target` now, or null. */
  canBuy(buyer: number, target: number): string | null {
    const b = this.companies[buyer], t = this.companies[target];
    if (!b || !t || b.defunct || t.defunct) return 'No such company';
    if (buyer === target) return 'A company cannot buy itself';
    if (target === PLAYER || !t.ai) return `${t.name} is not for sale`;
    const shares = this.shares.canBuyout(buyer, target);
    if (shares) return shares;
    if (this.shares.shareCount(buyer, target) === SHARE_COUNT) return null; // already paid for control
    const price = this.buyoutPrice(target);
    if (b.economy.money < price) return `Not enough money (the price is $${Math.round(price).toLocaleString('en-US')})`;
    return null;
  }

  /**
   * `buyer` buys `target`: pays the buyout price, takes over its cash and loan and all its assets (track, tram
   * tracks, roads, nodes, stations, depots, lines, vehicles) and its access agreements; the target becomes
   * defunct. Vehicles keep running (reservations are by vehicle id). Null = OK, else the reason.
   */
  buyCompany(buyer: number, target: number): string | null {
    const err = this.canBuy(buyer, target);
    if (err) return err;
    if (this.shares.shareCount(buyer, target) === SHARE_COUNT) return this.mergeCompany(buyer, target);
    const price = this.buyoutPrice(target);
    this.companies[buyer].economy.spend(price, 'acquisition');
    this.shares.recordBuyout(buyer, target);
    return this.mergeOwnedCompany(buyer, target, price);
  }

  /** Merge an already wholly owned company, including a subsidiary, without buying its stock again. */
  mergeCompany(buyer: number, target: number): string | null {
    return this.mergeOwnedCompany(buyer, target);
  }

  private mergeOwnedCompany(buyer: number, target: number, price?: number): string | null {
    const err = this.shares.canMerge(buyer, target);
    if (err) return err;
    const b = this.companies[buyer], t = this.companies[target];
    // the target's AI stops (a half-built project is removed first)
    for (const ai of this.ais) if (ai.companyId === target) ai.dispose();
    this.ais = this.ais.filter((a) => a.companyId !== target);
    // The shares are already paid for; take over cash, loan and stakes in other companies.
    const be = b.economy, te = t.economy;
    if (te.money >= 0) be.earn(te.money, 'acquisition'); else be.spend(-te.money, 'acquisition', true);
    be.loan += te.loan;
    te.money = 0; te.loan = 0;
    this.shares.onMerge(buyer, target);
    // assets
    const w = this.world, net = w.net;
    for (const e of net.edges.values()) {
      let hit = false;
      if (e.owner === target) { e.owner = buyer; hit = true; }
      if (e.tramOwner === target) { e.tramOwner = buyer; hit = true; }
      if (hit) net.markEdge(e);
    }
    for (const n of net.nodes.values()) if (n.owner === target) n.owner = buyer;
    for (const st of this.stations.map.values()) {
      if (st.owner !== target) continue;
      st.owner = buyer;
      w.markObjArea(st.x - 20, st.z - 20, st.x + 20, st.z + 20);
      if (buyer === PLAYER) this.firstArrival.add(st.id);
    }
    for (const d of this.depots.map.values()) if (d.owner === target) { d.owner = buyer; w.markObjArea(d.x - 4, d.z - 4, d.x + 4, d.z + 4); }
    const tp = t.name.split(' ')[0] + ' ', bp = buyer === PLAYER ? '' : b.name.split(' ')[0] + ' ';
    for (const v of this.vehicles.map.values()) {
      if (v.owner !== target) continue;
      v.owner = buyer;
      if (v.name.startsWith(tp)) v.name = bp + v.name.slice(tp.length);
    }
    for (const l of this.lines.map.values()) if (l.owner === target) this.lines.transfer(l, buyer);
    // lines the target ran with others: the buyer runs them now
    for (const l of this.lines.map.values()) if (l.operators?.includes(target)) l.operators = [...new Set(l.operators.map((o) => (o === target ? buyer : o)))].filter((o) => o !== l.owner);
    // agreements: the buyer steps into the target's place (no agreements with itself, no duplicates)
    const merged: AccessAgreement[] = [];
    for (const a of this.access) {
      const m = { ...a, user: a.user === target ? buyer : a.user, owner: a.owner === target ? buyer : a.owner };
      if (m.user === m.owner) continue;
      const dup = merged.find((x) => x.user === m.user && x.owner === m.owner);
      if (dup) { dup.paidTotal += m.paidTotal; dup.paidLastMonth += m.paidLastMonth; dup.since = Math.min(dup.since, m.since); } else merged.push(m);
    }
    this.access = merged;
    this.rebuildAccessKeys();
    // metered usage this month: the target's traffic is the buyer's now
    for (const u of this.usage.values()) {
      if (!(u[target] > 0)) continue;
      while (u.length <= buyer) u.push(0);
      u[buyer] += u[target];
      u[target] = 0;
    }
    if (this.metered.delete(target)) this.metered.add(buyer);
    this.accessRequests = this.accessRequests.filter((q) => q.user !== target && q.owner !== target);
    delete this.blocked[target];
    for (const k in this.blocked) this.blocked[k] = this.blocked[k].filter((x) => x !== target);
    const te2 = this.accessEarned[target];
    if (te2) { const be2 = this.accessEarned[buyer] ?? (this.accessEarned[buyer] = { lastMonth: 0, total: 0 }); be2.total += te2.total; delete this.accessEarned[target]; }
    t.defunct = true;
    t.boughtBy = buyer;
    this.assetCache.clear();
    this.lostSince.clear();
    this.lines.rebuild();
    this.onNetworkChanged();
    this.postNews(price !== undefined
      ? `${b.name} buys ${t.name} for $${(price / 1e6).toFixed(2)}M and takes over its network.`
      : `${b.name} merges ${t.name} and takes over its network.`, buyer === PLAYER ? 'good' : 'ai');
    return null;
  }

  // ------------------------------------------------------------ calendar
  get year() { return this.options.startYear + Math.floor(this.day / (DAYS_PER_MONTH * MONTHS_PER_YEAR)); }
  get month() { return Math.floor(this.day / DAYS_PER_MONTH) % MONTHS_PER_YEAR; }
  get dayOfMonth() { return (this.day % DAYS_PER_MONTH) + 1; }
  dateString() { return `${this.dayOfMonth} ${MONTH_NAMES[this.month]} ${this.year}`; }

  // ------------------------------------------------------------ events
  postNews(text: string, kind: NewsKind = 'info', x?: number, z?: number) {
    const n: News = { day: this.day, text, kind, x, z };
    this.news.push(n);
    if (this.news.length > 100) this.news.shift();
    for (const l of this.listeners.news) l(n);
  }

  onIncome(amount: number, v: Vehicle, st: Station) {
    for (const l of this.listeners.income) l(amount, v, st);
    if (v.owner === PLAYER && !this.firstArrival.has(st.id) && v.kind === 'train') {
      this.firstArrival.add(st.id);
      this.postNews(`Citizens celebrate! The first train arrives at ${st.name}.`, 'good', st.x, st.z);
    }
  }

  onNetworkChanged() { this.networkDirty = true; this.networkVersion++; }

  // ------------------------------------------------------------ simulation
  update(dtReal: number) {
    if (this.paused) {
      // Construction and policy edits still take effect while simulation time is stopped.
      this.refreshAccess();
      this.flushNetworkChanges();
      this.lines.flushCatchment();
      return;
    }
    if (!Number.isFinite(dtReal) || dtReal <= 0 || !Number.isFinite(this.speed) || this.speed <= 0) return;
    this.accumulator += Math.min(dtReal, MAX_FRAME_SECONDS) * this.speed;
    // A tiny tolerance prevents floating wall-time sums (e.g. three 1/60 frames) losing a whole tick.
    const ticks = Math.floor((this.accumulator + TICK * 1e-9) / TICK);
    // Keep only the fractional tick, even if the budget drops some of this frame's whole ticks.
    this.accumulator = Math.max(0, this.accumulator - ticks * TICK);
    const started = performance.now();
    for (let i = 0; i < ticks && !this.paused; i++) {
      this.stepTick();
      // Wall time controls release rate only; stepTick never reads this pacing clock.
      if (performance.now() - started >= FRAME_BUDGET_MS) break;
    }
  }

  /** Apply pending network changes to vehicles (normally done at the start of a tick). */
  flushNetworkChanges() {
    if (!this.networkDirty) return;
    this.networkDirty = false;
    this.vehicles.onNetworkChanged();
    // lost vehicles re-plan at once, the others are staggered over the next ticks (no hitch)
    this.vehicles.replanAfterNetworkChange();
    // Commit road access at this fixed simulation/construction boundary, before catchments and mail use it.
    this.stations.refreshAccess();
    for (const l of this.listeners.network) l();
  }

  /** Advance exactly one simulation tick. Wall time, speed and pause are handled by update(). */
  stepTick() {
    this.deferCatchment = false;
    this.refreshAccess();
    this.lines.flushCatchment();
    this.flushNetworkChanges();
    this.vehicles.update(TICK);
    const tickOfDay = this.tick % TICKS_PER_DAY;
    // Finish this day's work before daily decisions can start a project for the next day.
    if (this.aiEnabled) for (const ai of [...this.ais]) ai.work(tickOfDay, tickOfDay + 1);
    this.tick++;
    if (this.tick % TICKS_PER_DAY === 0) {
      this.onNewDay();
      // trains in a circle of mutual waiting: one of them takes another way (every few days)
      if (this.day % 3 === 0) resolveDeadlocks(this);
      if (this.day % DAYS_PER_MONTH === 0) {
        this.onNewMonth();
        if (this.day % (DAYS_PER_MONTH * MONTHS_PER_YEAR) === 0) this.onNewYear();
      }
    }
    this.flushNetworkChanges();
    if (!this.deferCatchment) this.lines.flushCatchment();
  }

  private checkLost() {
    for (const v of this.vehicles.map.values()) {
      if (v.owner !== PLAYER || v.state !== 'noroute') { this.lostSince.delete(v.id); continue; }
      const since = this.lostSince.get(v.id);
      if (since === undefined) this.lostSince.set(v.id, this.day);
      else if (since >= 0 && this.day - since > 20) {
        this.lostSince.set(v.id, -1);
        const p = { x: 0, y: 0, z: 0 };
        v.worldPos(p);
        this.postNews(`${v.name} is lost: ${v.status.toLowerCase()}. Check the line's track or roads.`, 'bad', p.x, p.z);
      }
    }
  }

  private onNewDay() {
    this.checkLost();
    this.meterTrams();
    this.demand.daily();
    this.stations.daily();
    if (this.accessRequests.length) this.expireRequests();
    // passenger generation: a station's residents travel to the regions the network reaches, as the regional
    // demand says (local and long-distance trips, scaled by the trip factor of the service: demand.ts weights); its
    // rate is their sum (a station reaching more of its demand, by better services, generates more)
    for (const st of this.stations.map.values()) {
      const table = this.lines.routing.get(st.id);
      if (!table || table.size === 0) continue;
      const dw = this.demand.weights(st);
      if (!(dw.served > 0)) continue;
      // fewer set out where many gave up waiting lately (they saw full vehicles and long queues; OpenTTD's ratings
      // do likewise): the station's rating, and directly the share who gave up this and last month
      st.genAccum += this.demand.generationPopulation(st) * GEN_RATE * (0.2 + st.rating) * dw.served * (1 - lostShare(st));
      const n = Math.floor(st.genAccum);
      if (n <= 0) continue;
      st.genAccum -= n;
      let given = 0;
      for (let i = 0; i < dw.dest.length; i++) {
        const share = (n * dw.w[i]) / dw.served;
        let c = Math.floor(share);
        if (this.rng.next() < share - c) c++;
        if (c <= 0) continue;
        const d = dw.dest[i], hop = table.get(d);
        if (!hop) continue;
        this.lines.distribute(hop, c, (line, k) => this.stations.addWaiting(st, line, hop.alight, d, k));
        given += c;
      }
      st.genMonth += given;
      const town = this.towns.list[st.townId];
      if (town) town.passGenMonth += given;
      const cap = 600 + (st.rail ? st.rail.tracks * st.rail.length * 12 : 0) + st.stops.length * 150;
      this.stations.trimWaiting(st, cap);
    }
    // mail: posting at the stations a mail line serves, queues trimmed, mail ratings (its own random stream)
    this.mail.daily();
    // station ratings (and service frequency), then town growth paced by the towns' public transport (towns.ts)
    this.stations.updateRatings();
    this.towns.daily();
    // AI: daily decisions; the monthly management on a day of its own per company (spreads the work)
    if (this.aiEnabled) for (const ai of [...this.ais]) {
      ai.daily();
      if (this.day % DAYS_PER_MONTH === (ai.companyId * 7) % DAYS_PER_MONTH) ai.monthly();
    }
  }

  /** Yearly maintenance cost of a company's infrastructure. */
  maintenanceOf(owner: number): number {
    let c = 0;
    for (const e of this.world.net.edges.values()) {
      if (e.tram && e.tramOwner === owner && e.depot < 0) c += e.len * TRAM.maintPerUnit;
      if (e.owner === owner) c += this.edgeMaintenance(e);
    }
    for (const st of this.stations.map.values()) if (st.owner === owner) c += this.stationMaintenance(st);
    for (const d of this.depots.map.values()) if (d.owner === owner) c += d.kind === 'rail' ? 12000 : d.kind === 'road' ? 6000 : 9000;
    return c;
  }

  /** The player's congested railway lines: a news item with what would help (at most twice a year per line). */
  private congestionNews() {
    for (const l of this.lines.map.values()) {
      if (l.owner !== PLAYER || l.kind !== 'rail' || l.vehicles.length < 2) continue;
      const c = lineCongestion(this, l.id);
      if (c.level < 2 || this.day - (this.congestionTold.get(l.id) ?? -1e9) < 180) continue;
      this.congestionTold.set(l.id, this.day);
      const fix = { signals: 'signals on the line', platforms: 'more platforms at the stations where trains wait', loops: 'passing loops on the single track', double: 'a second track', 'fewer-trains': 'fewer trains', none: '' }[c.suggestion];
      const st = this.stations.get(l.stops[0]);
      const p = { x: st?.x ?? this.world.size / 2, y: 0, z: st?.z ?? this.world.size / 2 };
      const waiting = l.vehicles.map((id) => this.vehicles.get(id)).find((v) => v?.state === 'waiting');
      waiting?.worldPos(p);
      this.postNews(`${l.name} is congested: ${c.waits} train${c.waits === 1 ? '' : 's'} waiting for a free path${c.deadlock ? ' (stuck)' : ''}.${fix ? ' Suggested: ' + fix + '.' : ''}`, 'bad', p.x, p.z);
    }
  }

  private onNewMonth() {
    this.congestionNews();
    const pd = this.day - 1;
    const y = this.options.startYear + Math.floor(pd / (DAYS_PER_MONTH * MONTHS_PER_YEAR)), m = Math.floor(pd / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
    for (const co of this.companies) if (!co.defunct) co.economy.spend(this.maintenanceOf(co.id) / 12, 'maintenance', true);
    this.vehicles.monthly();
    const wear = this.billAccess();
    for (const ai of this.ais) ai.railPolicy.monthEnd(wear);
    for (const co of this.companies) if (!co.defunct) co.economy.endMonth(y, m);
    for (const st of this.stations.map.values()) {
      st.genLast = st.genMonth; st.genMonth = 0;
      st.pickupLast = st.pickupMonth; st.pickupMonth = 0;
      st.arrivedLast = st.arrivedMonth; st.arrivedMonth = 0;
      st.lostLast = st.lostMonth || 0; st.lostMonth = 0;
    }
    for (const t of this.towns.list) {
      t.passGenLast = t.passGenMonth; t.passGenMonth = 0;
      t.passTransLast = t.passTransMonth; t.passTransMonth = 0;
      t.passLostLast = t.passLostMonth ?? 0; t.passLostMonth = 0;
    }
    for (const l of this.lines.map.values()) { l.passLast = l.passMonth; l.passMonth = 0; }
    this.mail.monthly();
    // catchments are shared out again at the start of the next tick (not on top of the month's other work)
    if (this.stations.catchmentInputsChanged()) this.lines.catchmentDirty = true;
    this.lines.markDemandSharesDirty();
    this.deferCatchment = true;
    if (this.economy.money < 0 && m % 3 === 2) this.postNews('Warning: your company is in debt. Take out a loan or cut costs!', 'info');
  }

  private onNewYear() {
    this.vehicles.yearly();
    for (const l of this.lines.map.values()) {
      l.incomeLast = l.incomeYear; l.costLast = l.costYear;
      l.incomeYear = 0; l.costYear = 0;
    }
    this.mail.yearly();
    this.shares.payDividends(this.year - 1);
    for (const co of this.companies) if (!co.defunct) {
      // Month end has already closed December. Attribute the distribution to that month and year.
      const e = co.economy, december = e.months[e.months.length - 1];
      if (december?.year === this.year - 1 && december.month === MONTHS_PER_YEAR - 1) {
        december.v.dividends += e.current.dividends;
        e.current.dividends = 0;
      }
      e.endYear(this.year - 1);
    }
    for (const m of MODELS) {
      if (m.intro === this.year) this.postNews(`New vehicle available: ${m.name} (${m.speed} km/h${m.capacity ? ', ' + m.capacity + ' passengers' : ''}${m.mail ? ', ' + +(m.mail * MAIL_UNIT_T).toFixed(1) + ' t of mail' : ''})`, 'vehicle');
    }
  }

  // ------------------------------------------------------------ save / load (companies, AI, access)
  /** Company state for a save game (see save.ts). */
  saveCompanies() {
    return {
      companies: this.companies.map((c) => ({
        id: c.id, name: c.name, color: c.color, ai: c.ai, defunct: !!c.defunct, boughtBy: c.boughtBy ?? -1, code: c.code ?? '',
        economy: JSON.parse(JSON.stringify(c.economy)),
      })),
      ais: this.ais.map((a) => a.toJSON()),
      access: this.access.map((a) => ({ ...a })),
      allowAccess: { ...this.allowAccess },
      accessMult: { ...this.accessMult },
      accessEarned: JSON.parse(JSON.stringify(this.accessEarned)),
      accessUsage: [...this.usage].map(([k, u]) => [k, [...u]]),
      accessMetered: [...this.metered],
      aiAcquisitions: this.aiAcquisitions,
      accessRequests: this.accessRequests.map((q) => ({ ...q })),
      nextAccessRequest: this.nextRequestId,
      accessPolicies: { ...this.accessPolicies },
      accessBlocked: JSON.parse(JSON.stringify(this.blocked)),
      // 2: open access is the default policy (v2.3)
      accessVersion: 2,
      // a catchment recompute still pending (e.g. saved right after a buyout) happens in the loaded game too
      catchmentDirty: this.lines.catchmentDirty,
      demand: this.demand.toJSON(),
    };
  }

  /** Restore companies and agreements (before the rest of the world; AI states come last, see restoreAIs). */
  restoreCompanies(d: any) {
    this.companies = ((d.companies ?? []) as any[]).map((c) => {
      const co: Company = { id: c.id, name: c.name, color: c.color, ai: !!c.ai, economy: Economy.fromJSON(c.economy) };
      if (c.defunct) co.defunct = true;
      if (typeof c.boughtBy === 'number' && c.boughtBy >= 0) co.boughtBy = c.boughtBy;
      if (typeof c.code === 'string' && c.code) co.code = c.code;
      return co;
    });
    // older saves: letters by name, in company order
    for (const co of this.companies) if (!co.code) co.code = this.freeCompanyCode(co.name, co.id);
    this.allowAccess = {};
    for (const c of this.companies) this.allowAccess[c.id] = true;
    if (d.allowAccess) for (const [k, v] of Object.entries(d.allowAccess)) this.allowAccess[Number(k)] = !!v;
    this.access = ((d.access ?? []) as any[]).map((a) => ({
      user: a.user, owner: a.owner, since: a.since ?? 0,
      usageShareLastMonth: a.usageShareLastMonth ?? 0, paidLastMonth: a.paidLastMonth ?? 0, paidTotal: a.paidTotal ?? a.paid ?? 0,
    }));
    this.rebuildAccessKeys();
    this.accessMult = {};
    for (const c of this.companies) if (!c.ai) this.accessMult[c.id] = DEFAULT_ACCESS_MULTIPLIER;
    if (d.accessMult) for (const [k, v] of Object.entries(d.accessMult)) this.accessMult[Number(k)] = Number(v);
    this.accessEarned = {};
    if (d.accessEarned) for (const [k, v] of Object.entries(d.accessEarned as Record<string, { lastMonth: number; total: number }>)) this.accessEarned[Number(k)] = { lastMonth: v.lastMonth ?? 0, total: v.total ?? 0 };
    this.usage = new Map(((d.accessUsage ?? []) as [number, number[]][]).map(([k, u]) => [k, u.map((x) => Number(x) || 0)]));
    this.metered = new Set(d.accessMetered ?? this.access.map((a) => a.owner));
    this.aiAcquisitions = d.aiAcquisitions ?? true;
    this.demandSaved = !!d.demand && this.demand.load(d.demand);
    this.accessRequests = ((d.accessRequests ?? []) as AccessRequest[]).map((q) => ({ ...q }));
    this.nextRequestId = d.nextAccessRequest ?? this.accessRequests.reduce((m, q) => Math.max(m, q.id + 1), 1);
    // v2.2 saves: their default policies (the player's 'ask', the AIs' 'auto-approve') become open access
    this.legacyAccess = (d.accessVersion ?? 1) < 2;
    const migrate = (p: AccessPolicy): AccessPolicy => (this.legacyAccess && (p === 'ask' || p === 'auto-approve') ? 'open' : p);
    this.accessPolicies = {};
    for (const c of this.companies) if (!c.ai) this.accessPolicies[c.id] = this.allowAccess[c.id] === false ? 'auto-reject' : DEFAULT_ACCESS_POLICY;
    if (d.accessPolicies) for (const [k, v] of Object.entries(d.accessPolicies)) if (ACCESS_POLICIES.includes(v as AccessPolicy)) this.accessPolicies[Number(k)] = migrate(v as AccessPolicy);
    this.blocked = {};
    if (d.accessBlocked) for (const [k, v] of Object.entries(d.accessBlocked as Record<string, number[]>)) this.blocked[Number(k)] = [...v];
    this.ais = [];
    this.refreshAccess();
  }

  /** Restore the AI controllers once stations, lines and vehicles exist (an interrupted project is cleaned up). */
  restoreAIs(d: any) {
    if (!this.demandSaved) { this.demand.rebuild(); this.demand.recomputeShares(); this.demandSaved = true; }
    this.ais = [];
    for (const c of this.companies) {
      if (!c.ai || c.defunct) continue;
      const data = ((d.ais ?? []) as any[]).find((a) => a && a.companyId === c.id);
      const ai = new AIController(this, c.id, data?.config);
      if (data) { try { ai.load(data); } catch (e) { console.warn('AI state could not be restored', e); } }
      if (this.legacyAccess && ai.config.accessPolicy === 'auto-approve') ai.config = { ...ai.config, accessPolicy: 'open' };
      this.ais.push(ai);
    }
    this.legacyAccess = false;
    this.refreshAccess();
  }
}
