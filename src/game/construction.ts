// Free-form construction planner for tracks and roads.
import type { Game } from './game';
import { NetKind, RAIL, ROAD_TYPES, TRACK_TYPES, PSTEP, WATER_Y, TRAM, LINE_LEVEL, trackTypeOf, ELECTRIFY } from './constants';
import {
  Bez, bezFromTangents, bezLine, bezOffset, bezMinRadius, arcTable, tAtS, bezPoint, bezDeriv, segIntersect, angleBetween, V2,
  closestOnPolyline,
} from './geom';
import { NEdge, NNode, Section, profAt, type EdgeGeo } from './network';
import { SpatialGrid } from './spatial';
import { applyEarthworks, recomputeLocks, coverTunnels, formationDepth, EARTHWORKS, DRY_MIN } from './terraform';
import { distToRect } from './world';
import { demolitionTotal } from './demolition';

const crossingGrids = new WeakMap<EdgeGeo, SpatialGrid>();
const heightRanges = new WeakMap<EdgeGeo, [number, number]>();
/** Lowest and highest point of an edge's sampled geometry (cached with the versioned geometry). */
function heightRange(geo: EdgeGeo): [number, number] {
  let r = heightRanges.get(geo);
  if (!r) {
    r = [Infinity, -Infinity];
    for (let j = 0; j < geo.n; j++) { const y = geo.pts[j * 3 + 1]; if (y < r[0]) r[0] = y; if (y > r[1]) r[1] = y; }
    heightRanges.set(geo, r);
  }
  return r;
}
const pointBounds = new WeakMap<EdgeGeo, Float64Array>();
/** Ordered 32-sample ranges that can contain a point within reach. Bounds use the exact sampled geometry. */
export function geometryPointRanges(geo: EdgeGeo, x: number, z: number, reach: number): number[] | undefined {
  if (geo.n < 128) return undefined;
  let bounds = pointBounds.get(geo);
  if (!bounds) {
    bounds = new Float64Array(Math.ceil(geo.n / 32) * 4);
    for (let i = 0; i < geo.n; i += 32) {
      const k = (i / 32) * 4;
      bounds[k] = bounds[k + 1] = Infinity; bounds[k + 2] = bounds[k + 3] = -Infinity;
      for (let j = i; j < Math.min(geo.n, i + 32); j++) {
        bounds[k] = Math.min(bounds[k], geo.pts[j * 3]); bounds[k + 1] = Math.min(bounds[k + 1], geo.pts[j * 3 + 2]);
        bounds[k + 2] = Math.max(bounds[k + 2], geo.pts[j * 3]); bounds[k + 3] = Math.max(bounds[k + 3], geo.pts[j * 3 + 2]);
      }
    }
    pointBounds.set(geo, bounds);
  }
  const ranges: number[] = [], pad = reach + 1e-8;
  for (let k = 0; k < bounds.length; k += 4) {
    if (x < bounds[k] - pad || z < bounds[k + 1] - pad || x > bounds[k + 2] + pad || z > bounds[k + 3] + pad) continue;
    ranges.push(k / 4 * 32);
  }
  return ranges;
}
/** Ordered candidate segments, using the versioned geometry as the cache key. Short edges need no index. */
export function crossingSegments(geo: EdgeGeo, ax: number, az: number, bx: number, bz: number): number[] | undefined {
  if (geo.n < 128) return undefined;
  let grid = crossingGrids.get(geo);
  if (!grid) {
    grid = new SpatialGrid(4);
    const p = geo.pts;
    for (let j = 0; j < geo.n - 1; j++) grid.insert(j, Math.min(p[j * 3], p[j * 3 + 3]), Math.min(p[j * 3 + 2], p[j * 3 + 5]), Math.max(p[j * 3], p[j * 3 + 3]), Math.max(p[j * 3 + 2], p[j * 3 + 5]));
    crossingGrids.set(geo, grid);
  }
  const pad = 1e-8;
  return grid.query(Math.min(ax, bx) - pad, Math.min(az, bz) - pad, Math.max(ax, bx) + pad, Math.max(az, bz) + pad).sort((a, b) => a - b);
}

export interface Snap {
  kind: 'free' | 'node' | 'edge';
  x: number; z: number; y: number;
  node?: number;
  edge?: number;
  s?: number;
  /** parallel group of nodes (ordered left to right of the group direction) */
  group?: number[];
}

export interface BuildOptions {
  kind: NetKind;
  type: string;
  tracks: number;
  heightOffset: number;
  crossing: 'auto' | 'over' | 'under' | 'level';
  owner: number;
  /** An access-funded upgrade: the builder pays, this company retains the added infrastructure. */
  infrastructureOwner?: number;
  /** Flat junction upgrades may cross at the shallow angle of an existing turnout. */
  junctionUpgrade?: boolean;
  /** Clearance around diamonds in neighbouring pieces of a complete junction plan. */
  junctionWindows?: { edge: number; x: number; z: number; r: number }[];
  /** towns build for free and never demolish */
  town?: boolean;
  /** roads: straight segment with free ends (no tangent continuity at dead ends), e.g. grid streets */
  straight?: boolean;
  /** roads: lay tram tracks (with overhead wire) in the new road, owned by `owner` */
  tram?: boolean;
  /**
   * Build level: 'elevated' = a continuous viaduct `levelHeight` above the ground beneath (LINE_LEVEL),
   * 'underground' = a continuous tunnel `levelDepth` below the ground above; the profile follows the terrain
   * at that offset within the grade limit, with ramps / portals where the line meets track at another
   * level. Default 'ground'.
   */
  level?: 'ground' | 'elevated' | 'underground';
  levelHeight?: number;
  levelDepth?: number;
  /** Planner's speed target: fast routes avoid level crossings and preserve their profiled heights. */
  designSpeed?: number;
  /** Planner's grade budget; the builder and any replacement profile keep the service's chosen grade. */
  designGrade?: number;
  /**
   * With level 'underground': a subway that stays underground the whole way, in tunnel at levelDepth below the
   * ground above (no ramp, no portal). Both ends must be underground (a tunnel, an underground station's platform
   * end, an underground depot's exit) or free; it fails where the track would come up to the surface.
   */
  subway?: boolean;
  /**
   * Plan as if these edges and depots were not there (no crossing, clash or obstacle with them): previews of works that
   * take them up first (an extension whose depot lead is moved out of its way, ai-grow.ts). Never committed as such.
   * city-integration: wip/subway's tunnel clashes and underground station / depot boxes skip them too.
   */
  ignore?: { edges: Set<number>; depots?: Set<number> };
}

export interface CrossingPlan {
  track: number;
  sNew: number;   // along the new track
  edge: number;
  sOld: number;
  x: number; z: number;
  mode: 'level' | 'diamond' | 'junction' | 'over' | 'under';
  angle: number;
}

export interface TrackPlan {
  bez: Bez;
  len: number;
  prof: Float32Array;
  sections: Section[];
  start: Snap;
  end: Snap;
}

export interface Proposal {
  ok: boolean;
  errors: string[];
  warnings: string[];
  opts: BuildOptions;
  tracks: TrackPlan[];
  crossings: CrossingPlan[];
  /** Existing road spans supported over a new cutting, quoted before any construction. */
  roadBridges?: { edge: number; s0: number; s1: number; version: number }[];
  demolish: number[];
  trees: number;
  cost: number;
  stats: {
    len: number; maxGrade: number; minRadius: number; bridges: number; tunnels: number; speed: number;
    /** rail: what sharing the formation saves (further tracks built together, or beside an existing track) */
    sharedSaving?: number;
    /** retaining walls (units of length) where it runs close beside another formation at another height */
    walls?: number;
    /** cost split: track (and road surface) on the ground, bridges / viaducts, tunnels, earthworks, the rest */
    costSplit?: { track: number; bridges: number; tunnels: number; earthworks: number; other: number; demolition?: number };
    /**
     * Tunnels: the buildings a formation on the ground along the same alignment would have taken, and their price
     * (demolition the tunnel saves; shown in the build preview). Absent without tunnels under buildings.
     */
    avoided?: { buildings: number; cost: number };
  };
}

/**
 * Structure cost per unit as a multiple of the bare track (or road) cost per unit (UPDATE 9k: realistic ratios
 * against ground track with its usual earthworks, about 1.25x bare track). Rail bridges cost 3.8–5.6x,
 * shallow tunnels 4.5–6.5x and deep tunnels 6.5–9.7x. These common civil prices let short city services
 * repay the same track as conventional trains; neither station mode nor wire changes the multiplier.
 * Roads retain their bridge 3.5–5x, shallow tunnel 4–6x and deep tunnel 6.5–9x prices.
 */
export function structureFactor(kind: NetKind, type: 'bridge' | 'tunnel', h: number): number {
  if (type === 'bridge') { const k = Math.min(4, Math.max(0, h - 1.1)) / 4; return kind === 'rail' ? 3.8 + 1.8 * k : 3.5 + 1.5 * k; }
  if (h < 2) { const k = Math.min(1, Math.max(0, h - 1)); return kind === 'rail' ? 4.5 + 2 * k : 4 + 2 * k; }
  const k = Math.min(6, h - 2) / 6;
  return kind === 'rail' ? 6.5 + 3.2 * k : 6.5 + 2.5 * k;
}

/** A crossing's support window follows the physical road, including its existing segment boundaries. */
function roadBridgeWorks(g: Game, prop: Proposal): { works: NonNullable<Proposal['roadBridges']>; cost: number; error?: string } {
  const net = g.world.net, works: NonNullable<Proposal['roadBridges']> = [], heights = new Map<number, number>();
  const bad = (error: string) => ({ works, cost: 0, error });
  for (const c of prop.crossings) {
    const e = net.edges.get(c.edge), tp = prop.tracks[c.track];
    if (c.mode !== 'under' || !e || e.kind !== 'road' || !tp || net.sectionAt(e, c.sOld) === 'tunnel'
      || tp.sections.some(q => q.type === 'tunnel' && c.sNew >= q.s0 - 0.5 && c.sNew <= q.s1 + 0.5)) continue;
    const dh = Math.max(0, net.heightAtS(e, c.sOld) - profAt(tp.prof, tp.len, c.sNew));
    const hw = halfWidthOf(prop.opts) + (prop.tracks.length - 1) * RAIL.spacing * 0.5;
    const slope = prop.opts.kind === 'rail' ? EARTHWORKS.slopeRail : EARTHWORKS.slopeRoad;
    const width = Math.min(12, (hw + EARTHWORKS.corePad + dh / slope) / Math.max(0.35, Math.sin(c.angle)) + 0.3);
    const queue = [{ e, s0: c.sOld - width, s1: c.sOld + width }], seen = new Set<number>();
    while (queue.length) {
      const q = queue.shift()!;
      if (seen.has(q.e.id)) return bad('Road loops inside underpass bridge window');
      seen.add(q.e.id);
      const s0 = Math.max(0, q.s0), s1 = Math.min(q.e.len, q.s1);
      if (q.e.sections.some(s => s.type !== 'bridge' && s.s0 < s1 - 1e-6 && s.s1 > s0 + 1e-6))
        return bad('Road structure blocks underpass bridge window');
      works.push({ edge: q.e.id, s0, s1, version: q.e.version });
      heights.set(q.e.id, Math.max(heights.get(q.e.id) ?? 0, dh));
      for (const [node, remain] of [[q.e.a, -q.s0], [q.e.b, q.s1 - q.e.len]]) {
        if (remain <= 1e-6) continue;
        const n = net.nodes.get(node);
        if (!n || n.edges.length !== 2) return bad('Road junction or end blocks underpass bridge window');
        const next = net.edges.get(n.edges.find(id => id !== q.e.id)!);
        if (!next || next.kind !== 'road' || next.depot >= 0 || next.station >= 0)
          return bad('Road facility blocks underpass bridge window');
        queue.push({ e: next, s0: next.a === node ? 0 : next.len - remain, s1: next.a === node ? remain : next.len });
      }
    }
  }
  // Multiple crossings/tracks may quote the same support. Charge only newly supported ground once.
  const merged: typeof works = [];
  for (const q of works.sort((a, b) => a.edge - b.edge || a.s0 - b.s0)) {
    const last = merged[merged.length - 1];
    if (last && last.edge === q.edge && q.s0 <= last.s1 + 1e-6) last.s1 = Math.max(last.s1, q.s1);
    else merged.push({ ...q });
  }
  let cost = 0;
  for (const q of merged) {
    const e = net.edges.get(q.edge)!, per = (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).costPerUnit;
    const cuts = [q.s0, q.s1, ...e.sections.flatMap(s => [Math.max(q.s0, s.s0), Math.min(q.s1, s.s1)])]
      .filter(s => s >= q.s0 && s <= q.s1).sort((a, b) => a - b);
    for (let i = 1; i < cuts.length; i++) {
      if (net.sectionAt(e, (cuts[i - 1] + cuts[i]) / 2) !== 'ground') continue;
      cost += (cuts[i] - cuts[i - 1]) * per * (structureFactor('road', 'bridge', heights.get(e.id) ?? 0) - 1);
    }
  }
  return { works: merged, cost };
}

