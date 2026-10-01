// Stations: free-placed rail stations (platform edges) and bus stops on road edges.
import type { Game } from './game';
import { STATION_RADIUS, BUSSTOP_RADIUS, RAIL, ROAD_TYPES } from './constants';
import { bezLine } from './geom';
import { NEdge } from './network';
import { applyEarthworks } from './terraform';
import { distToRect } from './world';
import { rectsOverlap } from './towns';

export interface WaitGroup { line: number; alight: number; dest: number; count: number }

export interface Rect { x: number; z: number; angle: number; w: number; d: number }

export interface RailPart {
  x: number; z: number; y: number;
  /** axis direction (radians): tracks run along (sin a, cos a) */
  angle: number;
  length: number;
  tracks: number;
  /** lateral offsets of tracks and platforms (right of axis = positive) */
  trackOffsets: number[];
  platforms: { off: number; w: number }[];
  edges: number[];
  building: Rect;
}

export interface BusStop { edge: number; s: number; x: number; z: number }

export interface Station {
  id: number;
  name: string;
  owner: number;
  townId: number;
  x: number; z: number;
  rail: RailPart | null;
  stops: BusStop[];
  waiting: Map<string, WaitGroup>;
  waitingTotal: number;
  rating: number;
  lastPickup: number;
  lastSpeed: number;
  catchPop: number;
  genAccum: number;
  genMonth: number; genLast: number;
  pickupMonth: number; pickupLast: number;
  arrivedMonth: number; arrivedLast: number;
  built: number;
}

const SUFFIXES = ['Central', 'North', 'South', 'East', 'West', 'Park', 'Market', 'Bridge', 'Heights', 'Square', 'Junction', 'Gardens', 'Cross', 'Halt', 'Parkway', 'Road'];

/** Station layout across the tracks: island platforms between pairs of tracks. */
export function stationLayout(tracks: number): { trackOffsets: number[]; platforms: { off: number; w: number }[]; width: number } {
  const PW = 0.62, CL = 0.21; // platform width, platform edge to track centre
  const items: { kind: 't' | 'p'; w: number }[] = [];
  for (let i = 0; i < tracks; i++) {
    if (i % 2 === 0) { if (i === tracks - 1) { items.push({ kind: 't', w: 0 }); items.push({ kind: 'p', w: PW }); } else { items.push({ kind: 't', w: 0 }); items.push({ kind: 'p', w: PW }); } }
    else items.push({ kind: 't', w: 0 });
  }
  // compute positions
  const pos: number[] = [];
  let x = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      if (prev.kind === 't' && it.kind === 't') x += RAIL.spacing + 0.1;
      else if (prev.kind === 't' && it.kind === 'p') x += CL + it.w / 2;
      else if (prev.kind === 'p' && it.kind === 't') x += prev.w / 2 + CL;
    }
    pos.push(x);
  }
  const mid = (pos[0] + pos[pos.length - 1]) / 2;
  const trackOffsets: number[] = [], platforms: { off: number; w: number }[] = [];
  items.forEach((it, i) => { if (it.kind === 't') trackOffsets.push(pos[i] - mid); else platforms.push({ off: pos[i] - mid, w: it.w }); });
  const width = pos[pos.length - 1] - pos[0] + 0.7;
  return { trackOffsets, platforms, width };
}

export interface StationPlan {
  ok: boolean;
  error?: string;
  x: number; z: number; y: number; angle: number;
  length: number; tracks: number;
  layout: ReturnType<typeof stationLayout>;
  footprint: Rect;
  building: Rect;
  demolish: number[];
  cost: number;
  join: Station | null;
}

