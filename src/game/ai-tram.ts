// AI tram lines: tram tracks along main streets through a big town's centre, stops along them, a tram depot,
// trams and a tram line. Incremental (work units), so the AI controller can run it a few units per day.
import type { Game } from './game';
import type { Town } from './towns';
import type { NEdge } from './network';
import { availableModels, VehicleModel, MODEL_BY_ID } from './vehicle-types';
import { addTramTracks, removeTramTracks, roadPath, tramUsable, depotSize, type DepotPlan } from './build-ops';
import { roadDepotReaches } from './roadvehicle';
import { TRAM } from './constants';
import { stopCatchShape } from './stations';
import { runGen, roadDepotAtDeadEnd } from './routing';
import { tramRouteValue, pays } from './ai-bus';

/** What a tram project built (for clean-up of failed or interrupted projects). */
export interface TramProject {
  town: number;
  /** edges whose tram tracks this project laid */
  edges: number[];
  /** stations created by this project, and stops added to existing stations ([station, x, z]) */
  stations: number[];
  stops: [number, number, number][];
  depot: number;
  line: number;
  /** Added when native tram planning became resumable. Older records contain only cleanup assets. */
  continuation?: { version: 1; status: string; reason: string; result: 'running' | 'done' | 'failed'; task: TramTask | null };
}

interface TramRoute {
  edges: number[]; len: number; pts: { x: number; z: number; edge: number; s: number }[];
  stops: { x: number; z: number }[]; score: number;
}
/** Every value carried across a work boundary is plain saved state; no generator locals decide construction. */
interface TramTask {
  stage: 'axis' | 'ends' | 'path' | 'points' | 'sites' | 'score' | 'quote' | 'tracks' | 'stops' | 'stop-build' | 'depot-site' | 'depot-build' | 'line' | 'vehicles';
  model: string; routes: TramRoute[]; route?: TramRoute; fresh: number[]; nTrams: number; cost: number; ids: number[]; at: number; bought: number;
  survey?: { mx: number; mz: number; length: number; angles: number[]; angle: number; side: number; factor: number;
    ends: ({ x: number; y: number; z: number } | null)[]; edges: number[]; pts: TramRoute['pts']; stops: TramRoute['stops']; wants: number[]; want: number; offset: number };
  depot?: { lo: number; hi: number; end: number; k: number; side: number; x?: number; z?: number; angle?: number; plan?: DepotPlan };
}

/** Best tram model for a town of this size in this year. */
export function pickTram(year: number, townPop = 5000): VehicleModel | null {
  const trams = availableModels(year, 'tram');
  const value = (m: VehicleModel) => (Math.min(m.capacity, townPop / 30) * Math.min(m.speed, 60)) / (m.cost + m.running * 8);
  return trams.sort((a, b) => value(b) - value(a))[0] ?? null;
}

/** Towns a company gave up on recently (per game), so the planner does not retry them every day. */
const failedTowns = new WeakMap<Game, Map<string, number>>();

export class TramPlanner {
  /** smallest town that gets a tram line */
  static minPop = 1500;
  project: TramProject | null = null;
  status = 'idle';
  /** why the last project failed */
  reason = '';
  private task: TramTask | null = null;
  private result: 'running' | 'done' | 'failed' = 'done';

  constructor(private game: Game, private companyId: number) {}

  private get eco() { return this.game.company(this.companyId).economy; }
  private failed(): Map<string, number> { let m = failedTowns.get(this.game); if (!m) { m = new Map(); failedTowns.set(this.game, m); } return m; }

  /** Money the company could raise (cash plus remaining loan). */
  private funds(): number { const e = this.eco; return e.money + Math.max(0, e.maxLoan - e.loan); }