/**
 * Yearly maintenance of structures per unit, as extra multiples of the track (road) type's maintPerUnit on top
 * of the plain track: bridges and viaducts (bearings, deck, inspection) and tunnels (drainage, ventilation,
 * lighting, lining). For edgeMaintenance / trackMaintenance (companies, ops).
 */
export const STRUCTURE_MAINT = { bridge: 4, tunnel: 6 };

/**
 * Track cost shares where a track shares a graded formation, bridge or tunnel (further tracks built in the
 * same go, or a track laid beside an existing one): materials, structures (bridge / tunnel premium) and
 * earthworks.
 */
export const SHARED_TRACK = { materials: 0.6, structures: 0.35, earthworks: 0.3 };

/** Height of an existing track running parallel beside (x, z) along (tx, tz), 0.25..maxLat across, or null. */
function formationBeside(g: Game, x: number, z: number, tx: number, tz: number, maxLat: number): number | null {
  const net = g.world.net;
  let best: number | null = null, bl = Infinity;
  for (const e of net.edgesNear(x - maxLat, z - maxLat, x + maxLat, z + maxLat)) {
    if (e.kind !== 'rail') continue;
    const ge = net.geo(e);
    let bd = Infinity, bi = 0;
    for (let j = 0; j < ge.n; j++) { const dd = (ge.pts[j * 3] - x) ** 2 + (ge.pts[j * 3 + 2] - z) ** 2; if (dd < bd) { bd = dd; bi = j; } }
    const ex = ge.tan[bi * 2], ez = ge.tan[bi * 2 + 1];
    if (Math.abs(ex * tx + ez * tz) < 0.9) continue;
    const ox = x - ge.pts[bi * 3], oz = z - ge.pts[bi * 3 + 2];
    const lat = Math.abs(ox * ez - oz * ex), along = Math.abs(ox * ex + oz * ez);
    if (lat < 0.25 || lat > maxLat || along > 0.6 || lat >= bl) continue;
    bl = lat;
    best = ge.pts[bi * 3 + 1];
  }
  return best;
}

/**
 * Per track of a rail proposal, per PSTEP sample: does it run beside an existing track (0.25-1.25 units
 * across, parallel, at the same height)? Such stretches share that track's formation, bridges and tunnels.
 */
function besideExisting(g: Game, prop: Proposal): Uint8Array[] {
  const net = g.world.net, p = { x: 0, z: 0 };
  return prop.tracks.map((tp) => {
    const tab = arcTable(tp.bez);
    const n = Math.max(1, Math.ceil(tp.len / PSTEP));
    const out = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const s = Math.min(tp.len, (i + 0.5) * PSTEP), t = tAtS(tab, s);
      bezPoint(tp.bez, t, p);
      const d = bezDeriv(tp.bez, t), dl = Math.hypot(d.x, d.z) || 1;
      const y = profAt(tp.prof, tp.len, s);
      for (const e of net.edgesNear(p.x - 1.3, p.z - 1.3, p.x + 1.3, p.z + 1.3)) {
        if (e.kind !== 'rail') continue;
        const ge = net.geo(e);
        let best = Infinity, bi = 0;
        for (let j = 0; j < ge.n; j++) { const dd = (ge.pts[j * 3] - p.x) ** 2 + (ge.pts[j * 3 + 2] - p.z) ** 2; if (dd < best) { best = dd; bi = j; } }
        const tx = ge.tan[bi * 2], tz = ge.tan[bi * 2 + 1];
        if (Math.abs((tx * d.x + tz * d.z) / dl) < 0.9 || Math.abs(ge.pts[bi * 3 + 1] - y) > 0.35) continue;
        const ox = p.x - ge.pts[bi * 3], oz = p.z - ge.pts[bi * 3 + 2];
        const lat = Math.abs(ox * tz - oz * tx), along = Math.abs(ox * tx + oz * tz);
        if (lat >= 0.25 && lat <= 1.25 && along < 0.6) { out[i] = 1; break; }
      }
    }
    return out;
  });
}

const BRIDGE_H = 1.4;   // >14 m above ground -> bridge (banks first: structures are dear, 9k)
/** town streets are banked up to 20 m before they bridge (towns grade their streets into the slopes, 9i) */
const TOWN_BANK_H = 2.0;

/**
 * Unified track permits road level crossings. Trains slow to 160 km/h there; fast planners choose separation.
 */
export function levelCrossingAllowed(trackType: string): boolean {
  return true;
}
const WATER_DECK = 0.9;
/** storey height of town buildings (towns.ts FLOOR_H; not imported: towns imports this module) */
const FLOOR_H = 0.3;
/** lines built elevated / underground: viaduct from 5 m above the ground, tunnel from 8 m of cover */
const VIADUCT_H = 0.5, TUNNEL_COVER = 0.8;
/**
 * Tunnels through the ground (not built underground): only with real cover — the track at least TUNNEL_DEEP
 * below the surface inside, portals where the cutting is PORTAL_D deep, at least TUNNEL_MIN long, and tunnels
 * closer than TUNNEL_GAP joined into one; anything else is a cutting.
 */
const TUNNEL_DEEP = 2.6, PORTAL_D = 1.2, TUNNEL_MIN = 8, TUNNEL_GAP = 10;
/** A track joining a line runs alongside it this far from its switch (no parallel or formation clash with it). */
const SWITCH_ZONE = 14;
/**
 * Formations side by side share grid vertices: the height differences beyond which they need a retaining wall
 * between them (rail beside rail; a road above a railway, left in the air by its cutting; road beside road). Town
 * streets keep clear of such places; companies build (and pay for) the wall.
 */
const CLASH = { rail: 0.3, roadAbove: 1.0, road: 1.2 };
/** Town streets keep clear of any formation beside them at another height (they have other ways to go). */
const CLASH_TOWN = { rail: 0.15, roadAbove: 0.35, road: 0.4 };
/** Retaining wall cost per unit of length and unit of height (where a formation runs close beside another). */
const RETAINING_WALL = 20000;

/** Nearest point of an edge to (x, z): arc length and distance (a coarse pass over its samples, then refined). */
function nearestOnEdge(net: Game['world']['net'], e: NEdge, x: number, z: number): { s: number; d: number } {
  const g = net.geo(e), n = g.n, pts = g.pts;
  const k = Math.max(1, Math.floor(n / 48));
  let bi = 0, bd = Infinity;
  for (let i = 0; i < n; i += k) { const d = (pts[i * 3] - x) ** 2 + (pts[i * 3 + 2] - z) ** 2; if (d < bd) { bd = d; bi = i; } }
  const i0 = Math.max(0, bi - k), i1 = Math.min(n - 1, bi + k);
  const c = closestOnPolyline(x, z, pts.subarray(i0 * 3, (i1 + 1) * 3), 3, i1 - i0 + 1);
  const j = i0 + c.i;
  return { s: g.cum[j] + (g.cum[Math.min(n - 1, j + 1)] - g.cum[j]) * c.f, d: c.d };
}

/** Least cover over a subway (BuildOptions.subway): the track stays this far below the ground above it. */
export const SUBWAY_COVER = TUNNEL_COVER;

/** Lowest rendered terrain across the full bore. A terrain triangle is linear: its minima along
 * this segment occur at an end or a grid/diagonal boundary, including dips between the two sides. */
function boreTerrain(g: Game, x: number, z: number, nx: number, nz: number, hw: number): number {
  const x0 = x - nx * hw, z0 = z - nz * hw, dx = nx * hw * 2, dz = nz * hw * 2;
  let low = Math.min(g.world.heightAt(x0, z0), g.world.heightAt(x0 + dx, z0 + dz));
  for (const [a, d] of [[x0, dx], [z0, dz], [x0 - z0, dx - dz]]) {
    if (Math.abs(d) < 1e-9) continue;
    for (let k = Math.ceil(Math.min(a, a + d)); k <= Math.floor(Math.max(a, a + d)); k++) {
      const t = (k - a) / d;
      low = Math.min(low, g.world.heightAt(x0 + dx * t, z0 + dz * t));
    }
  }
  return low;
}

/** Is a snap underground: a free point, a point in a tunnel section, or a node whose every edge is in tunnel there. */
export function snapUnderground(g: Game, sn: Snap): boolean {
  const net = g.world.net;
  if (sn.kind === 'free') return true;
  if (sn.kind === 'edge') { const e = net.edges.get(sn.edge!); return !!e && net.sectionAt(e, sn.s!) === 'tunnel'; }
  const n = net.nodes.get(sn.node!);
  if (!n) return false;
  // (a node without track yet, e.g. a planned station's platform end: by its depth)
  if (!n.edges.length) return g.world.heightAt(n.x, n.z) - n.y >= SUBWAY_COVER;
  return n.edges.every((id) => {
    const e = net.edges.get(id);
    return !!e && net.sectionAt(e, e.a === n.id ? Math.min(0.05, e.len) : Math.max(0, e.len - 0.05)) === 'tunnel';
  });
}

/** An underground structure's volume: a station box below ground (platforms and tracks) or an underground depot. */
export interface UndergroundBox { x: number; z: number; angle: number; w: number; d: number; y0: number; y1: number; station?: number; depot?: number }

/**
 * Underground station boxes and underground depots within `pad` of a proposal's tracks, except the stations and
 * depots of the edges it joins (`joined`: edges at its ends and beyond the switches there).
 */
function undergroundBoxes(g: Game, prop: Proposal, pad: number, joined: Set<number>, ignore?: BuildOptions['ignore']): UndergroundBox[] {
  const net = g.world.net;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const tp of prop.tracks) {
    const b = tp.bez;
    for (const [x, z] of [[b.x0, b.z0], [b.x1, b.z1], [b.x2, b.z2], [b.x3, b.z3]]) { x0 = Math.min(x0, x); z0 = Math.min(z0, z); x1 = Math.max(x1, x); z1 = Math.max(z1, z); }
  }
  if (!isFinite(x0)) return [];
  const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2, r = Math.hypot(x1 - x0, z1 - z0) / 2 + pad;
  const skipSt = new Set<number>(), skipDp = new Set<number>();
  for (const id of joined) {
    const e = net.edges.get(id);
    if (!e) continue;
    if (e.station >= 0) skipSt.add(e.station);
    if (e.depot >= 0) skipDp.add(e.depot);
    const th = g.stations.throughStationOf(e.id);
    if (th >= 0) skipSt.add(th);
  }
  const out: UndergroundBox[] = [];
  for (const q of g.stations.undergroundNear(cx, cz, r)) if (!skipSt.has(q.station)) out.push(q);
  for (const q of g.depots.undergroundNear(cx, cz, r)) if (!skipDp.has(q.depot!) && !ignore?.depots?.has(q.depot!)) out.push(q);
  return out;
}

