// The game: owns all simulation state and advances time.
import { World } from './world';
import { Towns } from './towns';
import { Stations } from './stations';
import { Lines } from './lines';
import { Vehicles } from './vehicles';
import { Economy, COSTS } from './economy';
import { generateHeights, generateTrees, Hilliness, WaterAmount } from './terrain-gen';
import { DAY_SECONDS, DAYS_PER_MONTH, MONTHS_PER_YEAR } from './constants';
import { RNG } from './rng';
import { MODELS } from './vehicle-types';
import type { Vehicle } from './vehicle';
import type { Station } from './stations';
import { clearGeomCaches } from './geom';

export interface NewGameOptions {
  size: number;
  seed: number;
  towns: number;
  hilliness: Hilliness;
  water: WaterAmount;
  startYear: number;
}

export type NewsKind = 'info' | 'good' | 'bad' | 'vehicle';
export interface News { day: number; text: string; kind: NewsKind; x?: number; z?: number }

export const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const GEN_RATE = 0.0068;
const MAX_STEP = 0.05;

export class Game {
  world: World;
  towns: Towns;
  stations: Stations;
  lines: Lines;
  vehicles: Vehicles;
  economy = new Economy();
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
  private networkDirty = false;

  constructor(opts: NewGameOptions, world?: World) {
    this.options = opts;
    this.world = world ?? new World(opts.size);
    this.rng = new RNG(opts.seed * 101 + 7);
    this.towns = new Towns(this.world);
    this.stations = new Stations(this);
    this.lines = new Lines(this);
    this.vehicles = new Vehicles(this);
  }

  static create(opts: NewGameOptions): Game {
    clearGeomCaches();
    const g = new Game(opts);
    generateHeights(g.world, { seed: opts.seed, hilliness: opts.hilliness, water: opts.water });
    g.towns.generate(opts.towns, opts.seed);
    generateTrees(g.world, opts.seed);
    // everything is freshly built: mark all chunks dirty
    g.world.dirtyObj.clear();
    g.world.dirtyTerrain.clear();
    g.vehicles.manageAmbient();
    g.postNews(`Welcome to Railfever! Connect the towns of this region with rail and bus lines. Press F1 for a quick guide.`, 'info');
    return g;
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
    if (!this.firstArrival.has(st.id) && v.kind === 'train') {
      this.firstArrival.add(st.id);
      this.postNews(`Citizens celebrate! The first train arrives at ${st.name}.`, 'good', st.x, st.z);
    }
  }
  isTileBusy(t: number) { return this.vehicles.isTileBusy(t); }
  networkVersion = 0;
  onNetworkChanged() { this.networkDirty = true; this.networkVersion++; }

  // ------------------------------------------------------------ simulation
  update(dtReal: number) {
    if (this.paused) return;
    let dt = Math.min(dtReal, 0.25) * this.speed;
    if (this.networkDirty) {
      this.networkDirty = false;
      for (const v of this.vehicles.all()) if (v.state === 'running' || v.state === 'waiting' || v.state === 'noroute') v.onLineChanged();
      for (const a of this.vehicles.ambient) a.route = [];
      this.vehicles.pruneAmbient();
      for (const l of this.listeners.network) l();
    }
    while (dt > 1e-6) {
      const step = Math.min(MAX_STEP, dt);
      this.tick(step);
      dt -= step;
    }
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
  }

  private lostSince = new Map<number, number>();

