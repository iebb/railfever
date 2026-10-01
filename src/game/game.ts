// The game: owns all simulation state and advances time.
import { World } from './world';
import { Towns } from './towns';
import { Stations } from './stations';
import { Lines } from './lines';
import { Vehicles } from './vehicles';
import { Depots } from './build-ops';
import { Economy, Company, COMPANY_COLORS } from './economy';
import { generateHeights, generateTrees, Hilliness, WaterAmount } from './terrain-gen';
import { DAY_SECONDS, DAYS_PER_MONTH, MONTHS_PER_YEAR, TRACK_TYPES, ROAD_TYPES } from './constants';
import { RNG } from './rng';
import { MODELS } from './vehicle-types';
import type { Vehicle } from './vehicle';
import type { Station } from './stations';
import { AIController, AI_NAMES } from './ai';

export interface NewGameOptions {
  size: number;
  seed: number;
  towns: number;
  hilliness: Hilliness;
  water: WaterAmount;
  startYear: number;
  /** number of AI competitors (0..3) */
  aiCompanies?: number;
  playerName?: string;
}

export type NewsKind = 'info' | 'good' | 'bad' | 'vehicle' | 'ai';
export interface News { day: number; text: string; kind: NewsKind; x?: number; z?: number }

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const PLAYER = 0;
const GEN_RATE = 0.0068;
const MAX_STEP = 0.05;

export class Game {
  world: World;
  towns: Towns;
  stations: Stations;
  depots: Depots;
  lines: Lines;
  vehicles: Vehicles;
  companies: Company[] = [];
  /** pseudo company for town-owned infrastructure (never shown) */
  private townCompany: Company = { id: -1, name: 'Towns', color: '#888888', ai: false, economy: new Economy() };
  ais: AIController[] = [];
  /** AI companies only build while enabled (their vehicles keep running) */
  aiEnabled = true;
  options: NewGameOptions;
  day = 0;
  dayFrac = 0;
  speed = 1;
  paused = false;
  rng: RNG;
  news: News[] = [];
  firstArrival = new Set<number>();
  /** time-of-day for the visual cycle, 0..1 */
  visualTime = 0.36;
  listeners = {
    news: [] as ((n: News) => void)[],
    income: [] as ((amount: number, v: Vehicle, st: Station) => void)[],
    network: [] as (() => void)[],
  };
  networkVersion = 0;
  private networkDirty = false;
  private lostSince = new Map<number, number>();

  constructor(opts: NewGameOptions, world?: World) {
    this.options = opts;
    this.world = world ?? new World(opts.size);
    this.rng = new RNG(opts.seed * 101 + 7);
    this.towns = new Towns(this);
    this.stations = new Stations(this);
    this.depots = new Depots(this);
    this.lines = new Lines(this);
    this.vehicles = new Vehicles(this);
    this.companies.push({ id: PLAYER, name: opts.playerName || 'Railfever Transport', color: COMPANY_COLORS[0], ai: false, economy: new Economy() });
  }

  static create(opts: NewGameOptions): Game {
    const g = new Game(opts);
    generateHeights(g.world, { seed: opts.seed, hilliness: opts.hilliness, water: opts.water });
    g.towns.generate(opts.towns, opts.seed);
    generateTrees(g.world, opts.seed);
    g.world.dirtyObj.clear();
    g.world.dirtyTerrain.clear();
    const n = Math.max(0, Math.min(3, opts.aiCompanies ?? 0));
    for (let i = 0; i < n; i++) g.addAICompany();
    g.vehicles.manageAmbient();
    g.postNews(`Welcome to Railfever! Connect the towns of this region with rail and bus lines. Press F1 for a quick guide.`, 'info');
    return g;
  }

