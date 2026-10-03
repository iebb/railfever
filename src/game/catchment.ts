// Derived pedestrian catchments. Road direction and ownership do not restrict walking.
import type { Game } from './game';
import type { Building } from './world';
import type { NEdge } from './network';
import type { Snap } from './construction';
import type { Station, StationPlan, CatchMode, RailMode } from './stations';
import { CATCHMENT_RADIUS, ENTRANCE_SIZE, catchModeOf, railModeOf } from './stations';
import { ROAD_TYPES } from './constants';
import { closestOnPolyline, arcTable, bezPoint, tAtS } from './geom';
import { styleOf } from './station-styles';

/** A square grid's Manhattan isochrone has area 2L². 1.25 makes it close to πR² (−0.5%). */
export const WALK_DETOUR = 1.25;
/** Maximum off-street walk from a building's facade door to its frontage on a road. */
export const FRONTAGE_REACH = 3;
export const walkLimit = (mode: CatchMode, bonus = 0) => CATCHMENT_RADIUS[mode] * (1 + bonus) * WALK_DETOUR;

export function pedestrianRoad(e: NEdge): boolean {
  return e.kind === 'road' && e.depot < 0 && ROAD_TYPES[e.type]?.pedestrians !== false;
}

interface RoadPoint { edge: number; s: number; leg: number; x: number; z: number }
interface Access extends RoadPoint { mode: CatchMode; limit: number }
interface Portal extends RoadPoint { jumps: { to: number; cost: number }[] }
interface Reach {
  mode: CatchMode; limit: number; nodes: Map<number, number>; portals: Map<number, number>;
  edges: Set<number>;
}
export interface WalkSegment { x0: number; z0: number; x1: number; z1: number; edge: number; s0: number; s1: number; mode: CatchMode }
export interface WalkBuilding { distance: number; limit: number }
export interface WalkingCatchment {
  /** Only reachable portions of streets, clipped at the walking budget. */
  segments: WalkSegment[];
  buildings: Map<number, WalkBuilding>;
}
const EMPTY: WalkingCatchment = { segments: [], buildings: new Map() };

/** Short surface connectors cannot jump across water or attach to an overhead/underground road. */
function dryLeg(g: Game, x: number, z: number, qx: number, qz: number): boolean {
  const n = Math.max(1, Math.ceil(Math.hypot(qx - x, qz - z) / 0.4));
  for (let i = 0; i <= n; i++) if (g.world.isWater(x + (qx - x) * i / n, z + (qz - z) * i / n)) return false;
  return true;
}

function snapRoad(g: Game, x: number, z: number, reach: number): RoadPoint | null {
  const net = g.world.net;
  let best: RoadPoint | null = null;
  for (const id of net.grid.query(x - reach, z - reach, x + reach, z + reach)) {
    const e = net.edges.get(id);
    if (!e || !pedestrianRoad(e)) continue;
    const geo = net.geo(e), c = closestOnPolyline(x, z, geo.pts, 3, geo.n);
    if (c.d > reach || (best && (c.d > best.leg || (c.d === best.leg && id > best.edge)))) continue;
    // Geometry's Float32 arc table can round its last sample past e.len. Clamp before using graph costs:
    // an out-of-edge portal would otherwise introduce a negative endpoint leg into a zero-length passage.
    const s = Math.max(0, Math.min(e.len, geo.cum[c.i] + (geo.cum[Math.min(geo.n - 1, c.i + 1)] - geo.cum[c.i]) * c.f));
    if (net.sectionAt(e, s) !== 'ground') continue;
    const p = { x: 0, y: 0, z: 0 }; net.pointAt(e, s, p);
    if (Math.abs(p.y - g.world.heightAt(p.x, p.z)) > 0.8 || !dryLeg(g, x, z, p.x, p.z)) continue;
    best = { edge: id, s, leg: c.d, x, z };
  }
  return best;
}

