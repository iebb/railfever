// Derived pedestrian catchments. Road direction and ownership do not restrict walking.
import type { Game } from './game';
import type { Building } from './world';
import { curvePoint, type NEdge, type EdgeGeo } from './network';
import type { Snap } from './construction';
import type { Station, StationPlan, CatchMode, RailMode, EntrancePlan } from './stations';
import { CATCHMENT_RADIUS, ENTRANCE_SIZE, entranceKind, entranceLandings, landingReach, railWalkScale, planWalkScale } from './stations';
import { ROAD_TYPES } from './constants';
import { closestOnPolyline, arcTable, bezPoint, tAtS } from './geom';
import { styleOf } from './station-styles';
import { SpatialGrid, RegionVersions, type RegionSnapshot } from './spatial';

/** A square grid's Manhattan isochrone has area 2L². 1.25 makes it close to πR² (−0.5%). */
export const WALK_DETOUR = 1.25;
/** Maximum off-street walk from a building's facade door to its frontage on a road. */
export const FRONTAGE_REACH = 3;
/** Walking budget along streets: the mode's nominal limit (one for every rail station), building bonus, grid allowance. */
export const walkLimit = (mode: CatchMode, bonus = 0) => CATCHMENT_RADIUS[mode] * (1 + bonus) * WALK_DETOUR;
/**
 * Weight by the street walk (units): nearer stations get more. Scale 8 -> 5.6 with the 30% shorter limits. One curve
 * of the physical walk for every station, whatever its type: an in-city metro / light-rail station (stations.ts
 * CITY_WALK_SCALE) only reaches no farther (its walking limit is halved).
 */
export const walkWeight = (distance: number) => 1 / (1 + distance / 5.6);
/**
 * Residents within this walk (units along streets) of the stations that reach them are fully covered. Farther ones
 * walk less often: their coverage falls with the walking weight, relative to its value here (about 0.6 at a rail
 * station's full reach). Full coverage and the weight's distance scale both shrink by 30%, preserving the taper.
 * Shares never sum past 1.
 */
export const FULL_COVER_WALK = 14.7;
export const FULL_COVER_WEIGHT = walkWeight(FULL_COVER_WALK);
/**
 * How much of a building its stations cover, from the best walking weight among them: wholly within FULL_COVER_WALK,
 * beyond that partly. Its stations share this in proportion to their weights (share = weight / sum * coverOf(best)):
 * more stops at the same distance split the same coverage, they never add to it.
 */
export const coverOf = (best: number) => Math.min(1, best / FULL_COVER_WEIGHT);

/** One building claim per public station, then split that claim among its physical serving members. */
export function walkClaimShares(claims: { group: number; weight: number }[]): number[] {
  const groups = new Map<number, { best: number; sum: number }>();
  let best = 0;
  for (const c of claims) {
    const group = groups.get(c.group);
    if (group) { group.best = Math.max(group.best, c.weight); group.sum += c.weight; }
    else groups.set(c.group, { best: c.weight, sum: c.weight });
    best = Math.max(best, c.weight);
  }
  let sum = 0; for (const group of groups.values()) sum += group.best;
  const cover = coverOf(best);
  return claims.map(c => {
    const group = groups.get(c.group)!;
    return sum > 0 && group.sum > 0 ? group.best / sum * cover * (c.weight / group.sum) : 0;
  });
}

/** Prospective public identity from admitted plan joins/passages; physical stop IDs and route order stay intact. */
export function prospectiveWalkGroups(g: Game, points: readonly (Station | StationPlan | { x: number; z: number })[]) {
  const parents = new Map<number, number>();
  const find = (id: number): number => {
    const parent = parents.get(id);
    if (parent === undefined || parent === id) return id;
    const root = find(parent); parents.set(id, root); return root;
  };
  const join = (a: number, b: number) => { a = find(a); b = find(b); if (a !== b) parents.set(Math.max(a, b), Math.min(a, b)); };
  const groups = points.map((p, i) => {
    const built = 'id' in p ? p.id : 'join' in p ? p.join?.id : undefined;
    return built === undefined ? -i - 1 : g.stations.catchmentGroup(built);
  });
  points.forEach((p, i) => {
    if ('id' in p || !('links' in p)) return;
    for (const st of p.links) if (g.stations.get(st.id)) join(groups[i], g.stations.catchmentGroup(st.id));
  });
  return { groups: groups.map(find), native: (id: number) => find(g.stations.catchmentGroup(id)) };
}

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
/**
 * A building a station reaches: `distance`, its nearest walk along streets (units, physical: its walking weight and
 * coverage follow it alike at every station, walkWeight / coverOf); `limit`, the walking budget of the access point
 * that reaches it (a bus stop's, a rail part's: half the rail limit at an in-city metro / light-rail station).
 */
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