  /** Towns big enough for trams that this company does not serve with trams yet (biggest first). */
  candidates(): Town[] {
    const g = this.game;
    const served = new Set<number>();
    for (const l of g.lines.all()) {
      if (l.owner !== this.companyId || l.kind !== 'tram') continue;
      for (const s of l.stops) { const st = g.stations.get(s); if (st && st.townId >= 0) served.add(st.townId); }
    }
    const f = this.failed();
    return g.towns.list
      .filter((t) => t.pop >= TramPlanner.minPop && !served.has(t.id) && (f.get(this.companyId + ':' + t.id) ?? -1e9) < g.day)
      .sort((a, b) => b.pop - a.pop || a.id - b.id);
  }

  /** Could a tram project start now? (trams in service this year, money, a town without our trams) */
  available(): boolean {
    if (this.task) return false;
    const model = pickTram(this.game.year);
    if (!model) return false;
    if (this.funds() < model.cost * 2 + 1_200_000) return false;
    return this.candidates().length > 0;
  }

  /** Start a tram project in the best candidate town; false if there is none. */
  start(townId?: number): boolean {
    if (this.task) return false;
    const candidates = this.candidates();
    const town = townId === undefined ? candidates[0] : candidates.find(t => t.id === townId);
    if (!town || !pickTram(this.game.year, town.pop)) return false;
    this.project = { town: town.id, edges: [], stations: [], stops: [], depot: -1, line: -1 };
    this.reason = '';
    this.result = 'running';
    this.task = { stage: 'axis', model: '', routes: [], fresh: [], nTrams: 0, cost: 0, ids: [], at: 0, bought: 0 };
    return true;
  }

  /** Run up to `budget` work units. */
  step(budget: number): 'running' | 'done' | 'failed' {
    if (!this.task) return this.result;
    for (let k = 0; k < budget; k++) {
      let done: boolean | undefined;
      try { done = this.work(); } catch (e) { done = false; this.reason = 'error: ' + String((e as Error)?.message ?? e); }
      if (done !== undefined) {
        this.task = null;
        this.result = done ? 'done' : 'failed';
        if (!done && this.project) this.failed().set(this.companyId + ':' + this.project.town, this.game.day + 720);
        this.status = done ? 'done' : 'failed: ' + this.reason;
        return this.result;
      }
    }
    return 'running';
  }

  /** Remove whatever the current (unfinished or failed) project built. */
  cleanup() {
    this.task = null;
    if (this.project && this.result !== 'done') TramPlanner.abandon(this.game, this.companyId, this.project);
    this.project = null;
    this.result = 'done';
  }

  /** Detached native continuation and its cleanup provenance. Merely saving never advances the planner. */
  record(): TramProject | null {
    return this.project ? { ...structuredClone(this.project), continuation: { version: 1, status: this.status,
      reason: this.reason, result: this.result, task: structuredClone(this.task) } } : null;
  }

  restore(record: TramProject): boolean {
    const c = record.continuation;
    if (!c || c.version !== 1) return false;
    if (!this.game.towns.list[record.town] || c.result === 'running' && !c.task) throw new Error('Invalid tram continuation');
    const { continuation, ...project } = structuredClone(record);
    this.project = project; this.status = c.status; this.reason = c.reason; this.result = c.result; this.task = structuredClone(c.task);
    return true;
  }

  /** Remove the assets of a tram project (vehicles, line, depot, stops, tracks). */
  static abandon(g: Game, owner: number, p: TramProject) {
    const line = g.lines.get(p.line);
    if (line && line.owner === owner) { for (const vid of [...line.vehicles]) g.vehicles.sell(vid); g.lines.delete(line.id); }
    for (const v of g.vehicles.all()) if (v.owner === owner && (v as { depotId?: number }).depotId === p.depot && !v.line) g.vehicles.sell(v.id);
    if (p.depot >= 0 && g.depots.get(p.depot)?.owner === owner) g.depots.remove(p.depot);
    for (const [sid, x, z] of p.stops) {
      const st = g.stations.get(sid);
      if (!st || st.owner !== owner) continue;
      const i = st.stops.findIndex((q) => Math.hypot(q.x - x, q.z - z) < 0.05);
      if (i >= 0) g.stations.removeStop(st, i);
    }
    for (const sid of p.stations) { const st = g.stations.get(sid); if (st && st.owner === owner) g.stations.removeStation(sid); }
    removeTramTracks(g, p.edges.filter((id) => g.world.net.edges.get(id)?.tramOwner === owner), owner);
    p.edges = []; p.stations = []; p.stops = []; p.depot = -1; p.line = -1;
  }