export class Stations {
  map = new Map<number, Station>();
  nextId = 1;
  constructor(private game: Game) {
    const net = game.world.net;
    net.onSplit.push((old, e1, e2, s) => {
      for (const st of this.map.values()) {
        for (const stop of st.stops) {
          if (stop.edge !== old.id) continue;
          if (stop.s < s) stop.edge = e1.id; else { stop.edge = e2.id; stop.s -= s; }
        }
        if (st.rail) {
          const i = st.rail.edges.indexOf(old.id);
          if (i >= 0) st.rail.edges.splice(i, 1, e1.id, e2.id);
        }
      }
    });
    net.onRemove.push((e) => {
      for (const st of [...this.map.values()]) {
        const before = st.stops.length;
        st.stops = st.stops.filter((p) => p.edge !== e.id);
        if (st.rail) st.rail.edges = st.rail.edges.filter((x) => x !== e.id);
        if (st.stops.length !== before && !st.stops.length && !st.rail) this.deleteStation(st.id);
      }
    });
  }

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  private create(x: number, z: number, owner: number): Station {
    const g = this.game;
    const town = g.towns.nearest(x, z);
    const used = new Set([...this.map.values()].map((s) => s.name));
    let name = town ? town.name : 'Station';
    if (used.has(name)) {
      let dirName = '';
      if (town) {
        const dx = x - town.x, dz = z - town.z;
        if (Math.hypot(dx, dz) < 8) dirName = 'Central';
        else if (Math.abs(dx) > Math.abs(dz)) dirName = dx > 0 ? 'East' : 'West';
        else dirName = dz > 0 ? 'South' : 'North';
      }
      name = '';
      for (const s of [dirName, ...SUFFIXES].filter(Boolean)) { const n = `${town ? town.name : 'Station'} ${s}`; if (!used.has(n)) { name = n; break; } }
      if (!name) name = `${town ? town.name : 'Station'} ${this.nextId}`;
    }
    const st: Station = {
      id: this.nextId++, name, owner, townId: town ? town.id : -1, x, z, rail: null, stops: [],
      waiting: new Map(), waitingTotal: 0, rating: 0.65, lastPickup: g.day, lastSpeed: 0,
      catchPop: 0, genAccum: 0, genMonth: 0, genLast: 0, pickupMonth: 0, pickupLast: 0, arrivedMonth: 0, arrivedLast: 0, built: g.day,
    };
    this.map.set(st.id, st);
    return st;
  }

  deleteStation(id: number) {
    const st = this.map.get(id);
    if (!st) return;
    this.map.delete(id);
    this.game.lines.onStationRemoved(id);
    this.game.world.markObjArea(st.x - 20, st.z - 20, st.x + 20, st.z + 20);
  }

  hasRail(st: Station) { return !!st.rail; }
  hasRoad(st: Station) { return st.stops.length > 0; }

  /** Collision rectangles of station structures. */
  footprints(st: Station): Rect[] {
    if (!st.rail) return [];
    const r = st.rail;
    return [{ x: r.x, z: r.z, angle: r.angle, w: stationLayout(r.tracks).width, d: r.length }, r.building];
  }
  footprintsNear(x: number, z: number, r: number): Station[] {
    const out: Station[] = [];
    for (const st of this.map.values()) {
      if (!st.rail) continue;
      if (Math.hypot(st.rail.x - x, st.rail.z - z) > st.rail.length + 10 + r) continue;
      for (const f of this.footprints(st)) if (distToRect(x, z, f.x, f.z, f.angle, f.w / 2, f.d / 2) <= r) { out.push(st); break; }
    }
    return out;
  }

