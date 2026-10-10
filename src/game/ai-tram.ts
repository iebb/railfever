// AI tram lines: tram tracks along main streets through a big town's centre, stops along them, a tram depot,
// trams and a tram line. Incremental (work units), so the AI controller can run it a few units per day.
import type { Game } from './game';
import type { Town } from './towns';
import type { NEdge } from './network';
import { availableModels, VehicleModel } from './vehicle-types';
import { addTramTracks, removeTramTracks, roadPath, tramUsable, depotSize } from './build-ops';
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
  private job: Generator<void, boolean> | null = null;
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
    if (this.job) return false;
    const model = pickTram(this.game.year);
    if (!model) return false;
    if (this.funds() < model.cost * 2 + 1_200_000) return false;
    return this.candidates().length > 0;
  }

  /** Start a tram project in the best candidate town; false if there is none. */
  start(townId?: number): boolean {
    if (this.job) return false;
    const candidates = this.candidates();
    const town = townId === undefined ? candidates[0] : candidates.find(t => t.id === townId);
    if (!town || !pickTram(this.game.year, town.pop)) return false;
    this.project = { town: town.id, edges: [], stations: [], stops: [], depot: -1, line: -1 };
    this.reason = '';
    this.result = 'running';
    this.job = this.build(town);
    return true;
  }

  /** Run up to `budget` work units. */
  step(budget: number): 'running' | 'done' | 'failed' {
    if (!this.job) return this.result;
    for (let k = 0; k < budget; k++) {
      let r: IteratorResult<void, boolean>;
      try { r = this.job.next(); } catch (e) { r = { done: true, value: false }; this.reason = 'error: ' + String((e as Error)?.message ?? e); }
      if (r.done) {
        this.job = null;
        this.result = r.value ? 'done' : 'failed';
        if (!r.value && this.project) this.failed().set(this.companyId + ':' + this.project.town, this.game.day + 720);
        this.status = r.value ? 'done' : 'failed: ' + this.reason;
        return this.result;
      }
    }
    return 'running';
  }

  /** Remove whatever the current (unfinished or failed) project built. */
  cleanup() {
    this.job = null;
    if (this.project && this.result !== 'done') TramPlanner.abandon(this.game, this.companyId, this.project);
    this.project = null;
    this.result = 'done';
  }

  /** What the current project built so far (persist it to clean up after loading a game mid-project). */
  record(): TramProject | null { return this.project ? { ...this.project, edges: [...this.project.edges], stations: [...this.project.stations], stops: this.project.stops.map((s) => [...s] as [number, number, number]) } : null; }

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

  private *build(T: Town): Generator<void, boolean> {
    const g = this.game, owner = this.companyId, net = g.world.net, p = this.project!;
    this.status = `planning trams in ${T.name}`;
    const model = pickTram(g.year, T.pop);
    if (!model) return this.fail('no trams in service');
    // ---- route: along the town's main axis (population weighted), through the centre, on its streets
    const routes = yield* this.routes(T);
    if (!routes.length) return this.fail('no street route through the centre');
    const route = routes[0];
    yield;
    // ---- money: tracks, stops, depot, vehicles
    const fresh = route.edges.filter((id) => !net.edges.get(id)?.tram);
    let trackLen = 0;
    for (const id of fresh) trackLen += net.edges.get(id)!.len;
    const nTrams = Math.max(2, Math.min(5, Math.round(route.len / 22)));
    const cost = trackLen * TRAM.costPerUnit + route.stops.length * 30_000 + 200_000 + nTrams * model.cost;
    // ---- the forecast (ai-bus.ts): riders shared with every served stop near the route, tram fares, against the works,
    // trams, running and upkeep (a copy of another company's trams in the same streets does not pay)
    const quote = yield* tramRouteValue(g, owner, route.stops, trackLen, model, nTrams);
    if (!pays(quote)) return this.fail(`forecast ${Math.round(quote.revenue / 1000)}k/year below ${Math.round(quote.yearly / 1000)}k`);
    const e = this.eco;
    while (e.money < cost + 300_000 && e.borrow()) { /* borrow in steps */ }
    if (e.money < cost) return this.fail('too expensive');
    this.status = `building trams in ${T.name}`;
    // ---- tracks
    const usable = (id: number) => { const ed = net.edges.get(id); return !!ed && tramUsable(g, ed, owner); };
    const r = addTramTracks(g, fresh.filter((id) => !usable(id)), owner);
    if (r.error && r.changed === 0 && fresh.some((id) => !usable(id))) return this.fail('tracks: ' + r.error);
    for (const id of fresh) if (net.edges.get(id)?.tramOwner === owner) p.edges.push(id);
    if (!route.edges.every(usable)) return this.fail('tracks: ' + (r.error ?? 'not laid'));
    yield;
    // ---- stops
    const ids: number[] = [];
    for (const s of route.stops) {
      yield;
      const before = g.stations.nextId;
      if (g.stations.commitBusStop(s.x, s.z, owner)) continue;
      let sid = -1, bd = Infinity;
      for (const st of g.stations.map.values()) if (st.owner === owner) for (const q of st.stops) { const dd = Math.hypot(q.x - s.x, q.z - s.z); if (dd < bd) { bd = dd; sid = st.id; } }
      if (sid < 0) continue;
      if (g.stations.nextId > before) p.stations.push(before); else p.stops.push([sid, s.x, s.z]);
      if (!ids.includes(sid)) ids.push(sid);
      yield;
    }
    if (ids.length < 3) return this.fail('stops could not be built');
    // ---- depot near one end of the route
    const dep = yield* tramDepotGen(g, route.pts, ids, owner);
    if (dep < 0) return this.fail('no depot site');
    p.depot = dep;
    yield;
    // ---- line (out and back) and trams
    const line = g.lines.create('tram', owner);
    p.line = line.id;
    line.stops = [...ids, ...ids.slice(1, -1).reverse()];
    let bought = 0;
    for (let i = 0; i < nTrams; i++) { if (typeof g.vehicles.buyRoad(dep, model, line.id) !== 'string') bought++; yield; }
    if (!bought) return this.fail('could not buy trams');
    this.status = `opened trams in ${T.name}`;
    return true;
  }

  /** Candidate tram routes through the centre: edges, length, sampled path points and stop sites. */
  private *routes(T: Town): Generator<void, { edges: number[]; len: number; pts: { x: number; z: number; edge: number; s: number }[]; stops: { x: number; z: number }[]; score: number }[]> {
    const g = this.game, net = g.world.net, owner = this.companyId;
    // population-weighted principal axis of the town
    let sw = 0, mx = 0, mz = 0;
    const R = Math.max(20, Math.min(T.radius, 60));
    const blds = g.world.buildingsNear(T.x, T.z, R).filter((b) => b.pop > 0 && Math.hypot(b.x - T.x, b.z - T.z) <= R);
    for (const b of blds) { sw += b.pop; mx += b.x * b.pop; mz += b.z * b.pop; }
    if (sw <= 0) return [];
    mx /= sw; mz /= sw;
    let cxx = 0, cxz = 0, czz = 0;
    for (const b of blds) { const dx = b.x - mx, dz = b.z - mz; cxx += dx * dx * b.pop; cxz += dx * dz * b.pop; czz += dz * dz * b.pop; }
    const th = 0.5 * Math.atan2(2 * cxz, cxx - czz);
    const L = Math.max(30, Math.min(95, T.radius * 1.3));
    const out: { edges: number[]; len: number; pts: { x: number; z: number; edge: number; s: number }[]; stops: { x: number; z: number }[]; score: number }[] = [];
    for (const a of [th, th + Math.PI / 2, th + Math.PI / 4, th - Math.PI / 4]) {
      const ux = Math.cos(a), uz = Math.sin(a);
      const ends: ({ x: number; y: number; z: number } | null)[] = [];
      for (const sg of [-1, 1]) {
        let end: { x: number; y: number; z: number } | null = null;
        // the street point nearest to the axis end (falling back towards the centre)
        for (let f = 1; f >= 0.45; f -= 0.1) {
          const x = mx + ux * sg * L * 0.5 * f, z = mz + uz * sg * L * 0.5 * f;
          const ne = net.nearestEdge(x, z, 6, 'road', (e) => e.depot < 0 && e.station < 0 && e.type === 'street');
          yield;
          if (ne) { end = { x: 0, y: 0, z: 0 }; net.pointAt(ne.edge, ne.s, end); break; }
        }
        ends.push(end);
      }
      yield;
      if (!ends[0] || !ends[1]) continue;
      const direct = Math.hypot(ends[1].x - ends[0].x, ends[1].z - ends[0].z);
      if (direct < 20) continue;
      const edges = roadPath(g, ends[0].x, ends[0].z, ends[1].x, ends[1].z, direct * 2.2);
      yield;
      if (!edges || edges.length < 2) continue;
      // tracks of other companies on the way must be usable (access), company roads must be ours
      if (edges.some((id) => { const e = net.edges.get(id)!; return (e.tram && !tramUsable(g, e, owner)) || (e.owner >= 0 && !g.canUse(owner, e.owner)); })) continue;
      const pts = pathPoints(g, edges);
      yield;
      if (pts.length < 2) continue;
      const len = pts.length - 1;
      if (len > direct * 1.7 + 10) continue;
      const stops = yield* tramStopSitesGen(g, pts, owner);
      if (stops.length < 3) continue;
      // people in the stops' catchment (each counted once) per unit of new track
      const pop = g.stations.popInShapes(stops.map((s) => stopCatchShape(s.x, s.z, true)));
      out.push({ edges, len, pts, stops, score: pop / (40 + len) });
      yield;
    }
    return out.sort((p, q) => q.score - p.score);
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