function pointOnRoad(g: Game, edge: number, s: number, mode: CatchMode, bonus = 0): Access | null {
  const e = g.world.net.edges.get(edge);
  if (!e || !pedestrianRoad(e)) return null;
  const p = { x: 0, y: 0, z: 0 }; s = Math.max(0, Math.min(e.len, s)); g.world.net.pointAt(e, s, p);
  return { edge, s, leg: 0, x: p.x, z: p.z, mode, limit: walkLimit(mode, bonus) };
}

/** Access is individual: an unconnected entrance contributes nothing even if another entrance works. */
function stationAccess(g: Game, st: Station): Access[] {
  const out: Access[] = [], r = st.rail;
  if (!st.roadAccess) return out;
  if (r) {
    const mode = catchModeOf(railModeOf(r.trackType)), limit = walkLimit(mode, styleOf(r.style).catchBonus);
    const add = (p: { x: number; z: number } | null | undefined, reach: number) => {
      if (!p) return;
      const q = snapRoad(g, p.x, p.z, reach);
      if (q) out.push({ ...q, mode, limit });
    };
    const level = r.level ?? 'ground';
    if (level === 'ground') {
      const reach = styleOf(r.style).placement === 'none' ? 1.6 : 0.9;
      add(g.stations.forecourt(st), reach); add(r.forecourt2, reach);
    } else {
      for (const e of r.entrances) add(e, ENTRANCE_SIZE[level].d / 2 + 0.9);
      if (styleOf(r.style).placement !== 'none') add(r.forecourt, 0.9);
    }
    // A road stop inside a merged station gives access to its rail platforms too.
    for (const stop of st.stops) {
      const q = pointOnRoad(g, stop.edge, stop.s, mode, styleOf(r.style).catchBonus);
      if (q) out.push(q);
    }
  }
  for (const stop of st.stops) {
    const q = pointOnRoad(g, stop.edge, stop.s, g.world.net.edges.get(stop.edge)?.tram ? 'tram' : 'bus');
    if (q) out.push(q);
  }
  return out;
}

/** Small binary heap: visits only nodes/portals inside the bounded walking distance. */
class Heap {
  private a: { id: number; d: number }[] = [];
  push(id: number, d: number) {
    const p = { id, d }, a = this.a; let i = a.length; a.push(p);
    while (i > 0) { const j = (i - 1) >> 1; if (a[j].d <= d) break; a[i] = a[j]; i = j; } a[i] = p;
  }
  pop(): { id: number; d: number } | undefined {
    const a = this.a, p = a[0], tail = a.pop();
    if (a.length && tail) {
      let i = 0;
      while (i * 2 + 1 < a.length) {
        let j = i * 2 + 1;
        if (j + 1 < a.length && a[j + 1].d < a[j].d) j++;
        if (a[j].d >= tail.d) break; a[i] = a[j]; i = j;
      }
      a[i] = tail;
    }
    return p;
  }
}

interface Region { net: number; lots: string; roadSig: string; lotSig: string; roadVersion: number; lotVersion: number }
interface Cached { roadKey: string; networkKey: string; bounds: Access[]; lotKey: string; reaches: Reach[]; portals: Portal[]; byEdge: Map<number, number[]>; value: WalkingCatchment }