  private checkLost() {
    for (const v of this.vehicles.map.values()) {
      if (v.state !== 'noroute') { this.lostSince.delete(v.id); continue; }
      const since = this.lostSince.get(v.id);
      if (since === undefined) this.lostSince.set(v.id, this.day);
      else if (since >= 0 && this.day - since > 20) {
        this.lostSince.set(v.id, -1);
        const p = { x: 0, y: 0, z: 0 };
        v.worldPos(p);
        this.postNews(`${v.name} is lost: ${v.status.toLowerCase()}. Check the line's track or roads.`, 'bad', Math.floor(p.x), Math.floor(p.z));
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
        const wgt = (ds.catchPop + 25) / (1 + hop.cost / 140);
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
      this.stations.trimWaiting(st, 2500 + st.tiles.length * 150);
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
    // town growth
    for (const town of this.towns.list) {
      if (this.day < town.nextGrowthDay) continue;
      let served = 0;
      for (const st of this.stations.map.values()) {
        if (this.day - st.lastPickup > 30 || !this.lines.stationServed(st.id)) continue;
        if (Math.hypot(st.x - town.x, st.z - town.z) <= town.radius + 4) served++;
      }
      town.served = served;
      const base = served === 0 ? 70 : served === 1 ? 28 : served === 2 ? 18 : 12;
      town.nextGrowthDay = this.day + Math.round(base * (0.7 + this.rng.next() * 0.6));
      const steps = 1 + Math.floor(town.pop / 2500) + (served > 0 ? 1 : 0);
      for (let i = 0; i < steps; i++) this.towns.growStep(town, this.rng, this.day);
      const before = town.pop;
      this.towns.recomputePop(town);
      if (Math.floor(before / 1000) < Math.floor(town.pop / 1000) && town.pop >= 2000) {
        this.postNews(`${town.name} is booming: population passes ${Math.floor(town.pop / 1000) * 1000}!`, 'good', town.x, town.z);
      }
    }
  }

  private onNewMonth() {
    // the month that just ended
    const pd = this.day - 1;
    const y = this.options.startYear + Math.floor(pd / (DAYS_PER_MONTH * MONTHS_PER_YEAR)), m = Math.floor(pd / DAYS_PER_MONTH) % MONTHS_PER_YEAR;
    // infrastructure maintenance
    const w = this.world;
    let rail = 0, road = 0, stn = 0, span = 0;
    const n = w.size * w.size;
    for (let t = 0; t < n; t++) {
      if (w.rail[t]) rail += w.pieceCount(t);
      if (w.road[t] && w.roadOwner[t] === 2) road++;
      if (w.station[t] >= 0) stn++;
    }
    for (const s of w.structures.values()) span += s.span;
    const maint = (rail * COSTS.maintRailPerTile + road * COSTS.maintRoadPerTile + stn * COSTS.maintStationPerTile + span * COSTS.maintStructurePerTile) / 12;
    this.economy.spend(maint, 'maintenance', true);
    this.vehicles.monthly();
    this.economy.endMonth(y, m);
    for (const st of this.stations.map.values()) {
      st.genLast = st.genMonth; st.genMonth = 0;
      st.pickupLast = st.pickupMonth; st.pickupMonth = 0;
      st.arrivedLast = st.arrivedMonth; st.arrivedMonth = 0;
    }
    for (const t of this.towns.list) {
      t.passGenLast = t.passGenMonth; t.passGenMonth = 0;
      t.passTransLast = t.passTransMonth; t.passTransMonth = 0;
      this.towns.compactRoads(t);
    }
    for (const l of this.lines.map.values()) { l.passLast = l.passMonth; l.passMonth = 0; }
    this.stations.recomputeCatchment();
    if (this.economy.money < 0) this.postNews('Warning: your company is in debt. Take out a loan or cut costs!', 'bad');
  }

  private onNewYear() {
    this.vehicles.yearly();
    for (const l of this.lines.map.values()) {
      l.incomeLast = l.incomeYear; l.costLast = l.costYear;
      l.incomeYear = 0; l.costYear = 0;
    }
    this.economy.endYear(this.year - 1);
    for (const m of MODELS) {
      if (m.intro === this.year) this.postNews(`New vehicle available: ${m.name} (${m.speed} km/h${m.capacity ? ', ' + m.capacity + ' passengers' : ''})`, 'vehicle');
    }
  }
}