  // ---------------------------------------------------------------- the job
  private fail(why: string): boolean { this.reason = why; return false; }

  private nextRoute(t: TramTask) {
    const s = t.survey!;
    s.angle++; s.side = 0; s.factor = 1; s.ends = []; s.edges = []; s.pts = []; s.stops = []; s.wants = []; s.want = 0; s.offset = 0;
    t.stage = 'ends';
  }

  private nextDepot(t: TramTask) {
    const d = t.depot!;
    if (++d.side >= 2) { d.side = 0; d.k += 2; }
    if (d.k >= Math.min(d.hi - d.lo - 2, 40)) { d.end++; d.k = 2; }
    delete d.plan; t.stage = 'depot-site';
  }

  /** One native search or construction unit. Loading only restores this cursor; it never executes a unit. */
  private work(): boolean | undefined {
    const t = this.task!, p = this.project!, g = this.game, owner = this.companyId, net = g.world.net;
    const T = g.towns.list[p.town];
    if (!T) return this.fail('town no longer exists');
    if (t.stage === 'axis') {
      this.status = `planning trams in ${T.name}`;
      const model = pickTram(g.year, T.pop);
      if (!model) return this.fail('no trams in service');
      t.model = model.id;
      const R = Math.max(20, Math.min(T.radius, 60));
      // Growth reindexes building cells. Canonical input order makes both resumed and future surveys
      // independent of that disposable index's insertion history, including floating-point sums.
      const blds = g.world.buildingsNear(T.x, T.z, R)
        .filter(b => b.pop > 0 && Math.hypot(b.x - T.x, b.z - T.z) <= R).sort((a, b) => a.id - b.id);
      let sw = 0, mx = 0, mz = 0;
      for (const b of blds) { sw += b.pop; mx += b.x * b.pop; mz += b.z * b.pop; }
      if (sw <= 0) return this.fail('no street route through the centre');
      mx /= sw; mz /= sw;
      let cxx = 0, cxz = 0, czz = 0;
      for (const b of blds) { const dx = b.x - mx, dz = b.z - mz; cxx += dx * dx * b.pop; cxz += dx * dz * b.pop; czz += dz * dz * b.pop; }
      const th = .5 * Math.atan2(2 * cxz, cxx - czz);
      t.survey = { mx, mz, length: Math.max(30, Math.min(95, T.radius * 1.3)), angles: [th, th + Math.PI / 2, th + Math.PI / 4, th - Math.PI / 4],
        angle: 0, side: 0, factor: 1, ends: [], edges: [], pts: [], stops: [], wants: [], want: 0, offset: 0 };
      t.stage = 'ends'; return;
    }
    if (t.stage === 'ends') {
      const s = t.survey!;
      if (s.angle >= s.angles.length) {
        t.routes.sort((a, b) => b.score - a.score);
        if (!t.routes.length) return this.fail('no street route through the centre');
        t.route = t.routes[0];
        t.fresh = t.route.edges.filter(id => !net.edges.get(id)?.tram);
        const trackLen = t.fresh.reduce((sum, id) => sum + (net.edges.get(id)?.len ?? 0), 0);
        t.nTrams = Math.max(2, Math.min(5, Math.round(t.route.len / 22)));
        const model = MODEL_BY_ID.get(t.model)!;
        t.cost = trackLen * TRAM.costPerUnit + t.route.stops.length * 30_000 + 200_000 + t.nTrams * model.cost;
        t.stage = 'quote'; return;
      }
      if (s.side >= 2) { t.stage = 'path'; return; }
      if (s.factor < .45) { s.ends.push(null); s.side++; s.factor = 1; return; }
      const a = s.angles[s.angle], sign = s.side ? 1 : -1;
      const x = s.mx + Math.cos(a) * sign * s.length * .5 * s.factor, z = s.mz + Math.sin(a) * sign * s.length * .5 * s.factor;
      const near = net.nearestEdge(x, z, 6, 'road', e => e.depot < 0 && e.station < 0 && e.type === 'street');
      if (near) { const end = { x: 0, y: 0, z: 0 }; net.pointAt(near.edge, near.s, end); s.ends.push(end); s.side++; s.factor = 1; }
      else s.factor -= .1;
      return;
    }
    if (t.stage === 'path') {
      const s = t.survey!, a = s.ends[0], b = s.ends[1];
      if (!a || !b) { this.nextRoute(t); return; }
      const direct = Math.hypot(b.x - a.x, b.z - a.z);
      if (direct < 20) { this.nextRoute(t); return; }
      const edges = roadPath(g, a.x, a.z, b.x, b.z, direct * 2.2);
      if (!edges || edges.length < 2 || edges.some(id => { const e = net.edges.get(id); return !e || e.tram && !tramUsable(g, e, owner) || e.owner >= 0 && !g.canUse(owner, e.owner); })) {
        this.nextRoute(t); return;
      }
      s.edges = edges; t.stage = 'points'; return;
    }
    if (t.stage === 'points') {
      const s = t.survey!, a = s.ends[0]!, b = s.ends[1]!;
      s.pts = pathPoints(g, s.edges);
      if (s.pts.length < 2 || s.pts.length - 1 > Math.hypot(b.x - a.x, b.z - a.z) * 1.7 + 10) { this.nextRoute(t); return; }
      for (let at = 3; at < s.pts.length - 3; at += 12) s.wants.push(at);
      if (s.pts.length - 4 - (s.wants.at(-1) ?? 0) > 6) s.wants.push(s.pts.length - 4);
      t.stage = 'sites'; return;
    }
    if (t.stage === 'sites') {
      const s = t.survey!, offsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5];
      if (s.want >= s.wants.length) { t.stage = 'score'; return; }
      if (s.offset >= offsets.length) { s.offset = 0; s.want++; return; }
      const i = Math.round(s.wants[s.want] + offsets[s.offset++]);
      if (i < 1 || i >= s.pts.length - 1) return;
      const q = s.pts[i], plan = g.stations.planBusStop(q.x, q.z, owner);
      if (!plan.ok || plan.edge?.id !== q.edge || s.stops.some(v => Math.hypot(v.x - q.x, v.z - q.z) < 6)) return;
      s.stops.push({ x: q.x, z: q.z }); s.want++; s.offset = 0; return;
    }
    if (t.stage === 'score') {
      const s = t.survey!;
      if (s.stops.length >= 3) {
        const pop = g.stations.popInShapes(s.stops.map(q => stopCatchShape(q.x, q.z, true)));
        t.routes.push({ edges: s.edges, len: s.pts.length - 1, pts: s.pts, stops: s.stops, score: pop / (40 + s.pts.length - 1) });
      }
      this.nextRoute(t); return;
    }
    const route = t.route!, model = MODEL_BY_ID.get(t.model);
    if (!model) return this.fail('tram model no longer exists');
    if (t.stage === 'quote') {
      // The forecast is a pure, bounded query. Publish its decision in this ordinary work unit, not during load.
      const trackLen = t.fresh.reduce((sum, id) => sum + (net.edges.get(id)?.len ?? 0), 0);
      const quote = runGen(tramRouteValue(g, owner, route.stops, trackLen, model, t.nTrams));
      if (!pays(quote)) return this.fail(`forecast ${Math.round(quote.revenue / 1000)}k/year below ${Math.round(quote.yearly / 1000)}k`);
      while (this.eco.money < t.cost + 300_000 && this.eco.borrow()) { /* borrow in steps */ }
      if (this.eco.money < t.cost) return this.fail('too expensive');
      this.status = `building trams in ${T.name}`; t.stage = 'tracks';
    }
    if (t.stage === 'tracks') {
      const usable = (id: number) => { const e = net.edges.get(id); return !!e && tramUsable(g, e, owner); };
      const laid = addTramTracks(g, t.fresh.filter(id => !usable(id)), owner);
      if (laid.error && laid.changed === 0 && t.fresh.some(id => !usable(id))) return this.fail('tracks: ' + laid.error);
      for (const id of t.fresh) if (net.edges.get(id)?.tramOwner === owner) p.edges.push(id);
      if (!route.edges.every(usable)) return this.fail('tracks: ' + (laid.error ?? 'not laid'));
      t.stage = 'stops'; t.at = 0; return;
    }
    if (t.stage === 'stops') {
      if (t.at < route.stops.length) {
        // Native stop construction yields both before committing a site and after a successful commit.
        t.stage = 'stop-build'; return;
      }
      if (t.ids.length < 3) return this.fail('stops could not be built');
      const at = t.ids.map(id => {
        const st = g.stations.get(id), q = st?.stops[0] ?? st;
        if (!q) return -1;
        let best = -1, distance = Infinity;
        route.pts.forEach((p, i) => { const d = Math.hypot(p.x - q.x, p.z - q.z); if (d < distance) { distance = d; best = i; } });
        return best;
      }).filter(i => i >= 0);
      t.depot = { lo: at.length ? Math.min(...at) : 0, hi: at.length ? Math.max(...at) : route.pts.length - 1, end: 0, k: 2, side: 0 };
      if (Math.min(t.depot.hi - t.depot.lo - 2, 40) <= 2) return this.fail('no depot site');
      t.stage = 'depot-site'; return;
    }
    if (t.stage === 'stop-build') {
      const q = route.stops[t.at++], before = g.stations.nextId;
      t.stage = 'stops';
      if (g.stations.commitBusStop(q.x, q.z, owner)) { t.stage = t.at < route.stops.length ? 'stop-build' : 'stops'; return; }
      let sid = -1, best = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const stop of st.stops) {
        const d = Math.hypot(stop.x - q.x, stop.z - q.z); if (d < best) { best = d; sid = st.id; }
      }
      if (sid < 0) return;
      if (g.stations.nextId > before) p.stations.push(before); else p.stops.push([sid, q.x, q.z]);
      if (!t.ids.includes(sid)) t.ids.push(sid);
      return;
    }
    if (t.stage === 'depot-site') {
      const d = t.depot!;
      if (d.end >= 2 || Math.min(d.hi - d.lo - 2, 40) <= 2) return this.fail('no depot site');
      const i = d.end ? d.hi - d.k : d.lo + d.k, q = route.pts[i], next = route.pts[Math.min(route.pts.length - 1, i + 1)], prev = route.pts[Math.max(0, i - 1)];
      const tx = next.x - prev.x, tz = next.z - prev.z, length = Math.hypot(tx, tz) || 1, side = d.side ? -1 : 1;
      const nx = -tz / length * side, nz = tx / length * side, off = .5 + .9 + depotSize('tram').d / 2;
      d.x = q.x + nx * off; d.z = q.z + nz * off; d.angle = Math.atan2(-nx, -nz);
      d.plan = g.depots.plan('tram', d.x!, d.z!, d.angle!, owner);
      // The native quote's demolition set comes from the disposable building index too.
      // Persist and execute its physical removals in ID order, independent of cell insertion history.
      d.plan.demolish.sort((a, b) => a - b);
      t.stage = 'depot-build'; return;
    }
    if (t.stage === 'depot-build') {
      const d = t.depot!, plan = d.plan!;
      if (!plan.ok || plan.demolish.some(id => (g.world.buildings.get(id)?.pop ?? 0) > 30) || plan.demolish.length > 2 || roadDepotAtDeadEnd(g, plan, true, owner)) {
        this.nextDepot(t); if (d.end >= 2) return this.fail('no depot site'); return;
      }
      const id = g.depots.nextId;
      if (!g.depots.commit('tram', plan, owner)) {
        const depot = g.depots.get(id);
        if (depot && roadDepotReaches(g, depot, t.ids[0])) { p.depot = id; t.stage = 'line'; return; }
        if (depot) g.depots.remove(id);
      }
      this.nextDepot(t); if (d.end >= 2) return this.fail('no depot site'); return;
    }
    if (t.stage === 'line') {
      const line = g.lines.create('tram', owner);
      p.line = line.id; line.stops = [...t.ids, ...t.ids.slice(1, -1).reverse()];
      // As in native construction, the draft and its first purchase belong to one work unit.
      if (typeof g.vehicles.buyRoad(p.depot, model, p.line) !== 'string') t.bought++;
      // Even a failed first purchase leaves a canonical empty draft until the next failure unit.
      g.lines.rebuild();
      t.stage = 'vehicles'; t.at = 1; return;
    }
    if (t.stage === 'vehicles') {
      if (t.at++ < t.nTrams) { if (typeof g.vehicles.buyRoad(p.depot, model, p.line) !== 'string') t.bought++; return; }
      if (!t.bought) return this.fail('could not buy trams');
      this.status = `opened trams in ${T.name}`; return true;
    }
    return this.fail('Invalid tram construction stage');
  }

}