class WalkingCache {
  private regions = new Map<string, Region>();
  private entries = new Map<string, Cached>();
  private frontages = new Map<number, { key: string; point: RoadPoint | null }>();
  private accesses = new Map<number, { key: string; points: Access[] }>();
  private lotEpoch = 0;
  constructor(private g: Game) {}
  refreshBuildings() {
    this.lotEpoch++;
    for (const key of this.entries.keys()) if (key.startsWith('station:') && !this.g.stations.map.has(Number(key.slice(8)))) this.entries.delete(key);
    for (const id of this.accesses.keys()) if (!this.g.stations.map.has(id)) this.accesses.delete(id);
    for (const id of this.frontages.keys()) if (!this.g.world.buildings.has(id)) this.frontages.delete(id);
  }
  roadsChanged(): boolean {
    for (const [key, c] of this.entries) if (key.startsWith('station:') && this.regionKeys(c.bounds).road !== c.networkKey) return true;
    return false;
  }
  access(st: Station): Access[] {
    const r = st.rail, w = this.g.world;
    const key = `${w.net.version}:${w.heightsVersion}:${st.roadAccess}:${r?.trackType}:${r?.style}:${r?.level}|` +
      JSON.stringify([r?.building, r?.forecourt, r?.forecourt2, r?.entrances, st.stops]);
    const old = this.accesses.get(st.id); if (old?.key === key) return old.points;
    const points = stationAccess(this.g, st); this.accesses.set(st.id, { key, points }); return points;
  }

  /** Region versions change only for local edits. A far-away road does not discard a station's Dijkstra. */
  private region(cx: number, cz: number): Region {
    const g = this.g, w = g.world, net = w.net, key = `${cx},${cz}`, C = 32;
    let r = this.regions.get(key);
    if (!r) { r = { net: -1, lots: '', roadSig: '', lotSig: '', roadVersion: 0, lotVersion: 0 }; this.regions.set(key, r); }
    if (r.net !== net.version) {
      const sig = net.grid.query(cx * C, cz * C, (cx + 1) * C, (cz + 1) * C)
        .map((id) => net.edges.get(id)!).filter((e) => e?.kind === 'road').sort((a, b) => a.id - b.id)
        .map((e) => `${e.id}:${e.version}:${e.type}:${e.depot}:${pedestrianRoad(e)}`).join(';');
      if (sig !== r.roadSig) { r.roadSig = sig; r.roadVersion++; }
      r.net = net.version;
    }
    const lots = `${this.lotEpoch}:${w.nextBuildingId}:${w.buildings.size}`;
    if (r.lots !== lots) {
      const sig = w.bgrid.query(cx * C, cz * C, (cx + 1) * C, (cz + 1) * C)
        .map((id) => w.buildings.get(id)!).filter(Boolean).sort((a, b) => a.id - b.id)
        .map((b) => `${b.id}:${b.x}:${b.z}:${b.angle}:${b.w}:${b.d}`).join(';');
      if (sig !== r.lotSig) { r.lotSig = sig; r.lotVersion++; }
      r.lots = lots;
    }
    return r;
  }

  private regionKeys(points: { x: number; z: number; limit: number }[]): { road: string; lot: string } {
    const seen = new Set<string>(), roads: string[] = [], lots: string[] = [];
    for (const p of points) {
      const r = p.limit + FRONTAGE_REACH;
      for (let cz = Math.floor((p.z - r) / 32); cz <= Math.floor((p.z + r) / 32); cz++) for (let cx = Math.floor((p.x - r) / 32); cx <= Math.floor((p.x + r) / 32); cx++) {
        const key = `${cx},${cz}`; if (seen.has(key)) continue; seen.add(key);
        const v = this.region(cx, cz); roads.push(`${key}:${v.roadVersion}`); lots.push(`${key}:${v.lotVersion}`);
      }
    }
    return { road: roads.join(';'), lot: lots.join(';') + `|${this.g.world.heightsVersion}` };
  }

  private frontage(b: Building): RoadPoint | null {
    const x = b.x + Math.sin(b.angle) * b.d / 2, z = b.z + Math.cos(b.angle) * b.d / 2;
    const key = `${x}:${z}|${this.regionKeys([{ x, z, limit: 0 }]).road}|${this.g.world.heightsVersion}`;
    const old = this.frontages.get(b.id);
    if (old?.key === key) return old.point;
    const point = snapRoad(this.g, x, z, FRONTAGE_REACH); this.frontages.set(b.id, { key, point }); return point;
  }

