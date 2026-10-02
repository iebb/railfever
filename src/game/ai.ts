// AI competitors: companies that plan and build bus networks and intercity railways using the same
// construction API as the player (findSnap / planEdge / commitProposal, stations, depots, lines, vehicles).
import type { Game } from './game';
import type { Town } from './towns';
import type { Station, StationPlan } from './stations';
import type { NEdge } from './network';
import { WATER_Y } from './constants';
import { planEdge, commitProposal, findSnap, BuildOptions, Snap, Proposal } from './construction';
import { Train } from './train';
import { RoadVehicle } from './roadvehicle';
import { RNG } from './rng';
import { Economy } from './economy';
import { availableModels, VehicleModel } from './vehicle-types';
import { fare } from './vehicle';
import { endTangent } from './geom';
import {
  OPoint, P2, ChainProfile, chainProfile, chainGen, routeConflict, routeGen, estimateChainCost, railPairGen, stationEnds,
  buildRailDepot, buildDepotNearLine, roadDepotGen, removeEdges, nodeSnap, nodeAt, depotAtEnd, depotFits,
} from './routing';

export * from './routing';

export const AI_NAMES = ['Northern Star Rail', 'Blue Valley Transit', 'Crimson Express', 'Evergreen Lines'];

// ============================================================================ controller

// ============================================================================ controller

/** Rail vehicles for the year: a cost-efficient locomotive (the fastest on long lines) and coaches filling the platform. */
export function pickTrain(year: number, platform: number, lineLen: number): VehicleModel[] | null {
  const locos = availableModels(year, 'loco'), wagons = availableModels(year, 'wagon');
  if (!locos.length || !wagons.length) return null;
  const value = (m: VehicleModel) => (Math.min(m.speed, lineLen > 220 ? 300 : 150) * (0.5 + m.power / 5000)) / (m.cost + m.running * 8);
  const loco = [...locos].sort((a, b) => value(b) - value(a))[0];
  const fit = wagons.filter((w) => w.speed >= Math.min(loco.speed, 150));
  const wag = (fit.length ? fit : wagons).sort((a, b) => b.capacity - a.capacity)[0];
  const n = Math.max(1, Math.min(5, Math.floor((platform - 0.8 - loco.length) / (wag.length + 0.1))));
  return [loco, ...Array<VehicleModel>(n).fill(wag)];
}

export function pickBus(year: number, townPop = 3000): VehicleModel | null {
  const buses = availableModels(year, 'bus');
  // small towns: smaller buses
  const value = (m: VehicleModel) => (Math.min(m.capacity, townPop / 40) * Math.min(m.speed, 60)) / (m.cost + m.running * 8);
  return buses.sort((a, b) => value(b) - value(a))[0] ?? null;
}

export interface AIStats {
  railStations: number; busStops: number; track: number; road: number; bridges: number; tunnels: number;
  lines: number; vehicles: number; failed: number; spent: number; sold: number;
}

interface Project {
  kind: 'rail' | 'bus' | 'road';
  towns: number[];
  stations: number[];
  edges: number[];
  depots: number[];
  line: number;
  started: number;
}

interface LineInfo { kind: 'rail' | 'bus'; towns: number[]; depot: number; maxVehicles: number; opened: number; lastSold?: number }

export interface AIState {
  phase: string;
  cooldown: number;
  projects: number;
  rng?: number;
  failed?: [string, number][];
  stats?: AIStats;
  lines?: [number, LineInfo][];
  project?: Project | null;
}

const LEAD = 20;
const PLATFORM = 18;

/**
 * An AI company. Plans one project at a time (bus network in a large town, an intercity railway, or a
 * country road) as an incremental job; `daily()` runs a fixed number of work units (each well under a few
 * milliseconds), `monthly()` manages loans and vehicles. Uses only the public construction API.
 */