function maxGradeOf(o: BuildOptions) {
  return o.kind === 'rail' ? Math.min((TRACK_TYPES[o.type] ?? TRACK_TYPES.standard).maxGrade, o.designGrade ?? Infinity) : (ROAD_TYPES[o.type] ?? ROAD_TYPES.road).maxGrade;
}
function minRadiusOf(o: BuildOptions) {
  return o.kind === 'rail' ? (TRACK_TYPES[o.type] ?? TRACK_TYPES.standard).minRadius : (ROAD_TYPES[o.type] ?? ROAD_TYPES.road).minRadius;
}
function halfWidthOf(o: BuildOptions) {
  if (o.kind === 'rail') return 0.32;
  const rt = ROAD_TYPES[o.type] ?? ROAD_TYPES.road;
  return rt.half + rt.sidewalk;
}

/**
 * Speed limit (km/h) in a curve of a radius in world units (R[m] = units x 10), with cant: v ~ 4.3 sqrt(R[m]) on
 * all rail (300 km/h needs R ~ 4.9 km, 400 km/h R ~ 8.7 km). The legacy track argument is retained.
 */
export function curveSpeed(radius: number, trackType?: string): number {
  if (!isFinite(radius)) return 999;
  return 4.3 * Math.sqrt(radius * 10);
}

// ------------------------------------------------------------------------------------ snapping

/** Parallel siblings of a rail end node: other free ends side by side at the same height and direction
 *  (standard spacing on plain track, wider spacing at station throats). */
export function nodeGroup(g: Game, nodeId: number): number[] {
  const net = g.world.net;
  const n = net.nodes.get(nodeId);
  if (!n || n.kind !== 'rail') return [nodeId];
  const free = freeSide(g, n);
  if (free === 0) return [nodeId];
  const rx = -n.dz, rz = n.dx;
  const members: { id: number; off: number }[] = [{ id: n.id, off: 0 }];
  for (const id of net.nodeGrid.query(n.x - 6, n.z - 6, n.x + 6, n.z + 6)) {
    if (id === n.id) continue;
    const m = net.nodes.get(id)!;
    if (m.kind !== 'rail' || Math.abs(m.y - n.y) > 0.1 || Math.abs(m.dx * n.dx + m.dz * n.dz) < 0.995) continue;
    const dx = m.x - n.x, dz = m.z - n.z;
    const along = dx * n.dx + dz * n.dz, lat = dx * rx + dz * rz;
    if (Math.abs(along) > 0.2 || Math.abs(lat) < 0.3) continue;
    // the sibling's free side must point the same way
    const fs = freeSide(g, m) * Math.sign(m.dx * n.dx + m.dz * n.dz);
    if (fs !== free) continue;
    members.push({ id, off: lat });
  }
  members.sort((a, b) => a.off - b.off);
  const idx = members.findIndex((m) => m.id === n.id);
  const gapOk = (a: number, b: number) => { const d = members[b].off - members[a].off; return d > RAIL.spacing - 0.08 && d < 1.3; };
  let lo = idx, hi = idx;
  while (lo > 0 && gapOk(lo - 1, lo)) lo--;
  while (hi < members.length - 1 && gapOk(hi, hi + 1)) hi++;
  const out = members.slice(lo, hi + 1).map((m) => m.id);
  // order left->right relative to the direction the new track will leave in
  if (free < 0) out.reverse();
  return out;
}

/** N contiguous members of a group around one of its nodes. */
function groupWindow(group: number[], nodeId: number, N: number): number[] {
  if (group.length <= N) return group;
  const idx = Math.max(0, group.indexOf(nodeId));
  const lo = Math.max(0, Math.min(group.length - N, idx - Math.floor((N - 1) / 2)));
  return group.slice(lo, lo + N);
}

/** Free side of a rail node: +1/-1 if all edges are on the other side, 0 if both sides used. */
export function freeSide(g: Game, n: NNode): number {
  const net = g.world.net;
  let plus = false, minus = false;
  for (const eid of n.edges) {
    const e = net.edges.get(eid)!;
    if (net.sideAt(e, n.id) > 0) plus = true; else minus = true;
  }
  if (plus && minus) return 0;
  if (plus) return -1;
  if (minus) return 1;
  return 1;
}

export function findSnap(g: Game, kind: NetKind, x: number, z: number, radius = 1.2): Snap {
  const w = g.world;
  const net = w.net;
  const node = net.nearestNode(x, z, radius, kind, (n) => n.edges.length > 0);
  if (node) return { kind: 'node', x: node.x, z: node.z, y: node.y, node: node.id, group: kind === 'rail' ? nodeGroup(g, node.id) : [node.id] };
  const ne = net.nearestEdge(x, z, radius * 0.8, kind, (e) => e.depot < 0);
  if (ne) {
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, p);
    // snap to an existing node if very close to an edge end
    if (ne.s < 0.6) { const n = net.nodes.get(ne.edge.a)!; return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [n.id] }; }
    if (ne.s > ne.edge.len - 0.6) { const n = net.nodes.get(ne.edge.b)!; return { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id, group: [n.id] }; }
    return { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: ne.edge.id, s: ne.s };
  }
  return { kind: 'free', x, z, y: w.heightAt(x, z) };
}

/** Owners of the rails a snap joins (rail: its nodes / edge; roads: the tram tracks there). */
function snapOwners(g: Game, sn: Snap, kind: NetKind): number[] {
  const net = g.world.net, out: number[] = [];
  const edgeOwner = (e: NEdge | undefined) => { if (e) out.push(kind === 'rail' ? e.owner : e.tram ? e.tramOwner ?? -1 : -1); };
  if (sn.kind === 'edge') edgeOwner(net.edges.get(sn.edge!));
  else if (sn.kind === 'node') for (const id of sn.group ?? [sn.node!]) {
    const n = net.nodes.get(id);
    if (!n) continue;
    if (kind === 'rail') out.push(n.owner);
    else for (const eid of n.edges) edgeOwner(net.edges.get(eid));
  }
  return out;
}

// ------------------------------------------------------------------------------------ geometry

interface Frame { x: number; z: number; tx: number; tz: number; fixed: boolean; y: number | null }

/** Start frame: position and outgoing tangent. */
function startFrame(g: Game, sn: Snap, toward: V2, kind: NetKind, straight = false): Frame {
  const net = g.world.net;
  const cx = toward.x - sn.x, cz = toward.z - sn.z;
  const cl = Math.hypot(cx, cz) || 1;
  if (sn.kind === 'node') {
    const n = net.nodes.get(sn.node!)!;
    if (kind === 'rail') {
      let side = freeSide(g, n);
      if (side === 0 || n.edges.length === 0) side = cx * n.dx + cz * n.dz >= 0 ? 1 : -1;
      return { x: n.x, z: n.z, tx: n.dx * side, tz: n.dz * side, fixed: true, y: n.y };
    }
    if (n.edges.length === 1 && !straight) {
      const e = net.edges.get(n.edges[0])!;
      const d = net.leaveDir(e, n.id);
      return { x: n.x, z: n.z, tx: -d.x, tz: -d.z, fixed: true, y: n.y };
    }
    return { x: n.x, z: n.z, tx: cx / cl, tz: cz / cl, fixed: false, y: n.y };
  }
  if (sn.kind === 'edge') {
    const e = net.edges.get(sn.edge!)!;
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(e, sn.s!, p, d);
    const l = Math.hypot(d.x, d.z) || 1;
    if (kind === 'rail') {
      const sg = cx * d.x + cz * d.z >= 0 ? 1 : -1;
      return { x: p.x, z: p.z, tx: (d.x / l) * sg, tz: (d.z / l) * sg, fixed: true, y: p.y };
    }
    return { x: p.x, z: p.z, tx: cx / cl, tz: cz / cl, fixed: false, y: p.y };
  }
  return { x: sn.x, z: sn.z, tx: cx / cl, tz: cz / cl, fixed: false, y: null };
}

/** End frame: position and arriving tangent (direction of travel at the end). */
function endFrame(g: Game, sn: Snap, from: V2, kind: NetKind, straight = false): Frame {
  const net = g.world.net;
  const cx = sn.x - from.x, cz = sn.z - from.z;
  const cl = Math.hypot(cx, cz) || 1;
  if (sn.kind === 'node') {
    const n = net.nodes.get(sn.node!)!;
    if (kind === 'rail') {
      const free = freeSide(g, n);
      // the new edge attaches on the free side, so we arrive travelling against it
      let tx = -free * n.dx, tz = -free * n.dz;
      if (free === 0) { const sg = cx * n.dx + cz * n.dz >= 0 ? 1 : -1; tx = n.dx * sg; tz = n.dz * sg; }
      return { x: n.x, z: n.z, tx, tz, fixed: true, y: n.y };
    }
    if (n.edges.length === 1 && !straight) {
      const e = net.edges.get(n.edges[0])!;
      const d = net.leaveDir(e, n.id);
      return { x: n.x, z: n.z, tx: d.x, tz: d.z, fixed: true, y: n.y };
    }
    return { x: n.x, z: n.z, tx: cx / cl, tz: cz / cl, fixed: false, y: n.y };
  }
  if (sn.kind === 'edge') {
    const e = net.edges.get(sn.edge!)!;
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(e, sn.s!, p, d);
    const l = Math.hypot(d.x, d.z) || 1;
    if (kind === 'rail') {
      const sg = cx * d.x + cz * d.z >= 0 ? 1 : -1;
      return { x: p.x, z: p.z, tx: (d.x / l) * sg, tz: (d.z / l) * sg, fixed: true, y: p.y };
    }
    return { x: p.x, z: p.z, tx: cx / cl, tz: cz / cl, fixed: false, y: p.y };
  }
  return { x: sn.x, z: sn.z, tx: cx / cl, tz: cz / cl, fixed: false, y: null };
}

/** Bezier connecting two frames (circular-arc-like when only one tangent is fixed). */
export function fitCurve(a: Frame, b: Frame): Bez {
  const cx = b.x - a.x, cz = b.z - a.z;
  const chord = Math.hypot(cx, cz) || 1e-6;
  const ux = cx / chord, uz = cz / chord;
  let ta = { x: a.tx, z: a.tz }, tb = { x: b.tx, z: b.tz };
  if (a.fixed && !b.fixed) {
    const dp = ta.x * ux + ta.z * uz;
    tb = { x: 2 * dp * ux - ta.x, z: 2 * dp * uz - ta.z };
  } else if (!a.fixed && b.fixed) {
    const dp = tb.x * ux + tb.z * uz;
    ta = { x: 2 * dp * ux - tb.x, z: 2 * dp * uz - tb.z };
  } else if (!a.fixed && !b.fixed) {
    return bezLine(a.x, a.z, b.x, b.z);
  }
  const phi = angleBetween(ta.x, ta.z, tb.x, tb.z);
  const c = Math.cos(phi / 4);
  let k = chord / (3 * c * c);
  // S-curves and sharp reversals need longer handles
  if (ta.x * ux + ta.z * uz < 0.2 || tb.x * ux + tb.z * uz < 0.2) k = chord * 0.45;
  return bezFromTangents(a.x, a.z, ta.x, ta.z, b.x, b.z, tb.x, tb.z, k, k);
}

// ------------------------------------------------------------------------------------ profile

interface Constraint { i: number; kind: 'eq' | 'ge' | 'le'; v: number }