  calculate(key: string, sources: Access[], complex = true): WalkingCatchment {
    if (!sources.length) return EMPTY;
    const g = this.g, net = g.world.net, versions = this.regionKeys(sources);
    const portals: Portal[] = sources.map((s) => ({ ...s, jumps: [] }));
    const addPortal = (p: RoadPoint) => { const i = portals.length; portals.push({ ...p, jumps: [] }); return i; };
    // Explicit station complexes are pedestrian passages. Rail edges themselves are never walkable.
    if (complex) {
      const access = new Map<number, number[]>();
      for (const st of g.stations.map.values()) {
        const extent = st.rail ? st.rail.length / 2 + 28 : 10;
        if (!sources.some((s) => Math.hypot(st.x - s.x, st.z - s.z) <= s.limit + extent)) continue;
        const pts = this.access(st).filter((p) => sources.some((s) => Math.hypot(p.x - s.x, p.z - s.z) <= s.limit));
        if (!pts.length) continue;
        const ids = pts.map(addPortal); access.set(st.id, ids);
        const join = (a: number, b: number) => {
          const p = portals[a], q = portals[b], cost = p.leg + Math.hypot(p.x - q.x, p.z - q.z) + q.leg;
          p.jumps.push({ to: b, cost }); q.jumps.push({ to: a, cost });
        };
        for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) join(ids[a], ids[b]);
      }
      for (const st of g.stations.map.values()) for (const to of st.links) {
        if (st.id >= to) continue;
        for (const a of access.get(st.id) ?? []) for (const b of access.get(to) ?? []) {
          const p = portals[a], q = portals[b], cost = p.leg + Math.hypot(p.x - q.x, p.z - q.z) + q.leg;
          p.jumps.push({ to: b, cost }); q.jumps.push({ to: a, cost });
        }
      }
    }
    const sig = portals.map((p) => `${p.edge}:${p.s}:${p.leg}:${p.jumps.map((j) => `${j.to}:${j.cost}`).join(',')}`).join(';');
    const roadKey = versions.road + '|' + sources.map((s) => `${s.mode}:${s.limit}`).join(';') + '|' + sig;
    let c = this.entries.get(key);
    if (!c || c.roadKey !== roadKey) {
      const byEdge = new Map<number, number[]>();
      portals.forEach((p, i) => { const a = byEdge.get(p.edge); if (a) a.push(i); else byEdge.set(p.edge, [i]); });
      const groups = new Map<string, number[]>();
      sources.forEach((s, i) => { const k = `${s.mode}:${s.limit}`, a = groups.get(k); if (a) a.push(i); else groups.set(k, [i]); });
      const reaches = [...groups.values()].map((ids) => this.dijkstra(sources[ids[0]], ids, portals, byEdge));
      c = { roadKey, networkKey: versions.road, bounds: sources, lotKey: '', reaches, portals, byEdge, value: { segments: this.segments(reaches, portals, byEdge), buildings: new Map() } };
      this.entries.set(key, c);
      // Hover/site estimates are disposable; station entries persist until that station is removed.
      if (this.entries.size > g.stations.map.size + 80) for (const k of this.entries.keys()) if (!k.startsWith('station:')) { this.entries.delete(k); break; }
    }
    if (c.lotKey !== versions.lot) {
      const ids = new Set<number>(), buildings = new Map<number, WalkBuilding>();
      for (const s of sources) {
        const r = s.limit + FRONTAGE_REACH;
        for (const id of g.world.bgrid.query(s.x - r, s.z - r, s.x + r, s.z + r)) ids.add(id);
      }
      for (const id of ids) {
        const b = g.world.buildings.get(id); if (!b) continue;
        const p = this.frontage(b); if (!p) continue;
        for (const reach of c.reaches) {
          const d = this.distance(reach, p.edge, p.s, c.portals, c.byEdge) + p.leg;
          if (d > reach.limit + 1e-8) continue;
          if (d < (buildings.get(id)?.distance ?? Infinity)) buildings.set(id, { distance: d, limit: reach.limit });
        }
      }
      c.value = { segments: c.value.segments, buildings }; c.lotKey = versions.lot;
    }
    return c.value;
  }

  private dijkstra(source: Access, starts: number[], portals: Portal[], byEdge: Map<number, number[]>): Reach {
    const net = this.g.world.net, nodes = new Map<number, number>(), pd = new Map<number, number>(), edges = new Set<number>(), heap = new Heap();
    const visit = (id: number, d: number) => {
      if (!(d >= 0) || d > source.limit) return;
      const map = id >= 0 ? nodes : pd, k = id >= 0 ? id : -id - 1;
      if (d >= (map.get(k) ?? Infinity)) return; map.set(k, d); heap.push(id, d);
    };
    for (const i of starts) visit(-i - 1, portals[i].leg);
    let next: { id: number; d: number } | undefined;
    while ((next = heap.pop())) {
      const { id, d } = next, pi = -id - 1;
      if (d !== (id >= 0 ? nodes.get(id) : pd.get(pi))) continue;
      const along = (e: NEdge, s: number) => {
        s = Math.max(0, Math.min(e.len, s));
        // Add a nonnegative leg as one term. (d + len) - s can round below d at a zero-length leg,
        // causing spurious improvements around a station passage and an unbounded heap.
        edges.add(e.id); visit(e.a, d + s); visit(e.b, d + (e.len - s));
        for (const j of byEdge.get(e.id) ?? []) visit(-j - 1, d + Math.abs(s - portals[j].s));
      };
      if (id >= 0) {
        for (const eid of net.nodes.get(id)?.edges ?? []) {
          const e = net.edges.get(eid); if (e && pedestrianRoad(e)) along(e, e.a === id ? 0 : e.len);
        }
      } else {
        const p = portals[pi], e = net.edges.get(p.edge);
        if (e && pedestrianRoad(e)) along(e, p.s);
        for (const j of p.jumps) visit(-j.to - 1, d + j.cost);
      }
    }
    return { mode: source.mode, limit: source.limit, nodes, portals: pd, edges };
  }

  private distance(r: Reach, edge: number, s: number, portals: Portal[], byEdge: Map<number, number[]>): number {
    const e = this.g.world.net.edges.get(edge); if (!e) return Infinity;
    let d = Math.min((r.nodes.get(e.a) ?? Infinity) + s, (r.nodes.get(e.b) ?? Infinity) + (e.len - s));
    for (const i of byEdge.get(edge) ?? []) d = Math.min(d, (r.portals.get(i) ?? Infinity) + Math.abs(s - portals[i].s));
    return d;
  }

  private segments(reaches: Reach[], portals: Portal[], byEdge: Map<number, number[]>): WalkSegment[] {
    const net = this.g.world.net, out: WalkSegment[] = [];
    for (const r of reaches) for (const id of r.edges) {
      const e = net.edges.get(id)!;
      const spans: [number, number][] = [];
      const add = (s: number, d: number) => { if (d <= r.limit) spans.push([Math.max(0, s - (r.limit - d)), Math.min(e.len, s + (r.limit - d))]); };
      add(0, r.nodes.get(e.a) ?? Infinity); add(e.len, r.nodes.get(e.b) ?? Infinity);
      for (const i of byEdge.get(id) ?? []) add(portals[i].s, r.portals.get(i) ?? Infinity);
      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const span of spans) { const last = merged[merged.length - 1]; if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
      for (const [s0, s1] of merged) {
        const n = Math.ceil((s1 - s0) / 2), p = { x: 0, y: 0, z: 0 }; net.pointAt(e, s0, p);
        for (let i = 1; i <= n; i++) {
          const x0 = p.x, z0 = p.z, a = s0 + (s1 - s0) * (i - 1) / n, b = s0 + (s1 - s0) * i / n;
          net.pointAt(e, b, p); out.push({ x0, z0, x1: p.x, z1: p.z, edge: id, s0: a, s1: b, mode: r.mode });
        }
      }
    }
    return out;
  }
}