  // ---------------------------------------------------------------- rail stations
  planRail(x: number, z: number, angle: number, length: number, tracks: number, owner: number): StationPlan {
    const g = this.game;
    const w = g.world;
    const layout = stationLayout(tracks);
    const fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx;
    const footprint: Rect = { x, z, angle, w: layout.width, d: length };
    const bw = Math.min(length * 0.4, 5), bd = 1.5;
    const boff = layout.width / 2 + bd / 2 + 0.15;
    const building: Rect = { x: x - rx * boff, z: z - rz * boff, angle: angle + Math.PI / 2, w: bw, d: bd };
    const plan: StationPlan = { ok: true, x, z, y: 0, angle, length, tracks, layout, footprint, building, demolish: [], cost: 0, join: null };
    const failp = (e: string) => { if (plan.ok) { plan.ok = false; plan.error = e; } };
    // terrain level: average over the footprint
    let sum = 0, cnt = 0, mn = Infinity, mx = -Infinity;
    for (let a = -0.5; a <= 0.5; a += 0.125) for (let b = -0.5; b <= 0.5; b += 0.25) {
      const px = x + fx * length * a + rx * layout.width * b, pz = z + fz * length * a + rz * layout.width * b;
      if (!w.inside(px, pz, 2)) failp('Too close to the map edge');
      const h = w.heightAt(px, pz);
      if (h < 0.1) failp('Cannot build on water');
      sum += h; cnt++; mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    plan.y = Math.max(0.3, sum / cnt);
    if (mx - mn > 3) failp('Ground is too uneven');
    // obstacles: buildings (demolished), network edges (blocked)
    const demolish = new Set<number>();
    for (const rect of [footprint, building]) {
      const R = Math.hypot(rect.w, rect.d) / 2 + 1;
      for (const id of w.bgrid.query(rect.x - R, rect.z - R, rect.x + R, rect.z + R)) {
        const b = w.buildings.get(id);
        if (b && rectsOverlap(rect, b, 0.05)) demolish.add(id);
      }
      for (const e of w.net.edgesNear(rect.x - R, rect.z - R, rect.x + R, rect.z + R)) {
        const geo = w.net.geo(e);
        const hw = w.net.halfWidth(e);
        for (let i = 0; i < geo.n; i++) {
          if (distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2) < hw - 0.05) {
            if (w.net.sectionAt(e, geo.cum[i]) === 'ground' || Math.abs(geo.pts[i * 3 + 1] - plan.y) < 1) { failp(e.kind === 'rail' ? 'Track in the way' : 'Road in the way'); break; }
          }
        }
      }
      for (const st of this.footprintsNear(rect.x, rect.z, R)) {
        for (const f of this.footprints(st)) if (rectsOverlap(rect, f, 0)) failp('Station in the way');
      }
      if (g.depots.near(rect.x, rect.z, R).length) failp('Depot in the way');
    }
    plan.demolish = [...demolish];
    let cost = tracks * length * 9000 + 120000 + Math.abs(mx - mn) * length * layout.width * 600;
    for (const id of plan.demolish) { const b = w.buildings.get(id); if (b) cost += 6000 + b.pop * 2500; }
    plan.cost = Math.round(cost);
    // join a nearby station of the same owner (bus stops nearby)
    for (const st of this.map.values()) {
      if (st.owner !== owner || st.rail) continue;
      if (st.stops.some((p) => Math.hypot(p.x - x, p.z - z) < length / 2 + 10)) { plan.join = st; break; }
    }
    return plan;
  }