export class AIController {
  state: AIState = { phase: 'idle', cooldown: 10, projects: 0 };
  stats: AIStats = { railStations: 0, busStops: 0, track: 0, road: 0, bridges: 0, tunnels: 0, lines: 0, vehicles: 0, failed: 0, spent: 0, sold: 0 };
  /** work units per game day */
  budget = 6;
  /** debugging: note work units slower than slowMs */
  static profile = false;
  static slowMs = 8;
  log: string[] = [];
  private rng: RNG;
  private failed = new Map<string, number>();
  private lines = new Map<number, LineInfo>();
  private project: Project | null = null;
  private job: Generator<void, void> | null = null;
  private errorLogged = false;

  constructor(public game: Game, public companyId: number) {
    this.rng = new RNG((game.options.seed * 977 + companyId * 7919) >>> 0);
    this.state.cooldown = 12 + companyId * 9;
    game.world.net.onSplit.push((old, e1, e2) => {
      const p = this.project;
      if (!p) return;
      const i = p.edges.indexOf(old.id);
      if (i >= 0) p.edges.splice(i, 1, e1.id, e2.id);
    });
  }

  private get eco(): Economy { return this.game.company(this.companyId).economy; }
  private get name() { return this.game.company(this.companyId).name; }

  /** Money that can be committed: cash plus unused credit, minus a safety reserve. */
  available(): number {
    const e = this.eco;
    return e.money + Math.max(0, e.maxLoan * 0.65 - e.loan) - 1_000_000 - this.game.maintenanceOf(this.companyId) * 0.5;
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

  /** Called once per game day while AI is enabled. */
  daily() {
    try {
      if (this.job) {
        for (let k = 0; k < this.budget && this.job; k++) {
          const t0 = AIController.profile ? performance.now() : 0;
          if (this.job.next().done) this.job = null;
          if (AIController.profile) { const dt = performance.now() - t0; if (dt > AIController.slowMs) this.note(`slow step ${dt.toFixed(1)} ms in "${this.state.phase}"`); }
        }
        if (!this.job) this.endProject();
        return;
      }
      if (this.state.cooldown > 0) { this.state.cooldown--; return; }
      this.chooseProject();
    } catch (e) { this.onError(e); }
  }

  /** Called once per game month while AI is enabled. */
  monthly() {
    try { this.manage(); } catch (e) { this.onError(e); }
  }

  /** Debug/test hook: start a specific project now (returns false if busy). */
  startProject(kind: 'rail' | 'bus' | 'road', towns: number[]): boolean {
    if (this.job) return false;
    const g = this.game, T = towns.map((id) => g.towns.list[id]);
    this.project = { kind, towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = kind === 'rail' ? this.railJob(T[0], T[1]) : kind === 'bus' ? this.busJob(T[0]) : this.roadJob(T[0], T[1]);
    this.state.projects++;
    return true;
  }

  /** Is a project in progress? */
  get busy() { return !!this.job; }

  // ---------------------------------------------------------------- choosing projects
  private pairKey(a: number, b: number) { return a < b ? `${a}-${b}` : `${b}-${a}`; }
  private isFailed(key: string) { const d = this.failed.get(key); return d !== undefined && d > this.game.day; }
  private markFailed(key: string, days: number) { this.failed.set(key, this.game.day + days); this.stats.failed++; }

  private railServed(a: number, b: number): boolean {
    const g = this.game;
    for (const l of g.lines.map.values()) {
      if (l.kind !== 'rail' || l.stops.length < 2) continue;
      const towns = new Set(l.stops.map((s) => g.stations.get(s)?.townId ?? -1));
      if (towns.has(a) && towns.has(b)) return true;
    }
    return false;
  }

  private chooseProject() {
    const g = this.game;
    const avail = this.available();
    const own = [...this.lines.values()];
    const railLines = own.filter((l) => l.kind === 'rail').length, busLines = own.filter((l) => l.kind === 'bus').length;
    // don't overbuild: keep the debt serviceable
    const yearNet = this.eco.yearTotals.length ? Object.values(this.eco.yearTotals[this.eco.yearTotals.length - 1].v).reduce((a, b) => a + b, 0) : 0;
    if (this.eco.loan > this.eco.maxLoan * 0.85 || (own.length >= 3 && yearNet < -1_500_000)) { this.state.phase = 'consolidating'; this.state.cooldown = 90; return; }
    const opts: { score: number; kind: 'rail' | 'bus' | 'road'; towns: number[] }[] = [];
    // intercity railways
    if (avail > 4_000_000) {
      for (const A of g.towns.list) for (const B of g.towns.list) {
        if (A.id >= B.id) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 60 || d > 250 || A.pop < 250 || B.pop < 250) continue;
        if (this.isFailed(this.pairKey(A.id, B.id)) || own.some((l) => l.kind === 'rail' && l.towns.includes(A.id) && l.towns.includes(B.id))) continue;
        let score = Math.sqrt(A.pop * B.pop) / (1 + Math.abs(d - 130) / 160);
        if (this.railServed(A.id, B.id)) score *= 0.3;
        if (own.filter((l) => l.kind === 'rail' && (l.towns.includes(A.id) || l.towns.includes(B.id))).length) score *= 0.6;
        opts.push({ score: score * (railLines === 0 ? 1.6 : 1), kind: 'rail', towns: [A.id, B.id] });
      }
    }
    // bus networks in larger towns
    if (avail > 900_000) {
      for (const T of g.towns.list) {
        if (T.pop < 1800 || this.isFailed('bus' + T.id) || own.some((l) => l.kind === 'bus' && l.towns.includes(T.id))) continue;
        opts.push({ score: T.pop / 2.5 * (busLines === 0 ? 1.3 : 1), kind: 'bus', towns: [T.id] });
      }
    }
    // occasionally a country road between neighbouring towns
    if (avail > 2_000_000 && this.rng.chance(0.15)) {
      for (const A of g.towns.list) for (const B of g.towns.list) {
        if (A.id >= B.id || this.isFailed('road' + this.pairKey(A.id, B.id))) continue;
        const d = Math.hypot(A.x - B.x, A.z - B.z);
        if (d < 50 || d > 130) continue;
        opts.push({ score: Math.sqrt(A.pop * B.pop) / 6, kind: 'road', towns: [A.id, B.id] });
      }
    }
    if (!opts.length) { this.state.phase = 'idle'; this.state.cooldown = 60; return; }
    opts.sort((a, b) => b.score - a.score);
    const top = opts.slice(0, 4);
    const pick = top[Math.floor(this.rng.next() * this.rng.next() * top.length)];
    const towns = pick.towns.map((id) => g.towns.list[id]);
    this.project = { kind: pick.kind, towns: pick.towns, stations: [], edges: [], depots: [], line: -1, started: g.day };
    this.job = pick.kind === 'rail' ? this.railJob(towns[0].pop >= towns[1].pop ? towns[0] : towns[1], towns[0].pop >= towns[1].pop ? towns[1] : towns[0])
      : pick.kind === 'bus' ? this.busJob(towns[0]) : this.roadJob(towns[0], towns[1]);
    this.state.projects++;
  }

  private endProject() {
    const p = this.project;
    this.project = null;
    this.state.phase = 'idle';
    this.state.cooldown = p && p.line >= 0 ? 50 + this.rng.int(60) : 20 + this.rng.int(20);
  }

  /** Remove what an unfinished project built. */
  private abandon(p: Project) {
    const g = this.game;
    if (p.line >= 0) {
      const l = g.lines.get(p.line);
      if (l) { for (const vid of [...l.vehicles]) g.vehicles.sell(vid); g.lines.delete(l.id); }
      this.lines.delete(p.line);
    }
    for (const d of p.depots) g.depots.remove(d);
    removeEdges(g, p.edges, this.companyId);
    for (const s of p.stations) { const st = g.stations.get(s); if (st && st.owner === this.companyId) g.stations.removeStation(s); }
    p.edges = []; p.stations = []; p.depots = [];
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
  private *railJob(A: Town, B: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    const key = this.pairKey(A.id, B.id);
    this.state.phase = `planning railway ${A.name} - ${B.name}`;
    const fail = (why: string, days = 900) => { this.note(`railway ${A.name}-${B.name} abandoned: ${why}`); this.markFailed(key, days); this.abandon(p); };
    let tracks = this.available() > 13_000_000 ? 2 : 1;
    const pr = yield* railPairGen(g, A, B, { tracks, length: PLATFORM, owner, front: LEAD + 2 });
    if (!pr) return fail('no station sites');
    const fa = { x: Math.sin(pr.a.angle), z: Math.cos(pr.a.angle) }, fb = { x: Math.sin(pr.b.angle), z: Math.cos(pr.b.angle) };
    const frontA = { x: pr.a.x + fa.x * PLATFORM / 2, z: pr.a.z + fa.z * PLATFORM / 2 }, frontB = { x: pr.b.x + fb.x * PLATFORM / 2, z: pr.b.z + fb.z * PLATFORM / 2 };
    const from: OPoint = { x: frontA.x + fa.x * LEAD, z: frontA.z + fa.z * LEAD, tx: fa.x, tz: fa.z };
    const to: OPoint = { x: frontB.x + fb.x * LEAD, z: frontB.z + fb.z * LEAD, tx: -fb.x, tz: -fb.z };
    const avoid = [
      { x0: frontA.x - fa.x * PLATFORM, z0: frontA.z - fa.z * PLATFORM, x1: from.x - fa.x * 4, z1: from.z - fa.z * 4, r: 4 },
      { x0: frontB.x - fb.x * PLATFORM, z0: frontB.z - fb.z * PLATFORM, x1: to.x + to.tx * 4, z1: to.z + to.tz * 4, r: 4 },
    ];
    const start: OPoint = { x: frontA.x, z: frontA.z, tx: fa.x, tz: fa.z };
    const plan = yield* routeGen(g, from, to, { kind: 'rail', owner, tracks, y0: pr.a.y, y1: pr.b.y, pre: [start], post: [{ x: frontB.x, z: frontB.z, tx: -fb.x, tz: -fb.z }], avoid, minR: 14 });
    if (typeof plan === 'string') return fail(plan, plan.startsWith('route runs') ? 720 : 900);
    const way = plan.way;
    let prof: ChainProfile | null = plan.prof;
    const len = plan.prof.s[plan.prof.s.length - 1];
    const dist = Math.hypot(pr.a.x - pr.b.x, pr.a.z - pr.b.z);
    if (len > dist * 1.55 + 25) return fail('detour too long');
    yield;
    const cars = pickTrain(g.year, PLATFORM, len);
    if (!cars) return fail('no trains available');
    const trainCost = cars.reduce((a, c) => a + c.cost, 0);
    let est = estimateChainCost(prof, tracks, 'rail', 'standard').cost * 1.15;
    let total = est + pr.a.cost + pr.b.cost + 300_000 + trainCost * tracks;
    if (tracks === 2 && total > this.available()) {
      // fall back to a single track
      tracks = 1;
      const pr1 = { a: g.stations.planRail(pr.a.x, pr.a.z, pr.a.angle, PLATFORM, 1, owner), b: g.stations.planRail(pr.b.x, pr.b.z, pr.b.angle, PLATFORM, 1, owner) };
      if (!pr1.a.ok || !pr1.b.ok) return fail('no single-track sites', 360);
      pr.a = pr1.a; pr.b = pr1.b;
      prof = chainProfile(g, [start, ...way], 1, pr.a.y, pr.b.y, 'rail');
      if (!prof) return fail('too steep');
      est = estimateChainCost(prof, 1, 'rail', 'standard').cost * 1.15;
      total = est + pr.a.cost + pr.b.cost + 300_000 + trainCost;
    }
    if (total > this.available()) return fail('too expensive', 360);
    yield;
    // the depot goes behind A (or B: then swap the ends)
    if (!this.depotSiteFor(pr.a, pr.b, tracks)) {
      if (!this.depotSiteFor(pr.b, pr.a, tracks)) return fail('no depot site', 720);
    }
    // rough yearly result: one full train per track (fare model in vehicle.ts)
    const days = len / 3.2 + 9;
    const tripsYear = 360 / days;
    const cap = cars.reduce((a, c) => a + c.capacity, 0);
    const income = tracks * tripsYear * cap * 0.8 * fare(dist, days - 6, 1);
    const running = tracks * cars.reduce((a, c) => a + c.running, 0);
    const maint = len * tracks * 300 + 75_000 + 12_000 + est * 0.01;
    if (income - running - maint < (total - trainCost * tracks) * 0.07 + total * 0.04) return fail('not profitable', 1500);
    // ---- build
    this.state.phase = `building railway ${A.name} - ${B.name}`;
    if (!this.borrowFor(total)) return fail('no money', 360);
    const spent0 = this.eco.money;
    for (const plan of [pr.a, pr.b]) {
      const re = g.stations.planRail(plan.x, plan.z, plan.angle, PLATFORM, tracks, owner);
      const id = g.stations.nextId;
      if (!re.ok || g.stations.commitRail(re, owner)) return fail('station site taken', 360);
      p.stations.push(id);
      this.track(net.nextEdge - tracks);
      yield;
    }
    const stA = g.stations.get(p.stations[0])!, stB = g.stations.get(p.stations[1])!;
    const endA = stationEnds(g, stA), endB = stationEnds(g, stB);
    const front = (st: Station, ends: { front: number; back: number }[], o: Station) => {
      const r = st.rail!, f = Math.sin(r.angle) * (o.x - st.x) + Math.cos(r.angle) * (o.z - st.z) > 0;
      return ends.map((e) => (f ? e.front : e.back));
    };
    const fAs = front(stA, endA, stB), fBs = front(stB, endB, stA);
    const exclude = new Set<number>([...stA.rail!.edges, ...stB.rail!.edges]);
    prof = chainProfile(g, [start, ...way], tracks, stA.rail!.y, stB.rail!.y, 'rail', exclude);
    if (!prof) return fail('too steep');
    yield;
    if (routeConflict(g, prof, 'rail', tracks, exclude)) return fail('route runs along other tracks or roads', 720);
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
    // ---- depot behind A
    const d0 = net.nextEdge;
    let dep = -1;
    for (const [st, o] of [[stA, stB], [stB, stA]] as [Station, Station][]) {
      if (dep >= 0) break;
      const dir = { x: o.x - st.x, z: o.z - st.z };
      dep = tracks > 1 ? this.depotSwitch(st, dir) : buildRailDepot(g, st, owner, dir);
    }
    // else a siding off the main line, near A or B
    if (dep < 0 && tracks === 1) dep = buildDepotNearLine(g, [...p.edges], stA.x, stA.z, owner);
    if (dep < 0 && tracks === 1) dep = buildDepotNearLine(g, [...p.edges], stB.x, stB.z, owner);
    this.track(d0);
    if (dep < 0) return fail('no depot site', 720);
    p.depots.push(dep);
    yield;
    // ---- line and trains
    const line = g.lines.create('rail', owner);
    line.stops = [stA.id, stB.id];
    p.line = line.id;
    let bought = 0;
    for (let i = 0; i < tracks; i++) {
      const t = g.vehicles.buyTrain(dep, cars, line.id);
      if (typeof t !== 'string') { bought++; this.stats.vehicles++; }
    }
    if (!bought) return fail('could not buy a train', 360);
    this.lines.set(line.id, { kind: 'rail', towns: [A.id, B.id], depot: dep, maxVehicles: tracks, opened: g.day });
    this.stats.lines++; this.stats.railStations += 2;
    this.stats.spent += Math.max(0, spent0 - this.eco.money) + total - est;
    this.project = { ...p, line: line.id };
    p.line = line.id;
    g.postNews(`${this.name} opens a railway between ${A.name} and ${B.name} (${(len / 100).toFixed(1)} km${tracks > 1 ? ', double track' : ''}).`, 'ai', (stA.x + stB.x) / 2, (stA.z + stB.z) / 2);
    this.note(`opened railway ${A.name}-${B.name}: ${Math.round(len)} u, ${tracks} track(s), ${res.bridges} bridges, ${res.tunnels} tunnels`);
    this.project = null;
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

  // ---------------------------------------------------------------- bus
  private *busJob(T: Town): Generator<void, void> {
    const g = this.game, owner = this.companyId, net = g.world.net;
    const p = this.project!;
    this.state.phase = `planning buses in ${T.name}`;
    const fail = (why: string) => { this.note(`buses in ${T.name} abandoned: ${why}`); this.markFailed('bus' + T.id, 1200); this.abandon(p); };
    const model = pickBus(g.year, T.pop);
    if (!model) return fail('no buses available');
    // stop candidates on streets: middle of street edges, away from other companies' stops
    const cands: { x: number; z: number; d: number }[] = [];
    let k = 0;
    for (const e of g.towns.streets(T, 0)) {
      if (e.len < 4) continue;
      if (++k % 20 === 0) yield; // grid towns have many streets: spread the stop planning over days
      const q = { x: 0, y: 0, z: 0 };
      net.pointAt(e, e.len / 2, q);
      const bp = g.stations.planBusStop(q.x, q.z, owner);
      if (!bp.ok || bp.join) continue;
      let clash = false;
      for (const st of g.stations.map.values()) if (st.owner !== owner && st.stops.some((s) => Math.hypot(s.x - q.x, s.z - q.z) < 8)) { clash = true; break; }
      if (!clash) cands.push({ x: q.x, z: q.z, d: Math.hypot(q.x - T.x, q.z - T.z) });
    }
    yield;
    if (cands.length < 2) return fail('no stop sites');
    cands.sort((a, b) => a.d - b.d);
    const stops = [cands[0]];
    const nStops = T.pop > 2500 ? 3 : 2;
    for (const c of cands) {
      if (stops.length >= nStops) break;
      if (stops.every((s) => { const d = Math.hypot(s.x - c.x, s.z - c.z); return d > 11 && d < 34; })) stops.push(c);
    }
    if (stops.length < 2) return fail('stops too close');
    const cost = stops.length * 30000 + 120_000 + model.cost * (stops.length + 1);
    if (!this.borrowFor(cost)) return fail('no money');
    this.state.phase = `building buses in ${T.name}`;
    const ids: number[] = [];
    for (const s of stops) {
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) continue;
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const d = Math.hypot(q.x - s.x, q.z - s.z); if (d < bd) { bd = d; sid = st.id; } }
      if (sid >= 0 && !ids.includes(sid)) ids.push(sid);
      if (g.stations.nextId > before) p.stations.push(before);
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
    const n = Math.min(4, ids.length + (T.pop > 3000 ? 1 : 0));
    for (let i = 0; i < n; i++) { const v = g.vehicles.buyRoad(dep, model, line.id); if (typeof v !== 'string') this.stats.vehicles++; }
    this.lines.set(line.id, { kind: 'bus', towns: [T.id], depot: dep, maxVehicles: 7, opened: g.day });
    this.stats.lines++;
    g.postNews(`${this.name} starts a bus service in ${T.name}.`, 'ai', T.x, T.z);
    this.note(`opened bus line in ${T.name} (${ids.length} stops, ${n} buses)`);
    this.project = null;
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
    });
    if (typeof plan === 'string') return fail(plan, plan.startsWith('route runs') ? 1500 : 3000);
    const al = { way: plan.way };
    let prof: ChainProfile | null = plan.prof;
    if (prof.s[prof.s.length - 1] > gap * 2 + 20) return fail('detour too long');
    const est = estimateChainCost(prof, 1, 'road', 'road').cost * 1.2 + xa.prop.cost + xb.prop.cost + 50_000;
    if (est > this.available() * 0.4) return fail('too expensive', 720);
    if (!this.borrowFor(est)) return fail('no money', 360);
    this.state.phase = `building road ${A.name} - ${B.name}`;
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
  private manage() {
    const g = this.game, e = this.eco;
    // loans: keep a cash cushion, repay when rich
    if (e.money < 500_000) { while (e.money < 1_000_000 && e.borrow()) { /* */ } }
    else if (!this.job && e.money > 3_000_000 && e.loan > 0) { while (e.money > 2_000_000 && e.loan > 0 && e.repay()) { /* */ } }
    for (const [lid, info] of [...this.lines]) {
      const l = g.lines.get(lid);
      if (!l) { this.lines.delete(lid); continue; }
      const vs = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is NonNullable<typeof v> => !!v);
      // sell chronically unprofitable vehicles (keep one per line unless money is tight)
      for (const v of vs) {
        if (v.age < 2.5 || v.profitLast >= -0.25 * v.runningCost || v.profitYear > 0) continue;
        if (vs.length > 1 || e.money < 0) { g.vehicles.sell(v.id); this.stats.sold++; info.lastSold = g.day; this.note(`sold ${v.name}`); break; }
      }
      // more vehicles when passengers pile up on a line that pays
      const maxV = info.kind === 'bus' ? Math.min(info.maxVehicles, l.stops.length * 2) : info.maxVehicles;
      if (!vs.length || vs.length >= maxV || g.day - (info.lastSold ?? -1e9) < 180) continue;
      const young = g.day - info.opened < 360;
      if (!young && l.incomeLast < l.costLast * 1.2 + 10_000) continue;
      let waiting = 0;
      for (const sid of l.stops) { const st = g.stations.get(sid); if (st) for (const w of st.waiting.values()) if (w.line === lid) waiting += w.count; }
      const v0 = vs[0];
      if (waiting < v0.capacity * 2.5 || this.available() < v0.value * 1.5) continue;
      if (info.kind === 'rail' && v0 instanceof Train) {
        const t = g.vehicles.buyTrain(info.depot, [...v0.cars].sort((a, b) => (a.kind === 'loco' ? -1 : 0) - (b.kind === 'loco' ? -1 : 0)), lid);
        if (typeof t !== 'string') { this.stats.vehicles++; this.note(`added a train to ${l.name}`); }
      } else if (v0 instanceof RoadVehicle && v0.model) {
        const model = v0.model;
        if (!this.borrowFor(model.cost)) continue;
        const b = g.vehicles.buyRoad(info.depot, model, lid);
        if (typeof b !== 'string') { this.stats.vehicles++; this.note(`added a bus to ${l.name}`); }
      }
    }
  }