const segmentGrids = new WeakMap<EdgeGeo, SpatialGrid>();
/** Identical ordered projections to closestOnPolyline, visiting only nearby segments of long roads. */
function closestRoad(x: number, z: number, geo: EdgeGeo, reach: number) {
  const xs = geo.pts, pad = reach + 1e-8, x0 = x - pad, z0 = z - pad, x1 = x + pad, z1 = z + pad;
  let ids: number[] | undefined;
  if (geo.n >= 128) {
    let grid = segmentGrids.get(geo);
    if (!grid) {
      grid = new SpatialGrid(4);
      for (let i = 0; i < geo.n - 1; i++) {
        const ax = xs[i * 3], az = xs[i * 3 + 2], bx = xs[(i + 1) * 3], bz = xs[(i + 1) * 3 + 2];
        grid.insert(i, Math.min(ax, bx), Math.min(az, bz), Math.max(ax, bx), Math.max(az, bz));
      }
      segmentGrids.set(geo, grid);
    }
    ids = grid.query(x0, z0, x1, z1).sort((a, b) => a - b);
  }
  let best = Infinity, bi = 0, bf = 0;
  for (let k = 0, n = ids ? ids.length : geo.n - 1; k < n; k++) {
    const i = ids ? ids[k] : k;
    const ax = xs[i * 3], az = xs[i * 3 + 2], bx = xs[(i + 1) * 3], bz = xs[(i + 1) * 3 + 2];
    if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (az < z0 && bz < z0) || (az > z1 && bz > z1)) continue;
    const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
    let f = l2 > 1e-12 ? ((x - ax) * dx + (z - az) * dz) / l2 : 0;
    f = f < 0 ? 0 : f > 1 ? 1 : f;
    const qx = ax + dx * f, qz = az + dz * f, d = (x - qx) * (x - qx) + (z - qz) * (z - qz);
    if (d < best) { best = d; bi = i; bf = f; }
  }
  return { i: bi, f: bf, d: Math.sqrt(best) };
}