/**
 * A tram depot beside a tram route near one of its ends, within the stretch its stops serve (never beyond the end stop,
 * where it would end the route), that reaches the route's first stop (-1: none).
 */
export function* tramDepotGen(g: Game, pts: { x: number; z: number; edge: number; s: number }[], stations: number[], owner: number): Generator<void, number> {
  const sz = depotSize('tram');
  // the route points nearest to its end stops
  const at = stations.map((sid) => {
    const st = g.stations.get(sid), q = st?.stops[0] ?? st;
    if (!q) return -1;
    let best = -1, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.hypot(p.x - q.x, p.z - q.z); if (d < bd) { bd = d; best = i; } });
    return best;
  }).filter((i) => i >= 0);
  const lo = at.length ? Math.min(...at) : 0, hi = at.length ? Math.max(...at) : pts.length - 1;
  for (const fromEnd of [false, true]) for (let k = 2; k < Math.min(hi - lo - 2, 40); k += 2) {
    const i = fromEnd ? hi - k : lo + k;
    const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
    const tx = q.x - o.x, tz = q.z - o.z, tl = Math.hypot(tx, tz) || 1;
    for (const side of [1, -1]) {
      yield;
      const nx = (-tz / tl) * side, nz = (tx / tl) * side;
      const off = 0.5 + 0.9 + sz.d / 2;
      const x = p.x + nx * off, z = p.z + nz * off;
      const plan = g.depots.plan('tram', x, z, Math.atan2(-nx, -nz), owner);
      yield;
      if (!plan.ok || plan.demolish.some((id) => (g.world.buildings.get(id)?.pop ?? 0) > 30) || plan.demolish.length > 2
        || roadDepotAtDeadEnd(g, plan, true, owner)) continue;
      const id = g.depots.nextId;
      if (g.depots.commit('tram', plan, owner)) continue;
      const dp = g.depots.get(id);
      if (dp && (!stations.length || roadDepotReaches(g, dp, stations[0]))) return id;
      if (dp) g.depots.remove(id);
    }
  }
  return -1;
}