  // ---------------------------------------------------------------- save / load
  toJSON(): unknown {
    return {
      companyId: this.companyId,
      state: {
        ...this.state, rng: this.rng.state, failed: [...this.failed], stats: this.stats, lines: [...this.lines],
        project: this.project,
      },
    };
  }

  load(data: any) {
    const s = data?.state;
    if (!s) return;
    this.state = { phase: s.phase ?? 'idle', cooldown: s.cooldown ?? 10, projects: s.projects ?? 0 };
    if (typeof s.rng === 'number') this.rng.state = s.rng;
    if (Array.isArray(s.failed)) this.failed = new Map(s.failed);
    if (s.stats) this.stats = { ...this.stats, ...s.stats };
    if (Array.isArray(s.lines)) this.lines = new Map(s.lines);
    // an interrupted project is cleaned up (jobs are not persisted)
    if (s.project) {
      const p: Project = { kind: s.project.kind, towns: s.project.towns ?? [], stations: s.project.stations ?? [], edges: s.project.edges ?? [], depots: s.project.depots ?? [], line: s.project.line ?? -1, started: s.project.started ?? 0 };
      try { this.abandon(p); } catch { /* ignore */ }
      this.state.phase = 'idle';
      this.state.cooldown = 5;
    }
  }
}

// keep type imports referenced
export type { Town, Station, StationPlan, NEdge };