/** Grade-limited height profile through constraints, following the desired heights. */
function solveProfile(desired: number[], ds: number[], cons: Constraint[], g: number): { y: number[]; ok: boolean; bad: number } {
  const n = desired.length;
  const lo = new Array(n).fill(-1e9), hi = new Array(n).fill(1e9);
  for (const c of cons) {
    if (c.kind !== 'le') lo[c.i] = Math.max(lo[c.i], c.v);
    if (c.kind !== 'ge') hi[c.i] = Math.min(hi[c.i], c.v);
  }
  // level crossings of tracks at slightly different heights meeting one sample: their middle height
  for (let i = 0; i < n; i++) if (lo[i] > hi[i] && lo[i] - hi[i] < 0.06) lo[i] = hi[i] = (lo[i] + hi[i]) / 2;
  // Lipschitz envelopes
  for (let i = 1; i < n; i++) { hi[i] = Math.min(hi[i], hi[i - 1] + g * ds[i]); lo[i] = Math.max(lo[i], lo[i - 1] - g * ds[i]); }
  for (let i = n - 2; i >= 0; i--) { hi[i] = Math.min(hi[i], hi[i + 1] + g * ds[i + 1]); lo[i] = Math.max(lo[i], lo[i + 1] - g * ds[i + 1]); }
  let ok = true, bad = -1;
  for (let i = 0; i < n; i++) if (lo[i] > hi[i] + 1e-4) { ok = false; bad = i; break; }
  if (!ok) return { y: desired.slice(), ok, bad };
  const fwd = new Array(n), bwd = new Array(n);
  fwd[0] = Math.min(hi[0], Math.max(lo[0], desired[0]));
  for (let i = 1; i < n; i++) {
    let v = Math.min(fwd[i - 1] + g * ds[i], Math.max(fwd[i - 1] - g * ds[i], desired[i]));
    fwd[i] = Math.min(hi[i], Math.max(lo[i], v));
  }
  bwd[n - 1] = Math.min(hi[n - 1], Math.max(lo[n - 1], desired[n - 1]));
  for (let i = n - 2; i >= 0; i--) {
    let v = Math.min(bwd[i + 1] + g * ds[i + 1], Math.max(bwd[i + 1] - g * ds[i + 1], desired[i]));
    bwd[i] = Math.min(hi[i], Math.max(lo[i], v));
  }
  const y = new Array(n);
  for (let i = 0; i < n; i++) y[i] = (fwd[i] + bwd[i]) / 2;
  return { y, ok: true, bad: -1 };
}

// ------------------------------------------------------------------------------------ planning