const caches = new WeakMap<Game, WalkingCache>();
function cache(g: Game): WalkingCache { let c = caches.get(g); if (!c) { c = new WalkingCache(g); caches.set(g, c); } return c; }
/** Re-check local building geometry at monthly/structural catchment updates; paths remain cached. */
export function refreshWalkBuildings(g: Game) { cache(g).refreshBuildings(); }
export function walkRoadsChanged(g: Game): boolean { return cache(g).roadsChanged(); }
export function walkingCatchment(g: Game, st: Station): WalkingCatchment {
  g.stations.refreshAccess();
  return cache(g).calculate(`station:${st.id}`, cache(g).access(st));
}
export function walkingPopulation(g: Game, c: WalkingCatchment): number {
  let pop = 0; for (const id of c.buildings.keys()) pop += g.world.buildings.get(id)?.pop ?? 0; return pop;
}

function accessSnap(g: Game, sn: Snap, mode: CatchMode, bonus: number, leg: number): Access | null {
  if (sn.kind === 'edge' && sn.edge !== undefined) { const p = pointOnRoad(g, sn.edge, sn.s ?? 0, mode, bonus); return p ? { ...p, leg } : null; }
  if (sn.kind === 'node' && sn.node !== undefined) {
    for (const id of g.world.net.nodes.get(sn.node)?.edges ?? []) {
      const e = g.world.net.edges.get(id)!; if (!pedestrianRoad(e)) continue;
      const p = pointOnRoad(g, id, e.a === sn.node ? 0 : e.len, mode, bonus); if (p) return { ...p, leg };
    }
  }
  return null;
}