/**
 * The tram depot sites tramDepotGen tries, in its order, that pass its checks before building (their plans). Pure.
 */
export function tramDepotSites(g: Game, pts: { x: number; z: number; edge: number; s: number }[], stations: number[], owner: number): DepotPlan[] {
  const sz = depotSize('tram'), out: DepotPlan[] = [];
  const at = stations.map((sid) => {
    const st = g.stations.get(sid), q = st?.stops[0] ?? st;
    if (!q) return -1;
    let best = -1, bd = Infinity;
    pts.forEach((p, i) => { const d = Math.hypot(p.x - q.x, p.z - q.z); if (d < bd) { bd = d; best = i; } });
    return best;
  }).filter((i) => i >= 0);
  const lo = at.length ? Math.min(...at) : 0, hi = at.length ? Math.max(...at) : pts.length - 1;
  for (const fromEnd of [false, true]) for (let k = 2; k < Math.min(hi - lo - 2, 40); k += 2) {
    const i = fromEnd ? hi - k : lo + k;
    const p = pts[i], q = pts[Math.min(pts.length - 1, i + 1)], o = pts[Math.max(0, i - 1)];
    const tx = q.x - o.x, tz = q.z - o.z, tl = Math.hypot(tx, tz) || 1;
    for (const side of [1, -1]) {
      const nx = (-tz / tl) * side, nz = (tx / tl) * side, off = 0.5 + 0.9 + sz.d / 2;
      const plan = g.depots.plan('tram', p.x + nx * off, p.z + nz * off, Math.atan2(-nx, -nz), owner);
      if (!plan.ok || plan.demolish.some((id) => (g.world.buildings.get(id)?.pop ?? 0) > 30) || plan.demolish.length > 2
        || roadDepotAtDeadEnd(g, plan, true, owner)) continue;
      out.push(plan);
    }
  }
  return out;
}