function snapRoad(g: Game, x: number, z: number, reach: number): RoadPoint | null {
  const net = g.world.net;
  let best: RoadPoint | null = null;
  for (const id of net.grid.query(x - reach, z - reach, x + reach, z + reach)) {
    const e = net.edges.get(id);
    if (!e || !pedestrianRoad(e)) continue;
    const geo = net.geo(e), c = closestRoad(x, z, geo, reach);
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

/**
 * A station's own forecourt street, where snapRoad finds no street at ground level: its dead end at the forecourt,
 * whatever lies there. The street is laid before the station levels its ground, so its first metres can end up below
 * (or above) the levelled forecourt; the station's steps bridge that, as Stations.railReachable assumes.
 */
function forecourtStreet(g: Game, x: number, z: number, reach: number): RoadPoint | null {
  const net = g.world.net;
  let best: RoadPoint | null = null;
  for (const id of net.grid.query(x - reach, z - reach, x + reach, z + reach)) {
    const e = net.edges.get(id);
    if (!e || !pedestrianRoad(e)) continue;
    for (const [node, s] of [[e.a, 0], [e.b, e.len]] as const) {
      const n = net.nodes.get(node);
      if (!n || n.edges.length !== 1) continue;
      const d = Math.hypot(n.x - x, n.z - z);
      if (d > reach || (best && (d > best.leg || (d === best.leg && id > best.edge)))) continue;
      best = { edge: id, s, leg: d, x, z };
    }
  }
  return best;
}

/** Can a walk start from (x, z) onto a street within `reach` (on the ground, at about its height, not across water)? */
export function walkableStreetNear(g: Game, x: number, z: number, reach: number): boolean { return !!snapRoad(g, x, z, reach); }

function pointOnRoad(g: Game, edge: number, s: number, mode: CatchMode, bonus = 0): Access | null {
  const e = g.world.net.edges.get(edge);
  if (!e || !pedestrianRoad(e)) return null;
  const p = { x: 0, y: 0, z: 0 }; s = Math.max(0, Math.min(e.len, s)); g.world.net.pointAt(e, s, p);
  return { edge, s, leg: 0, x: p.x, z: p.z, mode, limit: walkLimit(mode, bonus) };
}

/**
 * Access is individual: an unconnected entrance contributes nothing even if another entrance works. `skip`: leave
 * out that entrance (what it alone adds, see walkingCatchmentWithout).
 */
function stationAccess(g: Game, st: Station, skip = -1): Access[] {
  const out: Access[] = [], r = st.rail;
  if (!st.roadAccess) return out;
  if (r) {
    // (an in-city metro / light-rail station: every rail access point walks half as far, its entrances too)
    const mode: CatchMode = 'rail', scale = railWalkScale(st), limit = walkLimit(mode, styleOf(r.style).catchBonus) * scale;
    const add = (p: { x: number; z: number } | null | undefined, reach: number, forecourt = false) => {
      if (!p) return;
      const q = snapRoad(g, p.x, p.z, reach) ?? (forecourt ? forecourtStreet(g, p.x, p.z, reach) : null);
      if (q) out.push({ ...q, mode, limit });
    };
    const level = r.level ?? 'ground';
    if (level === 'ground') {
      const reach = styleOf(r.style).placement === 'none' ? 1.6 : 0.9;
      add(g.stations.forecourt(st), reach, true); add(r.forecourt2, reach, true);
      // added entrances: a side hall or gate, a footbridge's / underpass's stairs on either side of the tracks
      r.entrances.forEach((e, i) => { if (i !== skip) for (const p of entranceLandings(e)) add(p, landingReach(entranceKind(level, e))); });
    } else {
      r.entrances.forEach((e, i) => { if (i !== skip) add(e, ENTRANCE_SIZE[level].d / 2 + 0.9); });
      if (styleOf(r.style).placement !== 'none') add(r.forecourt, 0.9);
    }
    // A road stop inside a merged station gives access to its rail platforms too (at the rail part's reach).
    for (const stop of st.stops) {
      const q = pointOnRoad(g, stop.edge, stop.s, mode, styleOf(r.style).catchBonus);
      if (q) out.push(scale === 1 ? q : { ...q, limit: q.limit * scale });
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

interface Cached {
  bounds: Access[]; roads: RegionSnapshot; terrain: RegionSnapshot; lots?: RegionSnapshot;
  roadState: Map<number, [number, string, number, boolean, number]>; roadFallback: number;
  complexEpoch: number; neighbors: number[]; reaches: Reach[]; portals: Portal[];
  byEdge: Map<number, number[]>; geometry: Map<number, { len: number; a: number; b: number; geo: EdgeGeo }>; segments?: WalkSegment[]; value: WalkingCatchment;
}
interface StationAccess {
  key: string; points: Access[]; roads: RegionSnapshot; terrain: RegionSnapshot; version: number; order: number;
  links: string; extent: number; x: number; z: number;
}

function regionIds(points: { x: number; z: number; limit: number }[]): number[] {
  const ids = new Set<number>();
  for (const p of points) {
    const r = p.limit + FRONTAGE_REACH;
    for (const id of RegionVersions.ids([p.x - r, p.z - r, p.x + r, p.z + r])) ids.add(id);
  }
  return [...ids];
}
function sameAccess(a: Access[], b: Access[]): boolean {
  return a.length === b.length && a.every((p, i) => {
    const q = b[i];
    return p.edge === q.edge && p.s === q.s && p.leg === q.leg && p.x === q.x && p.z === q.z && p.mode === q.mode && p.limit === q.limit;
  });
}
function samePortals(a: Access[], b: Access[]): boolean {
  return a === b || (a.length === b.length && a.every((p, i) => {
    const q = b[i]; return p.edge === q.edge && p.s === q.s && p.leg === q.leg && p.x === q.x && p.z === q.z;
  }));
}

class WalkingCache {
  private entries = new Map<string, Cached>();
  private frontages = new Map<number, { x: number; z: number; roads: RegionSnapshot; roadFallback: number;
    terrain: RegionSnapshot; terrainFallback: number; point: RoadPoint | null }>();
  private accesses = new Map<number, StationAccess>();
  private sharedAccess = new Map<number, { ids: number[]; inputs: Access[][]; points: Access[] }>();
  private complexGrid = new SpatialGrid(32);
  private complexEpoch = 0;
  private syncedStations = -1;
  private syncedRoads = -1;
  private syncedTerrain = -1;
  private syncedCount = -1;
  private prunedLots = -1;
  private roadCheckSerial = 0;
  constructor(private g: Game) {}

  refreshBuildings() {
    this.syncStations();
    if (this.prunedLots === this.g.world.lotVersions.version) return;
    this.prunedLots = this.g.world.lotVersions.version;
    for (const id of this.frontages.keys()) if (!this.g.world.buildings.has(id)) this.frontages.delete(id);
  }
  roadsChanged(): boolean {
    for (const [key, c] of this.entries) if (key.startsWith('station:') && !this.sameRoads(c)) return true;
    return false;
  }
  /** The road versions a station's walk was last computed against (its catchment group's entry), if cached. */
  roadSnapshot(st: Station): RegionSnapshot | undefined { return this.entries.get(`station:${this.g.stations.catchmentGroup(st.id)}`)?.roads; }

  private roadState(ids: number[]): Map<number, [number, string, number, boolean, number]> {
    const net = this.g.world.net, out = new Map<number, [number, string, number, boolean, number]>();
    for (const region of ids) for (const id of net.roadRegions.get(region) ?? []) {
      const e = net.edges.get(id); if (e?.kind === 'road' && !out.has(id)) out.set(id, [e.version, e.type, e.depot, pedestrianRoad(e), 0]);
    }
    return out;
  }
  private sameRoads(c: Cached): boolean {
    const roads = this.g.world.net.roadVersions;
    if (roads.unchanged(c.roads)) return true;
    if (roads.fallbackVersion !== c.roadFallback) return false;
    // A failed build can add and remove a road before the tick ends. Compare exact local inputs in that
    // rare case, using the event-maintained membership index; no spatial queries, sorting or signatures.
    const net = this.g.world.net, serial = ++this.roadCheckSerial;
    let count = 0;
    for (const region of c.roads.ids) for (const id of net.roadRegions.get(region) ?? []) {
      const e = net.edges.get(id); if (e?.kind !== 'road') continue;
      const old = c.roadState.get(id);
      if (old?.[4] === serial) continue;
      if (!old || old[0] !== e.version || old[1] !== e.type || old[2] !== e.depot || old[3] !== pedestrianRoad(e)) return false;
      old[4] = serial; count++;
    }
    if (count !== c.roadState.size) return false;
    roads.refresh(c.roads);
    return true;
  }

  /** Scan station metadata once per edit, never once per station's walking calculation. */
  private syncStations() {
    const g = this.g, w = g.world, roads = w.net.roadVersions, terrain = w.terrainVersions;
    if (this.syncedStations === g.stations.walkVersion && this.syncedRoads === roads.version &&
      this.syncedTerrain === terrain.version && this.syncedCount === g.stations.map.size) return;
    this.syncedStations = g.stations.walkVersion; this.syncedRoads = roads.version;
    this.syncedTerrain = terrain.version; this.syncedCount = g.stations.map.size;
    let order = 0;
    for (const st of g.stations.map.values()) {
      const r = st.rail;
      const key = JSON.stringify([st.x, st.z, st.roadAccess, r?.length, r?.trackType, r?.style, r?.level,
        r?.building, r?.forecourt, r?.forecourt2, r?.entrances, st.stops, st.links, railWalkScale(st)]);
      const old = this.accesses.get(st.id);
      if (old && old.key === key && roads.unchanged(old.roads) && terrain.unchanged(old.terrain)) { old.order = order++; continue; }
      let points = stationAccess(g, st);
      if (old && sameAccess(old.points, points)) points = old.points;
      // A station that lost every access point keeps no catchment entry: its old roads must not keep triggering
      // roadsChanged (a game loaded since never made that entry, and must see the same triggers).
      if (!points.length) this.entries.delete(`station:${st.id}`);
      // Access snapping can gain a new contact even for a station with no current access points.
      const extent = r ? r.length / 2 + 28 : 10;
      const ids = RegionVersions.ids([st.x - extent, st.z - extent, st.x + extent, st.z + extent]);
      // Unusually placed entrances/merged stops also need their own local dependencies.
      for (const p of [g.stations.forecourt(st), r?.forecourt2, ...(r?.entrances ?? []).flatMap(entranceLandings), ...st.stops])
        if (p) ids.push(...RegionVersions.ids([p.x - 4, p.z - 4, p.x + 4, p.z + 4]));
      const links = old?.key === key ? old.links : st.links.join(',');
      // Other stations use these portals' geometry and passages, not this station's style or walking budget.
      const version = old && samePortals(old.points, points) && old.links === links ? old.version : ++this.complexEpoch;
      if (old && (old.x !== st.x || old.z !== st.z || old.extent !== extent)) this.complexEpoch++;
      this.accesses.set(st.id, { key, points, roads: roads.snapshot(ids), terrain: terrain.snapshot(ids), version, order: order++,
        links, extent, x: st.x, z: st.z });
      this.complexGrid.insert(st.id, st.x - extent, st.z - extent, st.x + extent, st.z + extent);
    }
    for (const id of this.accesses.keys()) if (!g.stations.map.has(id)) {
      this.accesses.delete(id); this.complexGrid.remove(id); this.entries.delete(`station:${id}`); this.complexEpoch++;
      this.sharedAccess.delete(id);
    }
  }

  access(st: Station): Access[] { this.syncStations(); return this.accesses.get(st.id)!.points; }

  /** Every physical part uses one union of actual landings, each with its own unchanged walking budget. */
  station(st: Station, without = -1): WalkingCatchment {
    this.syncStations();
    const ids = [...this.g.stations.catchmentMembers(st.id)].sort((a, b) => this.accesses.get(a)!.order - this.accesses.get(b)!.order);
    const main = Math.min(...ids), key = without < 0 ? `station:${main}` : `without:${st.id}:${without}`;
    const inputs = ids.map(id => id === st.id && without >= 0 ? stationAccess(this.g, st, without) : this.accesses.get(id)!.points);
    const old = without < 0 ? this.sharedAccess.get(main) : undefined;
    let points: Access[];
    if (old && old.ids.length === ids.length && ids.every((id, i) => id === old.ids[i] && inputs[i] === old.inputs[i])) points = old.points;
    else {
      points = inputs.flat();
      if (without < 0) this.sharedAccess.set(main, { ids, inputs, points });
    }
    if (!points.length) { this.entries.delete(key); return EMPTY; }
    return this.calculate(key, points, true, without >= 0 ? { id: st.id, points: inputs[ids.indexOf(st.id)] } : undefined);
  }

  /** Warm lots/terrain only. Observing pending road edits here would alter refreshAccess's dirty trigger. */
  prepare(st: Station) {
    const key = `station:${this.g.stations.catchmentGroup(st.id)}`, c = this.entries.get(key);
    if (!c || !this.g.world.net.roadVersions.unchanged(c.roads)) return;
    this.station(st);
  }

  private nearby(sources: Access[]): number[] {
    const ids = new Set<number>();
    for (const s of sources) for (const id of this.complexGrid.query(s.x - s.limit, s.z - s.limit, s.x + s.limit, s.z + s.limit)) {
      const st = this.g.stations.map.get(id)!;
      const extent = st.rail ? st.rail.length / 2 + 28 : 10;
      if (Math.hypot(st.x - s.x, st.z - s.z) <= s.limit + extent) ids.add(id);
    }
    // Preserve the original Map iteration order: it controls Dijkstra tie and floating-point sum order.
    return [...ids].sort((a, b) => this.accesses.get(a)!.order - this.accesses.get(b)!.order);
  }

  private frontage(b: Building): RoadPoint | null {
    const x = b.x + Math.sin(b.angle) * b.d / 2, z = b.z + Math.cos(b.angle) * b.d / 2;
    const w = this.g.world, roads = w.net.frontageRoadVersions, old = this.frontages.get(b.id);
    if (old && old.x === x && old.z === z && old.roadFallback === w.net.roadVersions.fallbackVersion && roads.unchanged(old.roads) &&
      old.terrainFallback === w.terrainVersions.fallbackVersion && w.frontageTerrainVersions.unchanged(old.terrain)) return old.point;
    const ids = RegionVersions.ids([x - FRONTAGE_REACH, z - FRONTAGE_REACH, x + FRONTAGE_REACH, z + FRONTAGE_REACH], roads.cell);
    const point = snapRoad(this.g, x, z, FRONTAGE_REACH);
    const terrainIds = RegionVersions.ids([x - FRONTAGE_REACH, z - FRONTAGE_REACH, x + FRONTAGE_REACH, z + FRONTAGE_REACH], w.frontageTerrainVersions.cell);
    this.frontages.set(b.id, { x, z, roads: roads.snapshot(ids), roadFallback: w.net.roadVersions.fallbackVersion,
      terrain: w.frontageTerrainVersions.snapshot(terrainIds),
      terrainFallback: w.terrainVersions.fallbackVersion, point }); return point;
  }

  /** `own`: a station whose passages use these access points instead of its own (a station less one entrance). */
  calculate(key: string, sources: Access[], complex = true, own?: { id: number; points: Access[] }): WalkingCatchment {
    if (!sources.length) return EMPTY;
    this.syncStations();
    const g = this.g, w = g.world, net = w.net;
    let c = this.entries.get(key), nearby: number[] | undefined, neighbors: number[] | undefined;
    const terrainChanged = !c || !w.terrainVersions.unchanged(c.terrain);
    // Terrain can change facade connectors, but Dijkstra depends only on roads and snapped portals.
    let graphChanged = !c || (c.bounds !== sources && !sameAccess(c.bounds, sources)) || !this.sameRoads(c);
    if (complex && (!c || c.complexEpoch !== this.complexEpoch)) {
      nearby = this.nearby(sources);
      neighbors = nearby.flatMap((id) => [id, this.accesses.get(id)!.version]);
      if (!c || neighbors.length !== c.neighbors.length || neighbors.some((v, i) => v !== c!.neighbors[i])) graphChanged = true;
    }
    if (graphChanged) {
      const portals: Portal[] = sources.map((s) => ({ ...s, jumps: [] }));
      const addPortal = (p: RoadPoint) => { const i = portals.length; portals.push({ ...p, jumps: [] }); return i; };
      // Explicit station complexes are pedestrian passages. Rail edges themselves are never walkable.
      if (complex) {
        nearby ??= this.nearby(sources);
        neighbors ??= nearby.flatMap((id) => [id, this.accesses.get(id)!.version]);
        const access = new Map<number, number[]>();
        for (const id of nearby) {
          const pts = (id === own?.id ? own.points : this.accesses.get(id)!.points).filter((p) => sources.some((s) => Math.hypot(p.x - s.x, p.z - s.z) <= s.limit));
          if (!pts.length) continue;
          const ids = pts.map(addPortal); access.set(id, ids);
          const join = (a: number, b: number) => {
            const p = portals[a], q = portals[b], cost = p.leg + Math.hypot(p.x - q.x, p.z - q.z) + q.leg;
            p.jumps.push({ to: b, cost }); q.jumps.push({ to: a, cost });
          };
          for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) join(ids[a], ids[b]);
        }
        for (const id of nearby) for (const to of g.stations.map.get(id)!.links) {
          if (id >= to) continue;
          for (const a of access.get(id) ?? []) for (const b of access.get(to) ?? []) {
            const p = portals[a], q = portals[b], cost = p.leg + Math.hypot(p.x - q.x, p.z - q.z) + q.leg;
            p.jumps.push({ to: b, cost }); q.jumps.push({ to: a, cost });
          }
        }
      }
      const byEdge = new Map<number, number[]>();
      portals.forEach((p, i) => { const a = byEdge.get(p.edge); if (a) a.push(i); else byEdge.set(p.edge, [i]); });
      const groups = new Map<string, number[]>();
      sources.forEach((s, i) => { const k = `${s.mode}:${s.limit}`, a = groups.get(k); if (a) a.push(i); else groups.set(k, [i]); });
      const reaches = [...groups.values()].map((ids) => this.dijkstra(sources[ids[0]], ids, portals, byEdge));
      const ids = regionIds(sources);
      // Pin immutable sampled geometry so a deferred UI read remains valid even after roads are edited.
      const geometry = new Map<number, { len: number; a: number; b: number; geo: EdgeGeo }>();
      for (const reach of reaches) for (const id of reach.edges) if (!geometry.has(id)) {
        const e = net.edges.get(id)!; geometry.set(id, { len: e.len, a: e.a, b: e.b, geo: net.geo(e) });
      }
      c = { bounds: sources, roads: net.roadVersions.snapshot(ids), terrain: w.terrainVersions.snapshot(ids),
        roadState: this.roadState(ids), roadFallback: net.roadVersions.fallbackVersion,
        complexEpoch: this.complexEpoch, neighbors: neighbors ?? [], reaches, portals, byEdge, geometry, value: EMPTY };
      c.value = this.value(c, new Map());
      this.entries.set(key, c);
      // Hover/site estimates are disposable; station entries persist until that station is removed.
      if (this.entries.size > g.stations.map.size + 80) for (const k of this.entries.keys()) if (!k.startsWith('station:')) { this.entries.delete(k); break; }
    }
    c = c!;
    c.complexEpoch = this.complexEpoch;
    if (!c.lots || !w.lotVersions.unchanged(c.lots) || terrainChanged) {
      // With unchanged walking paths, an attributed lot edit only needs that building's distance.
      const squares = sources.map((s) => { const r = s.limit + FRONTAGE_REACH; return [s.x - r, s.z - r, s.x + r, s.z + r]; });
      const changed = !graphChanged && !terrainChanged && c.lots ? w.changedLots(c.lots) : null;
      const ids = changed ?? new Set<number>(), buildings = changed ? new Map(c.value.buildings) : new Map<number, WalkBuilding>();
      if (!changed) for (const q of squares) for (const id of w.bgrid.query(q[0], q[1], q[2], q[3])) ids.add(id);
      for (const id of ids) {
        buildings.delete(id);
        const b = w.buildings.get(id); if (!b) continue;
        if (changed) {
          const box = w.bgrid.box(id);
          let inside = false;
          if (box) for (const q of squares) if (box[0] <= q[2] && box[2] >= q[0] && box[1] <= q[3] && box[3] >= q[1]) { inside = true; break; }
          if (!inside) continue;
        }
        const p = this.frontage(b); if (!p) continue;
        for (const reach of c.reaches) {
          const d = this.distance(reach, p.edge, p.s, c.portals, c.byEdge) + p.leg;
          if (d > reach.limit + 1e-8) continue;
          if (d < (buildings.get(id)?.distance ?? Infinity)) buildings.set(id, { distance: d, limit: reach.limit });
        }
      }
      c.value = this.value(c, buildings); c.lots = w.lotVersions.snapshot(c.roads.ids);
      c.terrain = w.terrainVersions.snapshot(c.roads.ids);
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

  private value(c: Cached, buildings: Map<number, WalkBuilding>): WalkingCatchment {
    const self = this;
    return { get segments() { return c.segments ??= self.segments(c.reaches, c.portals, c.byEdge, c.geometry); }, buildings };
  }

  private segments(reaches: Reach[], portals: Portal[], byEdge: Map<number, number[]>, geometry: Cached['geometry']): WalkSegment[] {
    const out: WalkSegment[] = [];
    for (const r of reaches) for (const id of r.edges) {
      const { len, a, b, geo } = geometry.get(id)!;
      const spans: [number, number][] = [];
      const add = (s: number, d: number) => { if (d <= r.limit) spans.push([Math.max(0, s - (r.limit - d)), Math.min(len, s + (r.limit - d))]); };
      add(0, r.nodes.get(a) ?? Infinity); add(len, r.nodes.get(b) ?? Infinity);
      for (const i of byEdge.get(id) ?? []) add(portals[i].s, r.portals.get(i) ?? Infinity);
      spans.sort((a, b) => a[0] - b[0]);
      const merged: [number, number][] = [];
      for (const span of spans) { const last = merged[merged.length - 1]; if (last && span[0] <= last[1]) last[1] = Math.max(last[1], span[1]); else merged.push([...span]); }
      for (const [s0, s1] of merged) {
        const n = Math.ceil((s1 - s0) / 2), p = { x: 0, y: 0, z: 0 }; curvePoint(geo, s0, p);
        for (let i = 1; i <= n; i++) {
          const x0 = p.x, z0 = p.z, a = s0 + (s1 - s0) * (i - 1) / n, b = s0 + (s1 - s0) * i / n;
          curvePoint(geo, b, p); out.push({ x0, z0, x1: p.x, z1: p.z, edge: id, s0: a, s1: b, mode: r.mode });
        }
      }
    }
    return out;
  }
}

const caches = new WeakMap<Game, WalkingCache>();
function cache(g: Game): WalkingCache { let c = caches.get(g); if (!c) { c = new WalkingCache(g); caches.set(g, c); } return c; }
// Read-only geometry has its own cache: observing an edit must not consume the simulation's road-dirty trigger.
const viewCaches = new WeakMap<Game, WalkingCache>();
function viewCache(g: Game): WalkingCache {
  let c = viewCaches.get(g);
  if (!c) { c = new WalkingCache(g); viewCaches.set(g, c); }
  return c;
}
/** Current walking geometry without refreshing saved access or simulation dependencies; optionally omit an entrance. */
export function readWalkingCatchment(g: Game, st: Station, without = -1): WalkingCatchment {
  return viewCache(g).station(st, without);
}
/** Prepare local caches once for a share update; unchanged regions and station paths survive. */
export function refreshWalkBuildings(g: Game) { cache(g).refreshBuildings(); }
export function walkRoadsChanged(g: Game): boolean { return cache(g).roadsChanged(); }
/** The road versions of a station's last computed walk (Stations: the versions of the published share-out). */
export function walkRoadSnapshot(g: Game, st: Station): RegionSnapshot | undefined { return cache(g).roadSnapshot(st); }
export function prepareWalkingCatchment(g: Game, st: Station) { cache(g).prepare(st); }
export function walkingCatchment(g: Game, st: Station): WalkingCatchment {
  g.stations.refreshAccess();
  return cache(g).station(st);
}
/**
 * A station's walking catchment without one of its entrances (the station window: what each entrance newly covers is
 * the station's catchment less this one).
 */
export function walkingCatchmentWithout(g: Game, st: Station, entrance: number): WalkingCatchment {
  g.stations.refreshAccess();
  return cache(g).station(st, entrance);
}
/**
 * Walking catchment from extra access points of a station on their own (an entrance being planned or valued, or one
 * entrance's reach): the one rail reach and the station building's bonus; passages through the station lead only
 * between these points. Each point snaps to a road within `reach`; `legScale` stretches that walk (a street still to be built
 * rarely runs straight) and `leg` is walked before it.
 */
export function extraAccessCatchment(g: Game, st: Station, points: { x: number; z: number; reach: number; leg?: number; legScale?: number }[], readOnly = false): WalkingCatchment {
  const r = st.rail;
  if (!r) return EMPTY;
  const mode: CatchMode = 'rail', scale = railWalkScale(st), limit = walkLimit(mode, styleOf(r.style).catchBonus) * scale, sources: Access[] = [];
  for (const p of points) {
    const q = snapRoad(g, p.x, p.z, p.reach);
    if (q) sources.push({ ...q, leg: q.leg * (p.legScale ?? 1) + (p.leg ?? 0), mode, limit });
  }
  return (readOnly ? viewCache(g) : cache(g)).calculate(`extra:${st.id}:${sources.map((q) => `${q.edge}:${q.s}:${q.leg}`).join('|')}`, sources, true, { id: st.id, points: sources });
}
/** One entrance's own walking catchment (what its landings reach on their own). */
export function entranceCatchment(g: Game, st: Station, entrance: number, readOnly = false): WalkingCatchment {
  const r = st.rail, e = r?.entrances[entrance];
  if (!r || !e) return EMPTY;
  const level = r.level ?? 'ground', k = entranceKind(level, e);
  const reach = level === 'ground' ? landingReach(k) : ENTRANCE_SIZE[level].d / 2 + 0.9;
  return extraAccessCatchment(g, st, entranceLandings(e).map((p) => ({ x: p.x, z: p.z, reach })), readOnly);
}
/** An entrance's geometry for passive views, isolated from the simulation's walking dependencies. */
export function readEntranceCatchment(g: Game, st: Station, entrance: number): WalkingCatchment {
  return entranceCatchment(g, st, entrance, true);
}
/**
 * Walking catchment of a planned entrance on its own: its landings on a road, or the end of its access street. The
 * buildings its access street demolishes are left out (a forecast copy; the cached catchment stays as it is).
 */
export function entrancePlanCatchment(g: Game, st: Station, plan: EntrancePlan): WalkingCatchment {
  const walk = entranceStreetsCatchment(g, st, plan), gone = plan.access?.demolish ?? [];
  if (!gone.some((id) => walk.buildings.has(id))) return walk;
  const buildings = new Map(walk.buildings);
  for (const id of gone) buildings.delete(id);
  return { get segments() { return walk.segments; }, buildings };
}
function entranceStreetsCatchment(g: Game, st: Station, plan: EntrancePlan): WalkingCatchment {
  const r = st.rail;
  if (!r || !plan.entrance) return EMPTY;
  const k = entranceKind(r.level ?? 'ground', plan.entrance), reach = landingReach(k);
  const points: { x: number; z: number; reach: number; leg?: number }[] = plan.landings.filter((p) => p.road && !plan.access).map((p) => ({ x: p.x, z: p.z, reach }));
  if (plan.access) {
    // the new street: walked to its far end (where it meets the road network), then on along the streets
    const door = plan.door ?? plan.landings[0];
    for (const t of plan.access.tracks) for (const sn of [t.start, t.end]) {
      if (Math.hypot(sn.x - door.x, sn.z - door.z) < 0.5) continue;
      points.push({ x: sn.x, z: sn.z, reach: 0.6, leg: plan.access.stats.len + 0.6 });
    }
    for (const p of plan.landings.slice(1)) if (p.road) points.push({ x: p.x, z: p.z, reach });
  }
  return extraAccessCatchment(g, st, points);
}

/** Independent cache, for exact incremental/full checks without mutating the live walking cache. */
export function fullWalkingCatchments(g: Game): Map<number, WalkingCatchment> {
  const c = new WalkingCache(g), out = new Map<number, WalkingCatchment>();
  for (const st of g.stations.map.values()) out.set(st.id, c.station(st));
  return out;
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
  // (an in-city metro / light-rail station walks half as far: planWalkScale)
  const mode: CatchMode = 'rail', bonus = styleOf(plan.style).catchBonus, scale = planWalkScale(plan), limit = walkLimit(mode, bonus) * scale, sources: Access[] = [];
  const add = (p: { x: number; z: number } | null | undefined, reach: number) => { if (p) { const q = snapRoad(g, p.x, p.z, reach); if (q) sources.push({ ...q, mode, limit }); } };
  if (plan.level === 'ground') { add(plan.forecourt, styleOf(plan.style).placement === 'none' ? 1.6 : 0.9); add(plan.forecourt2, 0.9); }
  else { for (const e of plan.entrances) add(e, ENTRANCE_SIZE[plan.level].d / 2 + 0.9); if (styleOf(plan.style).placement !== 'none') add(plan.forecourt, 0.9); }
  if (plan.access) for (const track of plan.access.tracks) for (const sn of [track.start, track.end]) {
    const p = accessSnap(g, sn, mode, bonus, plan.access.stats.len); if (p) sources.push(scale === 1 ? p : { ...p, limit });
  }
  if (plan.join) sources.push(...cache(g).access(plan.join).map((p) => ({ ...p, mode, limit })));
  if (plan.join) for (const id of g.stations.catchmentMembers(plan.join.id)) if (id !== plan.join.id) sources.push(...cache(g).access(g.stations.get(id)!));
  const linked = new Set<number>();
  for (const st of plan.links) for (const id of g.stations.catchmentMembers(st.id)) if (!linked.has(id) && id !== plan.join?.id) {
    linked.add(id); sources.push(...cache(g).access(g.stations.get(id)!));
  }
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

/**
 * A city railway stop's catchment before it is planned (citycatch: AI forecasts of in-city stops). An in-city stop below
 * or above the street has its entrances on the streets by both platform ends and both sides (Stations.entranceSites,
 * the AI asks for four), each at the stop's reach (`scale`): walks start there, at the street, not at the site. A stop
 * walking its full reach is estimated from the one point at the site, as before.
 */
export function stopSiteWalkingCatchment(g: Game, x: number, z: number, angle: number, length: number, mode: CatchMode, scale: number): WalkingCatchment {
  if (scale === 1) return pointWalkingCatchment(g, x, z, mode, 0, 8);
  const fx = Math.sin(angle), fz = Math.cos(angle), limit = walkLimit(mode) * scale, out: Access[] = [];
  // (an entrance stands on the pavement: its walk starts as close to the street as a built one's, ENTRANCE_SIZE)
  const leg = ENTRANCE_SIZE.underground.d / 2 + 0.9;
  for (const [a, b] of [[length / 2, 0], [-length / 2, 0], [0, 5], [0, -5]]) {
    const q = snapRoad(g, x + fx * a + fz * b, z + fz * a - fx * b, 8);
    if (q) out.push({ ...q, leg: Math.min(q.leg, leg), mode, limit });
  }
  return out.length ? cache(g).calculate(`citysite:${x}:${z}:${angle}:${length}:${mode}:${scale}`, out) : EMPTY;
}

export function pointWalkingCatchment(g: Game, x: number, z: number, mode: CatchMode, bonus = 0, reach = FRONTAGE_REACH): WalkingCatchment {
  const q = snapRoad(g, x, z, reach);
  return q ? cache(g).calculate(`point:${x}:${z}:${mode}:${bonus}`, [{ ...q, mode, limit: walkLimit(mode, bonus) }]) : EMPTY;
}

export function stopWalkingCatchment(g: Game, edge: number, s: number, mode: 'tram' | 'bus'): WalkingCatchment {
  const q = pointOnRoad(g, edge, s, mode);
  return q ? cache(g).calculate(`stop:${edge}:${s}:${mode}`, [q]) : EMPTY;
}

/** Fast AI site estimate, deliberately beginning at the nearest usable road node. Any rail style walks as 'rail'. */
export function walkSitePop(g: Game, x: number, z: number, mode: CatchMode | RailMode | 'road'): number {
  const cm: CatchMode = mode === 'road' ? 'bus' : mode === 'tram' || mode === 'bus' ? mode : 'rail';
  const net = g.world.net, limit = walkLimit(cm);
  const usable = (n: { edges: number[] }) => n.edges.some((id) => { const e = net.edges.get(id); return !!e && pedestrianRoad(e); });
  let n = net.nearestNode(x, z, limit, 'road', usable);
  for (let radius = limit * 2; !n && radius <= g.world.size * 3; radius *= 2) n = net.nearestNode(x, z, radius, 'road', usable);
  if (!n) return 0;
  const eid = n.edges.find((id) => { const e = net.edges.get(id); return !!e && pedestrianRoad(e); })!, e = net.edges.get(eid)!;
  const p = pointOnRoad(g, eid, e.a === n.id ? 0 : e.len, cm)!;
  return walkingPopulation(g, cache(g).calculate(`site:${n.id}:${cm}`, [p], false));
}