export function planEdge(g: Game, start: Snap, end: Snap, opts: BuildOptions): Proposal {
  const w = g.world;
  const net = w.net;
  if (opts.kind === 'rail') {
    const wired = [start, end].some((sn) => {
      const ids = sn.kind === 'edge' ? [sn.edge!] : sn.kind === 'node' ? (sn.group ?? [sn.node!]).flatMap((id) => net.nodes.get(id)?.edges ?? []) : [];
      return ids.some((id) => { const e = net.edges.get(id); return e?.kind === 'rail' && TRACK_TYPES[e.type]?.electrified; });
    });
    opts = { ...opts, type: wired ? 'electric' : trackTypeOf(opts.type) };
  }
  const prop: Proposal = {
    ok: true, errors: [], warnings: [], opts, tracks: [], crossings: [], demolish: [], trees: 0, cost: 0,
    stats: { len: 0, maxGrade: 0, minRadius: Infinity, bridges: 0, tunnels: 0, speed: 999 },
  };
  const fail = (m: string) => { prop.ok = false; if (!prop.errors.includes(m)) prop.errors.push(m); };
  const kind = opts.kind;
  // number of parallel tracks: a snapped group dictates it
  let N = kind === 'rail' ? Math.max(1, Math.min(4, opts.tracks)) : 1;
  if (start.kind === 'edge' || end.kind === 'edge') N = 1;
  const sgFull = start.kind === 'node' && kind === 'rail' ? start.group ?? [start.node!] : null;
  if (sgFull) N = Math.min(N, sgFull.length);
  const sg = sgFull ? groupWindow(sgFull, start.node!, N) : null;
  const egFull = end.kind === 'node' && kind === 'rail' ? [...(end.group ?? [end.node!])].reverse() : null;
  const eg = egFull ? groupWindow(egFull, end.node!, N) : null;
  if (N > 1 && end.kind !== 'free' && !(eg && eg.length === N)) fail(`${N} parallel tracks need ${N} track ends`);
  // group centres
  const centre = (sn: Snap, grp: number[] | null): Snap => {
    if (!grp || grp.length <= 1 || N === 1) return sn;
    let x = 0, z = 0, y = 0;
    for (const id of grp) { const n = net.nodes.get(id)!; x += n.x; z += n.z; y += n.y; }
    return { ...sn, x: x / grp.length, z: z / grp.length, y: y / grp.length };
  };
  const cs = centre(start, sg), ce = centre(end, eg && eg.length === N ? eg : null);
  if (Math.hypot(ce.x - cs.x, ce.z - cs.z) < 1.0) { fail('Too short'); return prop; }
  if (start.kind === 'node' && end.kind === 'node' && start.node === end.node) { fail('Too short'); return prop; }
  const straight = kind === 'road' && !!opts.straight;
  const fa = startFrame(g, cs.kind === 'node' && sg ? { ...start } : cs, ce, kind, straight);
  if (sg && sg.length > 1) { fa.x = cs.x; fa.z = cs.z; }
  const fb = endFrame(g, ce.kind === 'node' && eg && eg.length === N && N > 1 ? { ...end } : ce, { x: fa.x, z: fa.z }, kind, straight);
  if (eg && eg.length === N && N > 1) { fb.x = ce.x; fb.z = ce.z; }
  // another company's rails (or tram tracks): joining them needs the right to use that company's network;
  // the joined pieces stay theirs, the new track is the builder's
  if (!opts.town && opts.owner >= 0 && (kind === 'rail' || opts.tram)) {
    for (const sn of [start, end]) for (const o of snapOwners(g, sn, kind)) {
      if (o >= 0 && o !== opts.owner && !g.canUse(opts.owner, o)) fail(`${kind === 'rail' ? 'Track' : 'Tram tracks'} of ${g.company(o).name}: needs track access`);
    }
  }
  // the end must be ahead of the start tangent
  const chx = fb.x - fa.x, chz = fb.z - fa.z, chl = Math.hypot(chx, chz);
  if (fa.fixed && (fa.tx * chx + fa.tz * chz) / chl < -0.2) fail('Target behind track direction');
  if (fb.fixed && (fb.tx * chx + fb.tz * chz) / chl < -0.2) fail('Cannot join from this direction');
  const centreBez = fitCurve(fa, fb);
  const minR = bezMinRadius(centreBez, 48);
  prop.stats.minRadius = minR;
  prop.stats.speed = kind === 'rail' ? Math.min((TRACK_TYPES[opts.type] ?? TRACK_TYPES.standard).speed, curveSpeed(minR, opts.type)) : (ROAD_TYPES[opts.type] ?? ROAD_TYPES.road).speed;
  if (minR < minRadiusOf(opts)) fail(kind === 'rail' ? `Radius ${Math.round(minR * 10)} m < min ${minRadiusOf(opts) * 10} m` : 'Curve too tight');

  // per-track curves: standard spacing, or the spacing of a snapped group (e.g. a station throat)
  // when the segment is too short to converge within the minimum radius
  const ctab = arcTable(centreBez);
  const L = ctab.len;
  prop.stats.len = L * N;
  const std: number[] = [];
  for (let i = 0; i < N; i++) std.push((i - (N - 1) / 2) * RAIL.spacing);
  const groupOffs = (grp: number[] | null, cx: number, cz: number, tx: number, tz: number): number[] | null => {
    if (!grp || grp.length !== N || N < 2) return null;
    return grp.map((id) => { const n = net.nodes.get(id)!; return (n.x - cx) * -tz + (n.z - cz) * tx; });
  };
  const candidates = [std];
  const so = groupOffs(sg, fa.x, fa.z, fa.tx, fa.tz), eo = groupOffs(eg, fb.x, fb.z, fb.tx, fb.tz);
  if (so) candidates.push(so);
  if (eo) candidates.push(eo);
  const makeTracks = (offs: number[]): TrackPlan[] => {
    const out: TrackPlan[] = [];
    for (let i = 0; i < N; i++) {
      const bez = N === 1 ? centreBez : bezOffset(centreBez, offs[i]);
      // snap the ends exactly onto group nodes
      if (sg && sg.length === N && N > 1) { const n = net.nodes.get(sg[i])!; bez.x1 += n.x - bez.x0; bez.z1 += n.z - bez.z0; bez.x0 = n.x; bez.z0 = n.z; }
      if (eg && eg.length === N && N > 1) { const n = net.nodes.get(eg[i])!; bez.x2 += n.x - bez.x3; bez.z2 += n.z - bez.z3; bez.x3 = n.x; bez.z3 = n.z; }
      const st: Snap = sg && sg.length === N && N > 1 ? { kind: 'node', x: bez.x0, z: bez.z0, y: 0, node: sg[i] } : N === 1 ? start : { kind: 'free', x: bez.x0, z: bez.z0, y: 0 };
      const en: Snap = eg && eg.length === N && N > 1 ? { kind: 'node', x: bez.x3, z: bez.z3, y: 0, node: eg[i] } : N === 1 ? end : { kind: 'free', x: bez.x3, z: bez.z3, y: 0 };
      out.push({ bez, len: arcTable(bez).len, prof: new Float32Array(0), sections: [], start: st, end: en });
    }
    return out;
  };
  let offsets = std, bestR = -1;
  for (const offs of candidates) {
    const tr = makeTracks(offs);
    let r = minR;
    if (N > 1) for (const tp of tr) r = Math.min(r, bezMinRadius(tp.bez, 48));
    if (r > bestR) { prop.tracks = tr; offsets = offs; bestR = r; }
    if (r >= minRadiusOf(opts)) break;
  }
  if (N > 1 && bestR < minR) {
    prop.stats.minRadius = bestR;
    prop.stats.speed = Math.min(prop.stats.speed, curveSpeed(bestR, kind === 'rail' ? opts.type : undefined));
    if (bestR < minRadiusOf(opts) && minR >= minRadiusOf(opts)) fail(`Radius ${Math.round(bestR * 10)} m < min ${minRadiusOf(opts) * 10} m`);
  }
  const spread = N > 1 ? Math.max(Math.abs(offsets[0]), Math.abs(offsets[N - 1])) : 0;
  const subway = opts.level === 'underground' && !!opts.subway;

  // ---- sample centreline
  const M = Math.max(2, Math.ceil(L / PSTEP) + 1);
  const sArr: number[] = [], xs: number[] = [], zs: number[] = [], terr: number[] = [];
  const p = { x: 0, z: 0 };
  for (let i = 0; i < M; i++) {
    const s = Math.min(i * PSTEP, L);
    bezPoint(centreBez, tAtS(ctab, s), p);
    sArr.push(s); xs.push(p.x); zs.push(p.z);
    // use the highest terrain across the formation
    let t = w.heightAt(p.x, p.z);
    if (N > 1) for (const o of [offsets[0], offsets[N - 1]]) {
      const d = bezDeriv(centreBez, tAtS(ctab, s));
      const l = Math.hypot(d.x, d.z) || 1;
      t = Math.max(t, w.heightAt(p.x - (d.z / l) * o, p.z + (d.x / l) * o));
    }
    terr.push(t);
    if (!w.inside(p.x, p.z, 1)) fail('Outside the map');
  }
  // The highest formation terrain is appropriate for surface track; tunnel cover needs the lowest
  // terrain over each actual curve, including adjusted station offsets and the whole bore width.
  const cover = new Array<number>(M).fill(Infinity);
  if (subway) for (const tp of prop.tracks) {
    const tab = arcTable(tp.bez), steps = Math.max(1, Math.ceil(tp.len / 0.25));
    for (let k = 0; k <= steps; k++) {
      const s = tp.len * k / steps, t = tAtS(tab, s);
      bezPoint(tp.bez, t, p);
      const d = bezDeriv(tp.bez, t), l = Math.hypot(d.x, d.z) || 1;
      const low = boreTerrain(g, p.x, p.z, -d.z / l, d.x / l, halfWidthOf(opts));
      const i = Math.min(M - 1, Math.floor(s / tp.len * L / PSTEP));
      // Both ends of an interval are below its least cover, so interpolated heights also fit.
      cover[i] = Math.min(cover[i], low);
      cover[Math.min(M - 1, i + 1)] = Math.min(cover[Math.min(M - 1, i + 1)], low);
    }
  }
  const ds = sArr.map((s, i) => (i ? s - sArr[i - 1] : 0));
  const grade = maxGradeOf(opts);
  // desired heights: smoothed terrain, kept above water
  const win = kind === 'rail' ? 6 : 2;
  const desired: number[] = [];
  for (let i = 0; i < M; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(M - 1, i + win); j++) { sum += Math.max(terr[j], WATER_Y + 0.15); cnt++; }
    desired.push(sum / cnt);
  }
  // the build level: a viaduct levelHeight above the highest ground beneath, or a tunnel levelDepth below
  // the lowest ground above (smoothed: level runs, not every bump); ramps and portals come from the
  // grade limit where the line meets track at another level
  const level = opts.level ?? 'ground';
  let levelOff = 0;
  if (level !== 'ground') {
    const LV = LINE_LEVEL;
    levelOff = level === 'elevated'
      ? Math.max(LV.height.min, Math.min(LV.height.max, opts.levelHeight ?? LV.height.def))
      : -Math.max(LV.depth.min, Math.min(LV.depth.max, opts.levelDepth ?? LV.depth.def));
    const ext: number[] = [];
    for (let i = 0; i < M; i++) {
      let v = level === 'elevated' ? -Infinity : Infinity;
      const r = level === 'elevated' ? 3 : 1;
      for (let j = Math.max(0, i - r); j <= Math.min(M - 1, i + r); j++) v = level === 'elevated' ? Math.max(v, Math.max(terr[j], WATER_Y)) : Math.min(v, subway ? cover[j] : terr[j]);
      ext.push(v + levelOff);
    }
    if (level === 'elevated') {
      // the deck clears the buildings beneath, like an elevated station (raised over taller ones, up to
      // 30 m above the ground; anything taller is in the way)
      const hwF = halfWidthOf(opts) + spread + 0.1;
      for (let i = 0; i < M; i++) {
        let top = -Infinity;
        for (const b of w.buildingsNear(xs[i], zs[i], hwF + 3)) {
          if (b.floors <= 0 || distToRect(xs[i], zs[i], b.x, b.z, b.angle, b.w / 2, b.d / 2) > hwF) continue;
          top = Math.max(top, b.y + b.floors * FLOOR_H + 0.95);
        }
        top = Math.min(top, Math.max(terr[i], WATER_Y) + 3);
        for (let j = Math.max(0, i - 3); j <= Math.min(M - 1, i + 3); j++) ext[j] = Math.max(ext[j], top);
      }
    }
    for (let i = 0; i < M; i++) {
      let sum = 0, cnt = 0;
      for (let j = Math.max(0, i - 4); j <= Math.min(M - 1, i + 4); j++) { sum += ext[j]; cnt++; }
      desired[i] = sum / cnt;
    }
  }
  // rail beside an existing track at this level: keep to its formation (a widened bank, cutting, viaduct or
  // tunnel)
  if (kind === 'rail') {
    for (let i = 0; i < M; i++) {
      const d = bezDeriv(centreBez, tAtS(ctab, sArr[i])), l = Math.hypot(d.x, d.z) || 1;
      const h = formationBeside(g, xs[i], zs[i], d.x / l, d.z / l, 0.32 * 2 + 2 * EARTHWORKS.corePad - 0.5 + spread);
      if (h !== null && (level === 'ground' || Math.abs(h - desired[i]) < 1)) desired[i] = h;
    }
  }
  const cons: Constraint[] = [];
  // the height offset applies to the end being placed; a free start sits on the ground (or at the level)
  const atLevel = (t: number) => (level === 'elevated' ? Math.max(t, WATER_Y) : t) + levelOff;
  const startY = fa.y ?? atLevel(subway ? cover[0] : terr[0]);
  const endY = fb.y ?? (end.kind === 'free' ? atLevel(subway ? cover[M - 1] : terr[M - 1]) + opts.heightOffset : null);
  if (fa.y !== null) cons.push({ i: 0, kind: 'eq', v: fa.y });
  else desired[0] = startY;
  if (fb.y !== null) cons.push({ i: M - 1, kind: 'eq', v: fb.y });
  else { desired[M - 1] = endY!; if (opts.heightOffset) cons.push({ i: M - 1, kind: 'eq', v: endY! }); }
  // over water: a deck above it, or (underground) a tunnel below the bed
  for (let i = 0; i < M; i++) if (terr[i] < WATER_Y + 0.05) cons.push(level === 'underground' ? { i, kind: 'le', v: terr[i] - TUNNEL_COVER - 0.1 } : { i, kind: 'ge', v: WATER_Y + WATER_DECK });
  // a subway stays underground: joins only underground track, keeps its cover the whole way (no ramp, no portal)
  if (subway) {
    if (prop.tracks.some((tp) => !snapUnderground(g, tp.start) || !snapUnderground(g, tp.end))) fail('Joins track on the surface: a subway stays underground (build Underground with ramps instead)');
    for (let i = 0; i < M; i++) {
      let t = cover[i];
      for (let j = Math.max(0, i - 1); j <= Math.min(M - 1, i + 1); j++) t = Math.min(t, cover[j]);
      cons.push({ i, kind: 'le', v: t - SUBWAY_COVER });
    }
  }

  let sol = solveProfile(desired, ds, cons, grade);
  if (!sol.ok) { fail(subway ? 'Surfaces here: go deeper' : 'Too steep: lengthen route or change height'); }

  // ---- crossings with existing edges
  const exclude = new Set<number>();
  const nearEnds: { x: number; z: number }[] = [];
  for (const tp of prop.tracks) for (const sn of [tp.start, tp.end]) {
    if (sn.kind === 'node') { const n = net.nodes.get(sn.node!); if (n) { for (const e of n.edges) exclude.add(e); nearEnds.push({ x: n.x, z: n.z }); } }
    if (sn.kind === 'edge') { exclude.add(sn.edge!); nearEnds.push({ x: sn.x, z: sn.z }); }
  }
  // the line a new track joins, one edge on beyond the switch: a turnout's diverging track runs alongside it for
  // a while (sidings, junctions, station throats)
  const switchSet = new Set(exclude);
  for (const id of exclude) {
    const e = net.edges.get(id);
    if (e) for (const nid of [e.a, e.b]) for (const x of net.nodes.get(nid)?.edges ?? []) switchSet.add(x);
  }
  if (opts.junctionUpgrade) {
    // Signals split an approach into short pieces. A turnout's clearance window follows the whole approach,
    // rather than ending after one such piece; actual intersections still become reserved diamonds below.
    const seen = new Map<number, number>(), queue = [...exclude].flatMap((id) => {
      const e = net.edges.get(id); return e ? [e.a, e.b].map((node) => ({ node, len: 0 })) : [];
    });
    while (queue.length) {
      const q = queue.shift()!;
      if (q.len > SWITCH_ZONE || (seen.get(q.node) ?? Infinity) <= q.len) continue;
      seen.set(q.node, q.len);
      for (const id of net.nodes.get(q.node)?.edges ?? []) {
        const e = net.edges.get(id)!;
        if (e.kind !== 'rail' || e.station >= 0 || e.depot >= 0) continue;
        switchSet.add(id);
        queue.push({ node: e.a === q.node ? e.b : e.a, len: q.len + e.len });
      }
    }
  }
  const hwNew = halfWidthOf(opts) + spread;
  const crossings: CrossingPlan[] = [];
  prop.tracks.forEach((tp, ti) => {
    const tab = arcTable(tp.bez);
    const K = Math.max(2, Math.ceil(tab.len / 0.5) + 1);
    const pts: number[] = [];
    for (let i = 0; i < K; i++) { bezPoint(tp.bez, tAtS(tab, Math.min(i * 0.5, tab.len)), p); pts.push(p.x, p.z); }
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let i = 0; i < K; i++) { x0 = Math.min(x0, pts[i * 2]); x1 = Math.max(x1, pts[i * 2]); z0 = Math.min(z0, pts[i * 2 + 1]); z1 = Math.max(z1, pts[i * 2 + 1]); }
    for (const e of net.edgesNear(x0, z0, x1, z1)) {
      if (exclude.has(e.id) || opts.ignore?.edges.has(e.id)) continue;
      const ge = net.geo(e);
      for (let i = 0; i < K - 1; i++) {
        const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[i * 2 + 2], bz = pts[i * 2 + 3];
        const xlo = Math.min(ax, bx) - 1e-8, xhi = Math.max(ax, bx) + 1e-8, zlo = Math.min(az, bz) - 1e-8, zhi = Math.max(az, bz) + 1e-8;
        const ids = crossingSegments(ge, ax, az, bx, bz);
        for (let k = 0, count = ids?.length ?? ge.n - 1; k < count; k++) {
          const j = ids ? ids[k] : k;
          if (ge.pts[j * 3] < xlo && ge.pts[j * 3 + 3] < xlo || ge.pts[j * 3] > xhi && ge.pts[j * 3 + 3] > xhi
            || ge.pts[j * 3 + 2] < zlo && ge.pts[j * 3 + 5] < zlo || ge.pts[j * 3 + 2] > zhi && ge.pts[j * 3 + 5] > zhi) continue;
          const r = segIntersect(ax, az, bx, bz, ge.pts[j * 3], ge.pts[j * 3 + 2], ge.pts[j * 3 + 3], ge.pts[j * 3 + 5]);
          if (!r) continue;
          const sNew = Math.min(i * 0.5, tab.len) + 0.5 * r[0];
          const sOld = ge.cum[j] + (ge.cum[j + 1] - ge.cum[j]) * r[1];
          const ang = angleBetween(bx - ax, bz - az, ge.pts[j * 3 + 3] - ge.pts[j * 3], ge.pts[j * 3 + 5] - ge.pts[j * 3 + 2]);
          crossings.push({ track: ti, sNew, edge: e.id, sOld, x: ax + (bx - ax) * r[0], z: az + (bz - az) * r[0], mode: 'over', angle: Math.min(ang, Math.PI - ang) });
        }
      }
    }
  });
  // decide crossing modes and add profile constraints
  const centreS = (ti: number, s: number) => (s / prop.tracks[ti].len) * L;
  const idxOf = (s: number) => Math.max(0, Math.min(M - 1, Math.round(s / PSTEP)));
  for (const c of crossings) {
    const e = net.edges.get(c.edge)!;
    const yo = net.heightAtS(e, c.sOld);
    const ci = idxOf(centreS(c.track, c.sNew));
    const yn = sol.y[ci];
    const secOld = net.sectionAt(e, c.sOld);
    let mode: CrossingPlan['mode'];
    // at grade (a diamond with switches) only across one's own or usable track, else over or under it
    const levelOk = c.angle > (opts.junctionUpgrade && kind === 'rail' && e.kind === 'rail' ? 0.025 : 0.4) && secOld === 'ground' && e.depot < 0 && e.station < 0
      && !(kind === 'rail' && e.kind === 'rail' && e.owner >= 0 && e.owner !== opts.owner && !opts.town && !g.canUse(opts.owner, e.owner))
      && !(opts.infrastructureOwner !== undefined && e.kind === 'rail' && g.trackUpgradeError(opts.owner, e.owner))
      // Fast alignments request grade separation; the physical track is the same.
      && (kind === e.kind || (opts.designSpeed ?? 0) <= 160 && levelCrossingAllowed(kind === 'rail' ? opts.type : e.type));
    const levelMode: CrossingPlan['mode'] = kind === 'rail' ? (e.kind === 'rail' ? 'diamond' : 'level') : e.kind === 'rail' ? 'level' : 'junction';
    // lines built elevated / underground pass over / under everything at the surface (another viaduct or
    // tunnel: by height)
    if (level === 'underground') mode = secOld === 'tunnel' && yn >= yo ? 'over' : 'under';
    else if (level === 'elevated') mode = secOld === 'bridge' && yn < yo ? 'under' : 'over';
    else if (opts.crossing === 'level' && levelOk) mode = levelMode;
    else if (opts.crossing === 'over') mode = 'over';
    else if (opts.crossing === 'under') mode = 'under';
    else if (Math.abs(yn - yo) < 0.35 && levelOk) mode = levelMode;
    else mode = yn >= yo ? 'over' : 'under';
    if (secOld === 'tunnel' && level === 'ground') mode = yn >= yo ? 'over' : 'under';
    // Auto crossings must share a feasible profile. A ramp out of a tunnel can reach the street's
    // height in the initial profile while a preceding underpass still requires cover beneath it.
    // Prove each choice against the earlier crossings before switching from underpass to level.
    const constraint = (m: CrossingPlan['mode']): Constraint => m === 'over' ? { i: ci, kind: 'ge', v: yo + RAIL.clearance }
      : m === 'under' ? { i: ci, kind: 'le', v: yo - RAIL.clearance } : { i: ci, kind: 'eq', v: yo };
    if (opts.crossing === 'auto' && level === 'ground') {
      const choices = [...new Set([mode, ...(levelOk ? [levelMode] : []), 'under', 'over'] as CrossingPlan['mode'][])];
      for (const choice of choices) {
        const trial = solveProfile(desired, ds, [...cons, constraint(choice)], grade);
        if (trial.ok) { mode = choice; sol = trial; break; }
      }
    }
    c.mode = mode;
    cons.push(constraint(mode));
  }
  // underground structures (station boxes below ground, underground depots) beside the stations and depots it
  // joins: where it runs below ground, the track passes beneath them with the clearance or above them, whichever is
  // nearer its height (on the surface it passes over them: streets and track run over cut-and-cover boxes)
  const ugBoxes = undergroundBoxes(g, prop, hwNew + 1.5, switchSet, opts.ignore);
  let ugAdded = false;
  if (ugBoxes.length) for (let i = 0; i < M; i++) {
    if (sol.y[i] > terr[i] - 0.5 || nearEnds.some((ne) => Math.hypot(ne.x - xs[i], ne.z - zs[i]) < 1.2)) continue;
    for (const bx of ugBoxes) {
      // (a sample's reach covers the track between samples: the checks below look every half unit)
      if (distToRect(xs[i], zs[i], bx.x, bx.z, bx.angle, bx.w / 2, bx.d / 2) > hwNew + 0.2 + PSTEP * 0.75) continue;
      if (sol.y[i] < (bx.y0 + bx.y1) / 2) cons.push({ i, kind: 'le', v: bx.y0 - RAIL.clearance });
      else cons.push({ i, kind: 'ge', v: bx.y1 + 0.2 });
      ugAdded = true;
    }
  }
  if (crossings.length || ugAdded) {
    sol = solveProfile(desired, ds, cons, grade);
    if (!sol.ok) fail(ugAdded ? 'Too steep under station or depot: go deeper' : 'Crossing too steep at these heights');
  }
  prop.crossings = crossings;
  const y = sol.y;

  // ---- grade statistics
  for (let i = 1; i < M; i++) if (ds[i] > 0.01) prop.stats.maxGrade = Math.max(prop.stats.maxGrade, Math.abs(y[i] - y[i - 1]) / ds[i]);

  // ---- sections
  const type: number[] = []; // 0 ground 1 bridge 2 tunnel
  const forcedBridge = new Array(M).fill(false);
  for (const c of crossings) {
    if (c.mode !== 'over') continue;
    const e = net.edges.get(c.edge)!;
    if (net.sectionAt(e, c.sOld) === 'tunnel') continue;
    // the bridge spans the other line's formation zone too (no cut or fill of one under the other's ramp)
    const wdt = (net.halfWidth(e) + EARTHWORKS.corePad) / Math.max(0.35, Math.sin(c.angle)) + 0.3;
    const sc = centreS(c.track, c.sNew);
    for (let i = idxOf(sc - wdt); i <= idxOf(sc + wdt); i++) forcedBridge[i] = true;
  }
  for (let i = 0; i < M; i++) {
    const d = y[i] - terr[i];
    if (subway) type.push(2);
    else if (level === 'underground' && d < -TUNNEL_COVER) type.push(2);
    else if (forcedBridge[i] || terr[i] < WATER_Y + 0.05 || d > (level === 'elevated' ? VIADUCT_H : opts.town && kind === 'road' && opts.type === 'street' ? TOWN_BANK_H : BRIDGE_H)) type.push(1);
    else type.push(0);
  }
  if (level !== 'underground') {
    // tunnels with real cover: deep runs, out to their portals, joined over short open gaps, long enough
    const depth = (i: number) => terr[i] - y[i];
    // crossings at grade (level crossings, diamonds, junctions) are in the open: no tunnel through them
    const open = new Array<boolean>(M).fill(false);
    for (const c of crossings) {
      if (c.mode === 'over' || c.mode === 'under') continue;
      const ci = idxOf(centreS(c.track, c.sNew));
      for (let k = Math.max(0, ci - 2); k <= Math.min(M - 1, ci + 2); k++) open[k] = true;
    }
    const can = (i: number) => type[i] === 0 && !open[i];
    const tun: [number, number][] = [];
    for (let i = 0; i < M; i++) {
      if (!can(i) || depth(i) < TUNNEL_DEEP) continue;
      let a = i, b = i;
      while (b + 1 < M && can(b + 1) && depth(b + 1) >= TUNNEL_DEEP) b++;
      i = b;
      while (a > 0 && can(a - 1) && depth(a - 1) >= PORTAL_D) a--;
      while (b + 1 < M && can(b + 1) && depth(b + 1) >= PORTAL_D) b++;
      const last = tun[tun.length - 1];
      if (last && (a - last[1] - 1) * PSTEP < TUNNEL_GAP && !type.slice(last[1] + 1, a).includes(1) && !open.slice(last[1] + 1, a).includes(true)) last[1] = b;
      else tun.push([a, b]);
    }
    for (const [a, b] of tun) if ((b - a + 1) * PSTEP >= TUNNEL_MIN) for (let i = a; i <= b; i++) type[i] = 2;
    // leaving a tunnel or an underground station: the tunnel goes on to its portal
    const onward = (i0: number, step: number) => { for (let i = i0; i >= 0 && i < M && type[i] !== 1 && !open[i] && depth(i) >= PORTAL_D; i += step) type[i] = 2; };
    if (depth(0) >= PORTAL_D) onward(0, 1);
    if (depth(M - 1) >= PORTAL_D) onward(M - 1, -1);
  }
  // clean-up: fill short ground gaps between bridges, drop very short structures
  const runs = () => {
    const r: { t: number; a: number; b: number }[] = [];
    let a = 0;
    for (let i = 1; i <= M; i++) if (i === M || type[i] !== type[a]) { r.push({ t: type[a], a, b: i - 1 }); a = i; }
    return r;
  };
  for (const r of runs()) if (r.t === 0 && r.a > 0 && r.b < M - 1 && (r.b - r.a + 1) * PSTEP < 4 && type[r.a - 1] === 1 && type[r.b + 1] === 1) for (let i = r.a; i <= r.b; i++) type[i] = 1;
  // an underground line stays in its tunnel through short shallow stretches
  if (level === 'underground') for (const r of runs()) if (r.t === 0 && r.a > 0 && r.b < M - 1 && (r.b - r.a + 1) * PSTEP < 6 && type[r.a - 1] === 2 && type[r.b + 1] === 2) for (let i = r.a; i <= r.b; i++) type[i] = 2;
  for (const r of runs()) {
    const len = (r.b - r.a + 1) * PSTEP;
    if (r.t === 1 && len < 1.5) {
      let keep = false;
      for (let i = r.a; i <= r.b; i++) if (forcedBridge[i] || terr[i] < WATER_Y + 0.05) keep = true;
      if (!keep) for (let i = r.a; i <= r.b; i++) type[i] = 0;
    }
  }
  const centreSections: Section[] = [];
  for (const r of runs()) {
    if (r.t === 0) continue;
    const s0 = Math.max(0, sArr[r.a] - PSTEP / 2), s1 = Math.min(L, sArr[r.b] + PSTEP / 2);
    centreSections.push({ s0, s1, type: r.t === 1 ? 'bridge' : 'tunnel' });
    if (r.t === 1) prop.stats.bridges++; else prop.stats.tunnels++;
  }
  // bridges starting at a snapped node must not cut into station/depot edges
  // per-track profiles and sections
  for (const tp of prop.tracks) {
    const m = Math.max(2, Math.ceil(tp.len / PSTEP) + 1);
    const prof = new Float32Array(m);
    for (let i = 0; i < m; i++) {
      const sc = (Math.min(i * PSTEP, tp.len) / tp.len) * L;
      prof[i] = profAt(Float32Array.from(y), L, sc);
    }
    tp.prof = prof;
    if (subway) {
      // Commit takes each snapped node's actual height, including the second bore's endpoints.
      if (tp.start.kind === 'node') prof[0] = net.nodes.get(tp.start.node!)!.y;
      if (tp.end.kind === 'node') prof[prof.length - 1] = net.nodes.get(tp.end.node!)!.y;
    }
    tp.sections = centreSections.map((sec) => ({ s0: (sec.s0 / L) * tp.len, s1: (sec.s1 / L) * tp.len, type: sec.type }));
  }

  // ---- obstacles along the corridor
  const demolish = new Set<number>(), avoided = new Set<number>();
  let trees = 0, wallUnits = 0, wallArea = 0;
  const hw = halfWidthOf(opts);
  const crossWin = (ti: number, s: number) => crossings.some((c) => c.track === ti && Math.abs(c.sNew - s) < (opts.junctionUpgrade && c.mode === 'diamond' ? 1 + RAIL.spacing / Math.max(0.025, Math.sin(c.angle)) : 2.5));
  /**
   * Tunnels side by side: the same room as tracks on the ground (RAIL.spacing), at about the same depth; edges wholly at
   * another height (a street above a subway, another subway deeper down) pass.
   */
  const tunnelClash = (yy: number, nearSwitch: boolean) => {
    for (const e of net.edgesNear(p.x - hw - 1, p.z - hw - 1, p.x + hw + 1, p.z + hw + 1)) {
      if (exclude.has(e.id) || (nearSwitch && switchSet.has(e.id)) || opts.ignore?.edges.has(e.id)) continue;
      const ge = net.geo(e);
      // (an edge wholly at another height cannot clash: a street above a subway, a tunnel below a street)
      const hr = heightRange(ge);
      if (yy < hr[0] - RAIL.clearance || yy > hr[1] + RAIL.clearance) continue;
      const need = e.kind === 'rail' && kind === 'rail' ? RAIL.spacing - 0.06 : hw + net.halfWidth(e) - 0.08;
      const ranges = geometryPointRanges(ge, p.x, p.z, need);
      let best = Infinity, bi = 0;
      for (const start of ranges ?? [0]) for (let j = start, end = ranges ? Math.min(ge.n, start + 32) : ge.n; j < end; j++) {
        const dx = ge.pts[j * 3] - p.x, dz = ge.pts[j * 3 + 2] - p.z;
        if (Math.abs(dx) > need + 1e-8 || Math.abs(dz) > need + 1e-8) continue;
        const d = Math.hypot(dx, dz); if (d < best) { best = d; bi = j; }
      }
      if (best < need) {
        const dy = Math.abs(ge.pts[bi * 3 + 1] - yy);
        if (dy < RAIL.clearance) fail('Too close to a tunnel at this depth');
      }
    }
  };
  prop.tracks.forEach((tp, ti) => {
    const tab = arcTable(tp.bez);
    const K = Math.max(2, Math.ceil(tab.len / 0.5) + 1);
    for (let i = 0; i < K; i++) {
      const s = Math.min(i * 0.5, tab.len);
      bezPoint(tp.bez, tAtS(tab, s), p);
      const yy = profAt(tp.prof, tp.len, s);
      if (subway) {
        const d = bezDeriv(tp.bez, tAtS(tab, s)), l = Math.hypot(d.x, d.z) || 1;
        if (boreTerrain(g, p.x, p.z, -d.z / l, d.x / l, hw) - yy < SUBWAY_COVER - 1e-5) fail('Would come up to the surface here: go deeper');
      }
      let sec: Section['type'] | 'ground' = 'ground';
      for (const q of tp.sections) if (s >= q.s0 && s <= q.s1) sec = q.type;
      // underground structures (station boxes, underground depots) at the track's height, at any level; in tunnels
      // the room beside other tunnels at that depth, and the buildings that stay above (demolition saved)
      const nearEndU = nearEnds.some((ne) => Math.hypot(ne.x - p.x, ne.z - p.z) < 1.2);
      if (!nearEndU) for (const bx of ugBoxes) {
        if (distToRect(p.x, p.z, bx.x, bx.z, bx.angle, bx.w / 2, bx.d / 2) > hw + 0.2) continue;
        if (yy + RAIL.clearance <= bx.y0 || yy - (sec === 'tunnel' ? 0.2 : -0.05) >= bx.y1) continue;
        fail(bx.depot !== undefined ? 'Underground depot in the way' : 'Underground station in the way');
        break;
      }
      if (sec === 'tunnel') {
        if (!nearEndU && !crossWin(ti, s)) tunnelClash(yy, nearEnds.some((ne) => Math.hypot(ne.x - p.x, ne.z - p.z) < SWITCH_ZONE));
        if (i % 2 === 0) for (const b of w.buildingsNear(p.x, p.z, hw + 2)) if (!avoided.has(b.id) && distToRect(p.x, p.z, b.x, b.z, b.angle, b.w / 2, b.d / 2) <= hw + 0.6) avoided.add(b.id);
        continue;
      }
      // no cutting below the water line (the hole would fill with water): bank it up, or tunnel
      if (sec === 'ground' && yy - formationDepth({ kind } as NEdge) < DRY_MIN - 0.005 && w.heightAt(p.x, p.z) > yy - formationDepth({ kind } as NEdge) + 0.01) fail('Below water line: raise or tunnel');
      const nearEnd = nearEnds.some((ne) => Math.hypot(ne.x - p.x, ne.z - p.z) < 1.2);
      // buildings: on the formation; beside a railway also those standing where its cut or fill has to
      // reshape the ground (the formation reaches every grid cell the track touches, buildings keep their
      // ground: they go, rather than stand on plinths or bury the track)
      const regrade = sec === 'ground' && Math.abs(yy - formationDepth({ kind } as NEdge) - w.heightAt(p.x, p.z)) > (kind === 'rail' ? 0.1 : 0.15);
      for (const b of w.buildingsNear(p.x, p.z, hw + 3)) {
        if (demolish.has(b.id)) continue;
        const db = distToRect(p.x, p.z, b.x, b.z, b.angle, b.w / 2, b.d / 2);
        // (a railway regrading the ground takes every building whose ground shares grid cells with its formation)
        if (db > hw + 0.1 && !(regrade && db < hw + EARTHWORKS.corePad + (kind === 'rail' ? 1.42 : 0.6))) continue;
        if (sec === 'bridge' && yy - (b.y + b.floors * 0.3 + 0.4) > 0.3) continue;
        if (opts.town) { fail('Buildings in the way'); continue; }
        demolish.add(b.id);
      }
      // stations: their structures where the new line runs at their height (it may pass under an elevated
      // deck between the piers; underground stations only have their entrances at street level)
      if (!nearEnd) for (const st of g.stations.footprintsNear(p.x, p.z, hw + 0.2)) {
        for (const f of g.stations.footprints(st)) {
          if (distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) > hw + 0.2) continue;
          if (f.y0 !== undefined && f.y1 !== undefined && (yy + RAIL.clearance <= f.y0 || yy - 0.2 >= f.y1)) continue;
          fail('Station in the way');
          break;
        }
      }
      for (const dp of g.depots.near(p.x, p.z, hw + 0.6)) { if (!nearEnd && dp.level !== 'underground' && !opts.ignore?.depots?.has(dp.id)) { void dp; fail('Depot in the way'); } }
      // parallel conflicts with other edges
      const nearSwitch = nearEnds.some((ne) => Math.hypot(ne.x - p.x, ne.z - p.z) < SWITCH_ZONE);
      if (!nearEnd && !crossWin(ti, s)) {
        for (const e of net.edgesNear(p.x - hw - 1, p.z - hw - 1, p.x + hw + 1, p.z + hw + 1)) {
          if (exclude.has(e.id) || (nearSwitch && switchSet.has(e.id)) || opts.ignore?.edges.has(e.id)) continue;
          if (opts.junctionUpgrade && opts.junctionWindows?.some((c) => c.edge === e.id && Math.hypot(p.x - c.x, p.z - c.z) < c.r)) continue;
          const ge = net.geo(e);
          const need = e.kind === 'rail' && kind === 'rail' ? RAIL.spacing - 0.06 : hw + net.halfWidth(e) - 0.08;
          const ranges = geometryPointRanges(ge, p.x, p.z, need);
          let best = Infinity, bi = 0;
          for (const start of ranges ?? [0]) for (let j = start, end = ranges ? Math.min(ge.n, start + 32) : ge.n; j < end; j++) {
            const dx = ge.pts[j * 3] - p.x, dz = ge.pts[j * 3 + 2] - p.z;
            if (Math.abs(dx) > need + 1e-8 || Math.abs(dz) > need + 1e-8) continue;
            const d = Math.hypot(dx, dz); if (d < best) { best = d; bi = j; }
          }
          if (best < need) {
            const dy = Math.abs(ge.pts[bi * 3 + 1] - yy);
            if (dy < RAIL.clearance) { fail(e.kind === 'rail' ? 'Too close to existing track' : 'Too close to existing road'); }
          }
        }
      }
      // formations side by side share grid vertices (each reaches every grid cell its edge touches), so they
      // must lie at about the same height there: else the terrain would bury a track or leave a road in the
      // air (a road below a railway may be draped over its bank). Not at the ends it joins, nor where it crosses.
      const R = hw + 2 * EARTHWORKS.corePad + 0.6;
      if ((opts.town || i % 2 === 0) && sec === 'ground' && !nearEnd && !prop.errors.length && !crossings.some((c) => c.track === ti && Math.abs(c.sNew - s) < (R + 1.5) / Math.max(0.25, Math.sin(c.angle)))) {
        for (const e of net.edgesNear(p.x - R, p.z - R, p.x + R, p.z + R)) {
          if (exclude.has(e.id) || (nearSwitch && switchSet.has(e.id)) || opts.ignore?.edges.has(e.id)) continue;
          const ehw = net.halfWidth(e), lim = hw + ehw + 2 * EARTHWORKS.corePad - 0.5;
          const r = nearestOnEdge(net, e, p.x, p.z);
          if (r.d > lim || net.sectionAt(e, r.s) !== 'ground') continue;
          const dy = net.heightAtS(e, r.s) - yy; // the other edge above (+) or below (-)
          const C = opts.town ? CLASH_TOWN : CLASH;
          const clash = kind === 'rail' && e.kind === 'rail' ? Math.abs(dy) > C.rail
            : kind === 'rail' ? dy > C.roadAbove // a road above the new railway would be left in the air
            : e.kind === 'rail' ? dy < -C.roadAbove // the new road above a railway
            : Math.abs(dy) > C.road;
          if (!clash) continue;
          // towns keep their streets clear of it; a company builds a retaining wall between (and pays for it)
          if (opts.town) { fail(e.kind === 'rail' ? 'Too close to track at another height' : 'Too close to road at another height'); break; }
          wallUnits += 0.5; wallArea += 0.5 * Math.abs(dy);
          break;
        }
      }
      if (sec === 'ground' && i % 2 === 0) trees += w.countTreesNear(p.x, p.z, hw + 0.4);
    }
  });
  prop.demolish = [...demolish];
  prop.trees = trees;
  for (const id of demolish) avoided.delete(id);
  if (avoided.size && !opts.town) prop.stats.avoided = { buildings: avoided.size, cost: Math.round(demolitionTotal(g, avoided)) };

  if (kind === 'rail' && prop.crossings.some((c) => c.mode === 'level')) prop.stats.speed = Math.min(prop.stats.speed, 160);

  const roadBridges = roadBridgeWorks(g, prop);
  if (roadBridges.error) fail(roadBridges.error);
  if (roadBridges.works.length) prop.roadBridges = roadBridges.works;

  // ---- cost: track materials (bridges x6, tunnels x9) and earthworks. The first track of a formation pays
  // them in full; further tracks built with it, and stretches of track laid beside an existing one (at the
  // same height), share the formation: materials 60 %, structures and earthworks 30 % (SHARED_TRACK)
  let cost = 0;
  if (!opts.town) {
    const per = kind === 'rail' ? TRACK_TYPES.standard.costPerUnit : (ROAD_TYPES[opts.type] ?? ROAD_TYPES.road).costPerUnit;
    const wire = kind === 'rail' && TRACK_TYPES[opts.type]?.electrified ? ELECTRIFY.costPerUnit : 0;
    const beside = kind === 'rail' ? besideExisting(g, prop) : null;
    const S = SHARED_TRACK;
    const split: { track: number; bridges: number; tunnels: number; earthworks: number; other: number; demolition?: number } = { track: 0, bridges: 0, tunnels: 0, earthworks: 0, other: 0, demolition: 0 };
    let full = 0;
    const q = { x: 0, z: 0 };
    prop.tracks.forEach((tp, ti) => {
      const n = Math.max(1, Math.ceil(tp.len / PSTEP));
      const tab = arcTable(tp.bez);
      for (let i = 0; i < n; i++) {
        const s0 = i * PSTEP, s1 = Math.min(tp.len, s0 + PSTEP), sm = (s0 + s1) / 2, ds = s1 - s0;
        let sec: 'bridge' | 'tunnel' | null = null;
        for (const x of tp.sections) if (sm >= x.s0 && sm <= x.s1) sec = x.type;
        let prem = 0;
        if (sec) {
          bezPoint(tp.bez, tAtS(tab, sm), q);
          const y = profAt(tp.prof, tp.len, sm), t = w.heightAt(q.x, q.z);
          prem = structureFactor(kind, sec, sec === 'bridge' ? y - t : t - y) - 1;
        }
        full += (per * (1 + prem) + wire) * ds;
        const shared = kind === 'rail' && (ti > 0 || beside![ti][i] === 1);
        // Wire is an attribute of each track, priced like electrifying it later. It neither excavates
        // a second tunnel nor receives a formation discount beside the first track.
        const base = (per * (shared ? S.materials : 1) + wire) * ds, extra = per * ds * prem * (shared ? S.structures : 1);
        cost += base + extra;
        if (sec === 'bridge') split.bridges += base + extra; else if (sec === 'tunnel') split.tunnels += base + extra; else split.track += base;
      }
    });
    cost += roadBridges.cost;
    full += roadBridges.cost;
    split.bridges += roadBridges.cost;
    // earthworks along the centre line: in full for the formation (unless it widens an existing one), a
    // share for every further track
    const N = prop.tracks.length, b0 = beside?.[0];
    const fm = kind === 'rail' ? (TRACK_TYPES[opts.type] ?? TRACK_TYPES.standard).formation : 1;
    for (let i = 0; i < M; i++) {
      if (type[i] !== 0) continue;
      const v = Math.abs(y[i] - terr[i]) * PSTEP * (hw * 2 + 1.5 + Math.abs(y[i] - terr[i]) * 2) * 900 * fm;
      const k = b0 ? Math.min(b0.length - 1, Math.floor((sArr[i] / L) * b0.length)) : 0;
      full += v * N;
      const ev = kind === 'rail' ? v * ((b0 && b0[k] ? S.earthworks : 1) + S.earthworks * (N - 1)) : v;
      cost += ev;
      split.earthworks += ev;
    }
    if (kind === 'rail') prop.stats.sharedSaving = Math.max(0, Math.round(full - cost));
    const before = cost;
    if (opts.tram && kind === 'road') for (const tp of prop.tracks) cost += TRAM.costPerUnit * tp.len;
    const demolition = demolitionTotal(g, prop.demolish);
    cost += demolition;
    split.demolition = demolition;
    cost += prop.trees * 250;
    for (const c of crossings) if (c.mode === 'level' || c.mode === 'diamond') cost += 15000;
    cost += wallArea * RETAINING_WALL;
    split.other = cost - before;
    for (const k of Object.keys(split) as (keyof typeof split)[]) split[k] = Math.round(split[k] ?? 0);
    if (!split.demolition) delete (split as { demolition?: number }).demolition;
    prop.stats.costSplit = split;
  }
  prop.cost = Math.round(cost);
  if (wallUnits > 0) prop.stats.walls = Math.round(wallUnits * 10) / 10;
  if (!opts.town && !g.company(opts.owner).economy.canAfford(prop.cost)) prop.warnings.push('Not enough money');
  // a free end in mid-air (9i): allowed for the player (to be continued), but worth a word
  for (const tp of prop.tracks) {
    const bAt = (s0: number) => tp.sections.some((q) => q.type === 'bridge' && q.s0 <= s0 + 0.05 && q.s1 >= s0 - 0.05);
    if ((tp.start.kind === 'free' && bAt(0)) || (tp.end.kind === 'free' && bAt(tp.len))) { prop.warnings.push('Bridge end: extend to ground'); break; }
  }
  return prop;
}