/** Read-only hover estimate. Proposed access streets debit their length before reaching existing roads. */
export function planWalkingCatchment(g: Game, plan: StationPlan): WalkingCatchment {
  if (!plan.roadAccess) return EMPTY;
  const mode = catchModeOf(plan.mode), bonus = styleOf(plan.style).catchBonus, limit = walkLimit(mode, bonus), sources: Access[] = [];
  const add = (p: { x: number; z: number } | null | undefined, reach: number) => { if (p) { const q = snapRoad(g, p.x, p.z, reach); if (q) sources.push({ ...q, mode, limit }); } };
  if (plan.level === 'ground') { add(plan.forecourt, styleOf(plan.style).placement === 'none' ? 1.6 : 0.9); add(plan.forecourt2, 0.9); }
  else { for (const e of plan.entrances) add(e, ENTRANCE_SIZE[plan.level].d / 2 + 0.9); if (styleOf(plan.style).placement !== 'none') add(plan.forecourt, 0.9); }
  if (plan.access) for (const track of plan.access.tracks) for (const sn of [track.start, track.end]) {
    const p = accessSnap(g, sn, mode, bonus, plan.access.stats.len); if (p) sources.push(p);
  }
  if (plan.join) sources.push(...cache(g).access(plan.join).map((p) => ({ ...p, mode, limit })));
  const value = cache(g).calculate(`preview:${plan.x}:${plan.z}:${plan.angle}:${plan.style}:${plan.level}`, sources);
  if (!plan.access && !plan.demolish.length) return value;
  const buildings = new Map(value.buildings), segments = [...value.segments], removed = new Set(plan.demolish);
  // The planned street itself is also walkable. Sample it coarsely for a fast, read-only hover isochrone.
  for (const track of plan.access?.tracks ?? []) {
    const table = arcTable(track.bez), n = Math.max(1, Math.ceil(table.len / 0.5)), pts = new Float32Array((n + 1) * 3), p = { x: 0, z: 0 };
    const fc = plan.forecourt ?? plan, reverse = Math.hypot(track.end.x - fc.x, track.end.z - fc.z) < Math.hypot(track.start.x - fc.x, track.start.z - fc.z);
    const start = reverse ? track.end : track.start, leg = Math.hypot(start.x - fc.x, start.z - fc.z);
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i <= n; i++) {
      bezPoint(track.bez, tAtS(table, table.len * i / n), p);
      pts[i * 3] = p.x; pts[i * 3 + 2] = p.z;
      x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z);
    }
    const budget = Math.max(0, Math.min(table.len, limit - leg)), count = Math.ceil(budget / 2);
    const at = (s: number) => bezPoint(track.bez, tAtS(table, reverse ? table.len - s : s));
    for (let i = 0; i < count; i++) {
      const s0 = budget * i / count, s1 = budget * (i + 1) / count, a = at(s0), b = at(s1);
      segments.push({ x0: a.x, z0: a.z, x1: b.x, z1: b.z, edge: -1, s0, s1, mode });
    }
    for (const id of g.world.bgrid.query(x0 - FRONTAGE_REACH, z0 - FRONTAGE_REACH, x1 + FRONTAGE_REACH, z1 + FRONTAGE_REACH)) {
      const b = g.world.buildings.get(id); if (!b || removed.has(id)) continue;
      const x = b.x + Math.sin(b.angle) * b.d / 2, z = b.z + Math.cos(b.angle) * b.d / 2;
      const c = closestOnPolyline(x, z, pts, 3, n + 1); if (c.d > FRONTAGE_REACH) continue;
      const s = table.len * (c.i + c.f) / n, q = bezPoint(track.bez, tAtS(table, s));
      if (track.sections.some((sec) => s >= sec.s0 && s <= sec.s1) || !dryLeg(g, x, z, q.x, q.z)) continue;
      const distance = leg + (reverse ? table.len - s : s) + c.d;
      if (distance <= limit && distance < (buildings.get(id)?.distance ?? Infinity)) buildings.set(id, { distance, limit });
    }
  }
  for (const id of removed) buildings.delete(id);
  return { segments, buildings };
}