  addAICompany(): Company {
    const id = this.companies.length;
    const co: Company = { id, name: AI_NAMES[(id - 1) % AI_NAMES.length], color: COMPANY_COLORS[id % COMPANY_COLORS.length], ai: true, economy: new Economy() };
    this.companies.push(co);
    this.ais.push(new AIController(this, id));
    return co;
  }

  company(id: number): Company { return this.companies[id] ?? this.townCompany; }
  get player(): Company { return this.companies[PLAYER]; }
  /** Player economy (shortcut for the UI) */
  get economy(): Economy { return this.companies[PLAYER].economy; }

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
    if (this.paused) return;
    let dt = Math.min(dtReal, 0.25) * this.speed;
    this.flushNetworkChanges();
    while (dt > 1e-6) {
      const step = Math.min(MAX_STEP, dt);
      this.tick(step);
      dt -= step;
    }
  }

  /** Apply pending network changes to vehicles (normally done at the start of update). */
  flushNetworkChanges() {
    if (!this.networkDirty) return;
    this.networkDirty = false;
    this.vehicles.onNetworkChanged();
    for (const v of this.vehicles.all()) if (v.state === 'running' || v.state === 'waiting' || v.state === 'noroute') v.onLineChanged();
    for (const l of this.listeners.network) l();
  }

  private tick(dt: number) {
    this.vehicles.update(dt);
    this.visualTime = (this.visualTime + dt / (DAY_SECONDS * 120)) % 1;
    this.dayFrac += dt / DAY_SECONDS;
    while (this.dayFrac >= 1) {
      this.dayFrac -= 1;
      this.day++;
      this.onNewDay();
      if (this.day % DAYS_PER_MONTH === 0) {
        this.onNewMonth();
        if (this.day % (DAYS_PER_MONTH * MONTHS_PER_YEAR) === 0) this.onNewYear();
      }
    }
    this.flushNetworkChanges();
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
    // passenger generation
    for (const st of this.stations.map.values()) {
      const table = this.lines.routing.get(st.id);
      if (!table || table.size === 0) continue;
      st.genAccum += st.catchPop * GEN_RATE * (0.2 + st.rating);
      const n = Math.floor(st.genAccum);
      if (n <= 0) continue;
      st.genAccum -= n;
      let W = 0;
      const ws: [number, number][] = [];
      for (const [d, hop] of table) {
        const ds = this.stations.get(d);
        if (!ds) continue;
        const wgt = (ds.catchPop + 25) / (1 + hop.cost / 600);
        ws.push([d, wgt]);
        W += wgt;
      }
      if (W <= 0) continue;
      let given = 0;
      for (const [d, wgt] of ws) {
        const share = (n * wgt) / W;
        let c = Math.floor(share);
        if (this.rng.next() < share - c) c++;
        if (c <= 0) continue;
        const hop = table.get(d)!;
        this.stations.addWaiting(st, hop.line, hop.alight, d, c);
        given += c;
      }
      st.genMonth += given;
      const town = this.towns.list[st.townId];
      if (town) town.passGenMonth += given;
      const cap = 600 + (st.rail ? st.rail.tracks * st.rail.length * 12 : 0) + st.stops.length * 150;
      this.stations.trimWaiting(st, cap);
    }
    // station ratings
    for (const st of this.stations.map.values()) {
      const days = this.day - st.lastPickup;
      let target = 0.33;
      target += days <= 7 ? 0.27 : days <= 14 ? 0.18 : days <= 30 ? 0.08 : 0;
      target += st.waitingTotal < 100 ? 0.15 : st.waitingTotal < 400 ? 0.08 : st.waitingTotal < 1200 ? 0 : -0.12;
      target += Math.min(0.17, Math.max(0, (st.lastSpeed - 45) / 900));
      if (!this.lines.stationServed(st.id)) target = Math.min(target, 0.5);
      st.rating += (target - st.rating) * 0.04;
      st.rating = Math.max(0, Math.min(1, st.rating));
    }
    // town growth (towns grow faster when served by frequent public transport)
    for (const town of this.towns.list) {
      if (this.day < town.nextGrowthDay) continue;
      let served = 0;
      for (const st of this.stations.map.values()) {
        if (this.day - st.lastPickup > 30 || !this.lines.stationServed(st.id)) continue;
        if (Math.hypot(st.x - town.x, st.z - town.z) <= town.radius + 10) served++;
      }
      town.served = served;
      const base = served === 0 ? 60 : served === 1 ? 26 : served === 2 ? 17 : 11;
      town.nextGrowthDay = this.day + Math.round(base * (0.7 + this.rng.next() * 0.6));
      const steps = 1 + Math.floor(town.pop / 2500) + (served > 0 ? 1 : 0);
      const before = town.pop;
      for (let i = 0; i < steps; i++) this.towns.growStep(town, this.rng, this.day);
      this.towns.recomputePop(town);
      if (Math.floor(before / 1000) < Math.floor(town.pop / 1000) && town.pop >= 2000) {
        this.postNews(`${town.name} is booming: population passes ${Math.floor(town.pop / 1000) * 1000}!`, 'good', town.x, town.z);
      }
    }
    if (this.aiEnabled) for (const ai of this.ais) ai.daily();
  }

  /** Yearly maintenance cost of a company's infrastructure. */
  maintenanceOf(owner: number): number {
    let c = 0;
    for (const e of this.world.net.edges.values()) {
      if (e.owner !== owner) continue;
      const per = e.kind === 'rail' ? (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).maintPerUnit : (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).maintPerUnit;
      c += e.len * per;
      for (const s of e.sections) c += (s.s1 - s.s0) * per * (s.type === 'tunnel' ? 4 : 3);
    }
    for (const st of this.stations.map.values()) {
      if (st.owner !== owner) continue;
      if (st.rail) c += 20000 + st.rail.tracks * st.rail.length * 500;
      c += st.stops.length * 3000;
    }
    for (const d of this.depots.map.values()) if (d.owner === owner) c += d.kind === 'rail' ? 12000 : 6000;
    return c;
  }

  private onNewMonth() {
    const pd = this.day - 1;
    const y = this.options.startYear + Math.floor(pd / (DAYS_PER_MONTH * MONTHS_PER_YEAR)), m = Math.floor(pd / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
    for (const co of this.companies) co.economy.spend(this.maintenanceOf(co.id) / 12, 'maintenance', true);
    this.vehicles.monthly();
    for (const co of this.companies) co.economy.endMonth(y, m);
    for (const st of this.stations.map.values()) {
      st.genLast = st.genMonth; st.genMonth = 0;
      st.pickupLast = st.pickupMonth; st.pickupMonth = 0;
      st.arrivedLast = st.arrivedMonth; st.arrivedMonth = 0;
    }
    for (const t of this.towns.list) {
      t.passGenLast = t.passGenMonth; t.passGenMonth = 0;
      t.passTransLast = t.passTransMonth; t.passTransMonth = 0;
    }
    for (const l of this.lines.map.values()) { l.passLast = l.passMonth; l.passMonth = 0; }
    this.stations.recomputeCatchment();
    if (this.economy.money < 0) this.postNews('Warning: your company is in debt. Take out a loan or cut costs!', 'bad');
    if (this.aiEnabled) for (const ai of this.ais) ai.monthly();
  }

  private onNewYear() {
    this.vehicles.yearly();
    for (const l of this.lines.map.values()) {
      l.incomeLast = l.incomeYear; l.costLast = l.costYear;
      l.incomeYear = 0; l.costYear = 0;
    }
    for (const co of this.companies) co.economy.endYear(this.year - 1);
    for (const m of MODELS) {
      if (m.intro === this.year) this.postNews(`New vehicle available: ${m.name} (${m.speed} km/h${m.capacity ? ', ' + m.capacity + ' passengers' : ''})`, 'vehicle');
    }
  }
}