  commitRail(plan: StationPlan, owner: number): string | null {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    if (!plan.ok) return plan.error ?? 'Cannot build';
    const co = g.company(owner);
    if (!co.economy.spend(plan.cost, 'construction')) return 'Not enough money';
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const st = plan.join ?? this.create(plan.x, plan.z, owner);
    const fx = Math.sin(plan.angle), fz = Math.cos(plan.angle), rx = fz, rz = -fx;
    const L = plan.length;
    const edges: NEdge[] = [];
    for (const off of plan.layout.trackOffsets) {
      const cx = plan.x + rx * off, cz = plan.z + rz * off;
      const ax = cx - fx * L / 2, az = cz - fz * L / 2, bx = cx + fx * L / 2, bz = cz + fz * L / 2;
      const na = net.addNode('rail', ax, plan.y, az, fx, fz, owner);
      const nb = net.addNode('rail', bx, plan.y, bz, fx, fz, owner);
      const m = Math.max(2, Math.ceil(L) + 1);
      const prof = new Float32Array(m).fill(plan.y);
      const e = net.addEdge('rail', na.id, nb.id, bezLine(ax, az, bx, bz), prof, [], 'standard', owner, { station: st.id });
      edges.push(e);
    }
    st.rail = {
      x: plan.x, z: plan.z, y: plan.y, angle: plan.angle, length: L, tracks: plan.tracks,
      trackOffsets: plan.layout.trackOffsets, platforms: plan.layout.platforms, edges: edges.map((e) => e.id), building: plan.building,
    };
    st.x = plan.x; st.z = plan.z;
    // level the ground under the whole station
    this.levelGround(plan);
    applyEarthworks(w, edges);
    for (const f of this.footprints(st)) w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.5);
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  private levelGround(plan: StationPlan) {
    const w = this.game.world;
    const rects = [plan.footprint, plan.building];
    const R = Math.hypot(plan.footprint.w, plan.footprint.d) / 2 + 6;
    for (let z = Math.floor(plan.z - R); z <= Math.ceil(plan.z + R); z++) for (let x = Math.floor(plan.x - R); x <= Math.ceil(plan.x + R); x++) {
      if (x < 1 || z < 1 || x >= w.size || z >= w.size) continue;
      let d = Infinity;
      for (const r of rects) d = Math.min(d, distToRect(x, z, r.x, r.z, r.angle, r.w / 2 + 0.3, r.d / 2 + 0.3));
      const k = w.vi(x, z);
      if (w.lock[k] & 2) continue;
      const cur = w.h[k];
      const target = plan.y - 0.1;
      const ext = Math.min(5, Math.abs(target - cur) * 1.6 + 0.6);
      if (d > ext) continue;
      const f = d / ext;
      const wgt = d <= 0 ? 1 : 1 - f * f * (3 - 2 * f);
      w.setVertex(x, z, cur + (target - cur) * wgt);
      if (d <= 0) w.lock[k] |= 1;
    }
  }

  /** Remove a whole station (platform edges, stops). */
  removeStation(id: number): string | null {
    const g = this.game;
    const st = this.map.get(id);
    if (!st) return null;
    if (st.rail) for (const eid of st.rail.edges) if (g.vehicles.isEdgeBusy(eid)) return 'Train in the station';
    if (st.rail) for (const eid of st.rail.edges) g.world.net.removeEdge(eid);
    st.rail = null;
    this.deleteStation(id);
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  // ---------------------------------------------------------------- bus stops
  planBusStop(x: number, z: number, owner: number): { ok: boolean; error?: string; edge?: NEdge; s?: number; px?: number; pz?: number; cost: number; join: Station | null } {
    const g = this.game;
    const net = g.world.net;
    const ne = net.nearestEdge(x, z, 1.4, 'road', (e) => e.depot < 0);
    if (!ne) return { ok: false, error: 'Click on a road', cost: 0, join: null };
    const e = ne.edge;
    const ra = net.junctionRadius(e.a) + 0.9, rb = net.junctionRadius(e.b) + 0.9;
    if (ne.s < ra || ne.s > e.len - rb) return { ok: false, error: 'Too close to a junction', cost: 0, join: null };
    if (net.sectionAt(e, ne.s) !== 'ground') return { ok: false, error: 'Cannot build on a bridge or in a tunnel', cost: 0, join: null };
    for (const st of this.map.values()) for (const p of st.stops) if (p.edge === e.id && Math.abs(p.s - ne.s) < 1.6) return { ok: false, error: 'Another stop is too close', cost: 0, join: null };
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(e, ne.s, p);
    let join: Station | null = null;
    for (const st of this.map.values()) {
      if (st.owner !== owner) continue;
      const near = st.rail ? this.footprints(st).some((f) => distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < 8) : st.stops.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3);
      if (near) { join = st; break; }
    }
    return { ok: true, edge: e, s: ne.s, px: p.x, pz: p.z, cost: 30000, join };
  }