export function pointWalkingCatchment(g: Game, x: number, z: number, mode: CatchMode, bonus = 0, reach = FRONTAGE_REACH): WalkingCatchment {
  const q = snapRoad(g, x, z, reach);
  return q ? cache(g).calculate(`point:${x}:${z}:${mode}:${bonus}`, [{ ...q, mode, limit: walkLimit(mode, bonus) }]) : EMPTY;
}

export function stopWalkingCatchment(g: Game, edge: number, s: number, mode: 'tram' | 'bus'): WalkingCatchment {
  const q = pointOnRoad(g, edge, s, mode);
  return q ? cache(g).calculate(`stop:${edge}:${s}:${mode}`, [q]) : EMPTY;
}

/** Fast AI site estimate, deliberately beginning at the nearest usable road node. */
export function walkSitePop(g: Game, x: number, z: number, mode: CatchMode | RailMode | 'road'): number {
  const cm: CatchMode = mode === 'mainline' ? 'rail' : mode === 'road' ? 'bus' : mode;
  const net = g.world.net, limit = walkLimit(cm);
  const usable = (n: { edges: number[] }) => n.edges.some((id) => { const e = net.edges.get(id); return !!e && pedestrianRoad(e); });
  let n = net.nearestNode(x, z, limit, 'road', usable);
  for (let radius = limit * 2; !n && radius <= g.world.size * 3; radius *= 2) n = net.nearestNode(x, z, radius, 'road', usable);
  if (!n) return 0;
  const eid = n.edges.find((id) => { const e = net.edges.get(id); return !!e && pedestrianRoad(e); })!, e = net.edges.get(eid)!;
  const p = pointOnRoad(g, eid, e.a === n.id ? 0 : e.len, cm)!;
  return walkingPopulation(g, cache(g).calculate(`site:${n.id}:${cm}`, [p], false));
}