// ------------------------------------------------------------------------------------ commit

/** Resolve a snap to a node, splitting edges or creating nodes as needed. */
function resolveNode(g: Game, sn: Snap, kind: NetKind, x: number, z: number, y: number, tx: number, tz: number, owner: number): NNode | null {
  const net = g.world.net;
  if (sn.kind === 'node') return net.nodes.get(sn.node!) ?? null;
  if (sn.kind === 'edge') {
    const e = net.edges.get(sn.edge!);
    if (!e) return null;
    const r = net.splitEdge(e.id, sn.s!);
    return r ? r.node : null;
  }
  return net.addNode(kind, x, y, z, kind === 'rail' ? tx : 0, kind === 'rail' ? tz : 0, owner);
}

export function commitProposal(g: Game, prop: Proposal): string | null {
  if (!prop.ok) return prop.errors[0] ?? 'Cannot build';
  const w = g.world;
  const net = w.net;
  const opts = prop.opts;
  const roadBridges = roadBridgeWorks(g, prop);
  if (roadBridges.error) return roadBridges.error;
  if (JSON.stringify(roadBridges.works) !== JSON.stringify(prop.roadBridges ?? [])) return 'Road bridge window changed: replan';
  if (opts.infrastructureOwner !== undefined) {
    const err = g.trackUpgradeError(opts.owner, opts.infrastructureOwner);
    if (err) return err;
    for (const c of prop.crossings) {
      const e = net.edges.get(c.edge);
      if (e?.kind === 'rail' && (c.mode === 'diamond' || c.mode === 'under')) {
        const err = g.trackUpgradeError(opts.owner, e.owner);
        if (err) return err;
      }
    }
  }
  const co = opts.town ? null : g.company(opts.owner);
  if (co && !co.economy.canAfford(prop.cost)) return 'Not enough money';
  // vehicles on edges we must split?
  for (const tp of prop.tracks) for (const sn of [tp.start, tp.end]) if (sn.kind === 'edge' && g.vehicles.isEdgeBusy(sn.edge!)) return 'Vehicle in the way';
  // (a tunnel beneath a busy road or track does not disturb it)
  const tunnelled = (c: CrossingPlan) => prop.tracks[c.track].sections.some((q) => q.type === 'tunnel' && c.sNew >= q.s0 - 0.5 && c.sNew <= q.s1 + 0.5);
  for (const c of prop.crossings) if ((c.mode === 'junction' || (c.mode === 'under' && !tunnelled(c))) && g.vehicles.isEdgeBusy(c.edge)) return 'Vehicle in the way';
  for (const q of roadBridges.works) if (g.vehicles.isEdgeBusy(q.edge)) return 'Vehicle in the way';
  if (co) co.economy.spend(prop.cost, 'construction');
  // demolition
  for (const id of prop.demolish) g.towns.demolishBuilding(id);
  const created: NEdge[] = [];
  const changedLocks: [number, number, number, number][] = [];
  // Install all quoted support before splitting any existing road. Splits inherit these sections.
  for (const q of roadBridges.works) {
    const e = net.edges.get(q.edge)!;
    const sec = { s0: q.s0, s1: q.s1, type: 'bridge' as const };
    for (const s of e.sections.filter(s => s.type === 'bridge' && s.s0 <= sec.s1 && s.s1 >= sec.s0)) {
      sec.s0 = Math.min(sec.s0, s.s0); sec.s1 = Math.max(sec.s1, s.s1);
    }
    e.sections = [...e.sections.filter(s => !(s.type === 'bridge' && s.s0 <= sec.s1 && s.s1 >= sec.s0)), sec].sort((a, b) => a.s0 - b.s0);
    net.touchEdge(e);
    const p = { x: 0, y: 0, z: 0 };
    let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
    for (let s = q.s0; s < q.s1 + 0.5; s += 0.5) {
      net.pointAt(e, Math.min(s, q.s1), p);
      x0 = Math.min(x0, p.x); z0 = Math.min(z0, p.z); x1 = Math.max(x1, p.x); z1 = Math.max(z1, p.z);
    }
    changedLocks.push([x0 - 2, z0 - 2, x1 + 2, z1 + 2]);
  }
  // edges that will be split later need their ids tracked through splits
  const remap = new Map<number, { e1: number; e2: number; s: number }>();
  const onSplit = (old: NEdge, e1: NEdge, e2: NEdge, s: number) => { remap.set(old.id, { e1: e1.id, e2: e2.id, s }); };
  net.onSplit.push(onSplit);
  const locate = (edgeId: number, s: number): { id: number; s: number } => {
    let id = edgeId;
    for (let guard = 0; guard < 20; guard++) {
      const r = remap.get(id);
      if (!r) break;
      if (s < r.s) id = r.e1; else { id = r.e2; s -= r.s; }
    }
    return { id, s };
  };
  try {
    for (const tp of prop.tracks) {
      const st = tp.start.kind === 'edge' ? { ...tp.start, ...(() => { const l = locate(tp.start.edge!, tp.start.s!); return { edge: l.id, s: l.s }; })() } : tp.start;
      const ta = { x: tp.bez.x1 - tp.bez.x0, z: tp.bez.z1 - tp.bez.z0 };
      const tla = Math.hypot(ta.x, ta.z) || 1;
      const na = resolveNode(g, st, opts.kind, tp.bez.x0, tp.bez.z0, tp.prof[0], ta.x / tla, ta.z / tla, opts.infrastructureOwner ?? opts.owner);
      const en = tp.end.kind === 'edge' ? { ...tp.end, ...(() => { const l = locate(tp.end.edge!, tp.end.s!); return { edge: l.id, s: l.s }; })() } : tp.end;
      const tb = { x: tp.bez.x3 - tp.bez.x2, z: tp.bez.z3 - tp.bez.z2 };
      const tlb = Math.hypot(tb.x, tb.z) || 1;
      const nb = resolveNode(g, en, opts.kind, tp.bez.x3, tp.bez.z3, tp.prof[tp.prof.length - 1], tb.x / tlb, tb.z / tlb, opts.infrastructureOwner ?? opts.owner);
      if (!na || !nb) return 'Network changed, try again';
      const bez = { ...tp.bez, x0: na.x, z0: na.z, x3: nb.x, z3: nb.z };
      const prof = tp.prof.slice();
      prof[0] = na.y; prof[prof.length - 1] = nb.y;
      created.push(net.addEdge(opts.kind, na.id, nb.id, bez, prof, tp.sections, opts.type, opts.infrastructureOwner ?? opts.owner, opts.tram && opts.kind === 'road' ? { tram: true, tramOwner: opts.owner } : {}));
    }
    // crossings
    for (const c of prop.crossings) {
      const ne = created[c.track];
      const old = locate(c.edge, c.sOld);
      const oe = net.edges.get(old.id);
      if (!oe || !ne) continue;
      if (c.mode === 'under') {
        // Roads were preflighted, priced and supported across every needed segment above.
        if (oe.kind === 'road') continue;
        if (net.sectionAt(oe, old.s) !== 'ground') continue;
        // a tunnel passes beneath: nothing above needs a bridge
        if (tunnelled(c)) continue;
        const hw = net.halfWidth(ne) + (prop.tracks.length - 1) * RAIL.spacing * 0.5;
        // the bridge spans the new line's formation and its cut slopes up to the old line's level
        const tp = prop.tracks[c.track];
        const dh = Math.max(0, net.heightAtS(oe, old.s) - profAt(tp.prof, tp.len, c.sNew));
        const slope = ne.kind === 'rail' ? EARTHWORKS.slopeRail : EARTHWORKS.slopeRoad;
        const wdt = Math.min(12, (hw + EARTHWORKS.corePad + dh / slope) / Math.max(0.35, Math.sin(c.angle)) + 0.3);
        const sec = { s0: Math.max(0, old.s - wdt), s1: Math.min(oe.len, old.s + wdt), type: 'bridge' as const };
        // merged with overlapping bridges
        for (const q of oe.sections.filter((q) => q.type === 'bridge' && q.s0 <= sec.s1 && q.s1 >= sec.s0)) { sec.s0 = Math.min(sec.s0, q.s0); sec.s1 = Math.max(sec.s1, q.s1); }
        oe.sections = [...oe.sections.filter((q) => !(q.type === 'bridge' && q.s0 <= sec.s1 && q.s1 >= sec.s0)), sec];
        oe.sections.sort((a, b) => a.s0 - b.s0);
        net.touchEdge(oe);
        changedLocks.push([c.x - wdt - 1, c.z - wdt - 1, c.x + wdt + 1, c.z + wdt + 1]);
      } else if (c.mode === 'level' || c.mode === 'diamond') {
        // the new edge may have been split by a junction of this proposal: locate the part at sNew
        const nl = locate(ne.id, c.sNew);
        const nE = net.edges.get(nl.id);
        if (!nE) continue;
        const rail = nE.kind === 'rail' ? nE : oe, road = nE.kind === 'rail' ? oe : nE;
        const sRail = rail === nE ? nl.s : old.s, sRoad = road === nE ? nl.s : old.s;
        const crossing = { id: net.nextCrossing++, kind: c.mode, e1: rail.id, s1: sRail, e2: road.id, s2: sRoad, x: c.x, z: c.z };
        net.crossings.set(crossing.id, crossing);
        g.vehicles.onCrossingAdded(crossing);
        net.markEdge(nE);
      } else if (c.mode === 'junction') {
        const sNew = locate(ne.id, c.sNew);
        const r1 = net.splitEdge(old.id, old.s);
        const r2 = net.splitEdge(sNew.id, sNew.s);
        if (r1 && r2) {
          r2.node.x = r1.node.x; r2.node.z = r1.node.z;
          net.mergeNodes(r1.node.id, r2.node.id);
        }
      }
    }
  } finally {
    net.onSplit = net.onSplit.filter((f) => f !== onSplit);
  }
  // final edges (after junction splits) for earthworks and tree clearing
  const finalEdges: NEdge[] = [];
  for (const e of created) {
    const ids = [e.id];
    const out: number[] = [];
    while (ids.length) { const id = ids.pop()!; const r = remap.get(id); if (r) ids.push(r.e1, r.e2); else out.push(id); }
    for (const id of out) { const fe = net.edges.get(id); if (fe) finalEdges.push(fe); }
  }
  // clear trees on the formation
  for (const e of finalEdges) {
    const geo = net.geo(e);
    const hw = net.halfWidth(e) + 0.5;
    for (let i = 0; i < geo.n; i += 2) if (net.sectionAt(e, geo.cum[i]) === 'ground') w.removeTreesNear(geo.pts[i * 3], geo.pts[i * 3 + 2], hw);
  }
  // Converting a crossing to a bridge unlocks its old formation. New track must not acquire
  // formation locks until its earthworks are complete, or its own fill is refused as existing rail.
  const ungraded = new Set(finalEdges.map((e) => e.id));
  for (const box of changedLocks) recomputeLocks(w, ...box, ungraded);
  applyEarthworks(w, finalEdges);
  coverTunnels(w, finalEdges);
  g.onNetworkChanged();
  return null;
}