  commitBusStop(x: number, z: number, owner: number): string | null {
    const g = this.game;
    const p = this.planBusStop(x, z, owner);
    if (!p.ok) return p.error!;
    if (!g.company(owner).economy.spend(p.cost, 'construction')) return 'Not enough money';
    const st = p.join ?? this.create(p.px!, p.pz!, owner);
    st.stops.push({ edge: p.edge!.id, s: p.s!, x: p.px!, z: p.pz! });
    if (!st.rail) { st.x = st.stops.reduce((a, q) => a + q.x, 0) / st.stops.length; st.z = st.stops.reduce((a, q) => a + q.z, 0) / st.stops.length; }
    g.world.net.markEdge(p.edge!);
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  removeStop(st: Station, idx: number) {
    const stop = st.stops[idx];
    if (!stop) return;
    st.stops.splice(idx, 1);
    const e = this.game.world.net.edges.get(stop.edge);
    if (e) this.game.world.net.markEdge(e);
    if (!st.stops.length && !st.rail) this.deleteStation(st.id);
    this.game.lines.rebuild();
  }

  // ---------------------------------------------------------------- catchment & passengers
  /** Buildings within the catchment of a station. */
  catchmentBuildings(st: Station): number[] {
    const w = this.game.world;
    const out = new Set<number>();
    const add = (x: number, z: number, r: number) => {
      for (const id of w.bgrid.query(x - r, z - r, x + r, z + r)) {
        const b = w.buildings.get(id);
        if (b && Math.hypot(b.x - x, b.z - z) <= r) out.add(id);
      }
    };
    if (st.rail) add(st.rail.x, st.rail.z, STATION_RADIUS + st.rail.length / 2);
    for (const p of st.stops) add(p.x, p.z, BUSSTOP_RADIUS);
    return [...out];
  }

  catchmentRadius(st: Station) { return st.rail ? STATION_RADIUS + st.rail.length / 2 : BUSSTOP_RADIUS; }

  recomputeCatchment() {
    const w = this.game.world;
    const cover = new Map<number, Station[]>();
    for (const st of this.map.values()) {
      st.catchPop = 0;
      for (const b of this.catchmentBuildings(st)) {
        let arr = cover.get(b);
        if (!arr) { arr = []; cover.set(b, arr); }
        arr.push(st);
      }
    }
    for (const [bid, arr] of cover) {
      const b = w.buildings.get(bid);
      if (!b) continue;
      const act = arr.filter((s) => this.game.lines.stationServed(s.id));
      const list = act.length ? act : arr;
      let sum = 0;
      for (const s of list) sum += s.rating + 0.05;
      for (const s of list) s.catchPop += (b.pop * (s.rating + 0.05)) / sum;
    }
  }

  addWaiting(st: Station, line: number, alight: number, dest: number, count: number) {
    if (count <= 0) return;
    const key = line + ':' + alight + ':' + dest;
    const g = st.waiting.get(key);
    if (g) g.count += count;
    else st.waiting.set(key, { line, alight, dest, count });
    st.waitingTotal += count;
  }

  trimWaiting(st: Station, max: number) {
    if (st.waitingTotal <= max) return;
    const f = max / st.waitingTotal;
    let tot = 0;
    for (const [k, g] of st.waiting) {
      g.count = Math.floor(g.count * f);
      if (g.count <= 0) st.waiting.delete(k); else tot += g.count;
    }
    st.waitingTotal = tot;
  }

  rerouteWaiting(st: Station) {
    const lines = this.game.lines;
    const old = [...st.waiting.values()];
    st.waiting.clear();
    st.waitingTotal = 0;
    for (const g of old) {
      const hop = lines.nextHop(st.id, g.dest);
      if (hop) this.addWaiting(st, hop.line, hop.alight, g.dest, g.count);
    }
  }

  /** Platform edges of a station. */
  platformEdges(st: Station): number[] { return st.rail ? st.rail.edges : []; }
}

export { ROAD_TYPES };