/** Points every unit along a path of road edges (in path order). */
export function pathPoints(g: Game, edges: number[]): { x: number; z: number; edge: number; s: number }[] {
  const net = g.world.net;
  const es = edges.map((id) => net.edges.get(id)).filter((e): e is NEdge => !!e);
  if (!es.length) return [];
  // the node the path enters each edge at
  let node = es.length > 1 ? (es[0].a === es[1].a || es[0].a === es[1].b ? es[0].b : es[0].a) : es[0].a;
  const out: { x: number; z: number; edge: number; s: number }[] = [];
  const q = { x: 0, y: 0, z: 0 };
  let carry = 0;
  for (const e of es) {
    const fwd = e.a === node;
    for (let s = carry; s <= e.len; s += 1) {
      net.pointAt(e, fwd ? s : e.len - s, q);
      out.push({ x: q.x, z: q.z, edge: e.id, s: fwd ? s : e.len - s });
    }
    carry = 1 - ((e.len - carry) % 1);
    if (carry >= 1) carry = 0;
    node = fwd ? e.b : e.a;
  }
  return out;
}

/** Stop sites about every 12 units along a path (on the path's own edges, not at junctions, ground only). */
export function tramStopSites(g: Game, pts: { x: number; z: number; edge: number; s: number }[], owner: number): { x: number; z: number }[] {
  return runGen(tramStopSitesGen(g, pts, owner));
}

/** The same stop search, with each candidate in its own AI work unit. */
function* tramStopSitesGen(g: Game, pts: { x: number; z: number; edge: number; s: number }[], owner: number): Generator<void, { x: number; z: number }[]> {
  const out: { x: number; z: number }[] = [];
  const n = pts.length;
  const want: number[] = [];
  for (let s = 3; s < n - 3; s += 12) want.push(s);
  if (n - 4 - (want[want.length - 1] ?? 0) > 6) want.push(n - 4);
  for (const w of want) {
    for (const d of [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5]) {
      const i = Math.round(w + d);
      if (i < 1 || i >= n - 1) continue;
      const p = pts[i];
      const bp = g.stations.planBusStop(p.x, p.z, owner);
      yield;
      if (!bp.ok || bp.edge?.id !== p.edge) continue;
      if (out.some((o) => Math.hypot(o.x - p.x, o.z - p.z) < 6)) continue;
      out.push({ x: p.x, z: p.z });
      break;
    }
  }
  return out;
}
