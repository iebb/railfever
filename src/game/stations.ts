// Stations: free-placed rail stations (on the ground, elevated on a viaduct, or underground) with platform edges,
// bus / tram stops on road edges, catchment areas per mode, road access and entrances, transfer complexes
// (stations merged into one, or linked for walking transfers), station names, and rebuilding / relocating.
import type { Game } from './game';
import { RAIL, ROAD_TYPES, WATER_Y } from './constants';
import { bezLine, bezPoint } from './geom';
import { NEdge, Section } from './network';
import { applyEarthworks } from './terraform';
import { distToRect } from './world';
import { rectsOverlap, Town, FLOOR_H } from './towns';
import { hash2 } from './rng';
import { planEdge, commitProposal, Snap, Proposal } from './construction';
import { connectStationThroat } from './trackops';

export interface WaitGroup { line: number; alight: number; dest: number; count: number }

export interface Rect { x: number; z: number; angle: number; w: number; d: number }

export type StationLevel = 'ground' | 'elevated' | 'underground';
export type CatchMode = 'rail' | 'tram' | 'bus';

/** Catchment radius per mode (units, 1 = 10 m): rail from the platforms (or the entrances), tram / bus from the stop. */
export const CATCHMENT_RADIUS: Record<CatchMode, number> = { rail: 40, tram: 22, bus: 16 };
/** A catchment circle; inactive ones (a rail part without road access) draw no passengers. */
export interface CatchShape { x: number; z: number; r: number; mode: CatchMode; active: boolean }
/** Default platform length of a new rail station (units; 80 m: a loco and two or three coaches). */
export const DEFAULT_PLATFORM_LENGTH = 8;
/** Walking range between the platforms / stops of two stations of a transfer complex (merge or link). */
export const TRANSFER_RANGE = 14;
/** A new bus / tram stop this close to an own rail station's structures becomes part of that station. */
export const STOP_JOIN = 8;
/** Pseudo line id of a walking transfer between linked stations in routing hops (never a waiting group's line). */
export const WALK_LINE = -1;
/** Street-level entrance footprints: underground entrance pavilions and elevated stair / lift towers. */
export const ENTRANCE_SIZE = { underground: { w: 0.7, d: 1.1 }, elevated: { w: 0.8, d: 0.8 } };
export const ENTRANCE_COST = { underground: 90_000, elevated: 60_000 };
/** Entrances lie within this distance of the platform area. */
export const ENTRANCE_REACH = 25;
/** Underground platforms this far below the lowest ground above them (default), elevated decks this high. */
export const STATION_DEPTH = { min: 1.5, max: 4, def: 2.6 };
export const STATION_HEIGHT = { min: 1.2, max: 3, def: 1.5 };
/** The forecourt (where the access street ends) lies this far out from the station building's street side. */
const FORECOURT = 0.85;
/** An access street is planned to roads within this distance of a ground station's forecourt. */
const ACCESS_REACH = 40;
/** Cost of a walking transfer: base + per unit walked (the line graph adds its transfer penalty on top). */
const WALK_BASE = 6, WALK_PER_UNIT = 2;

/** A street-level entrance (underground pavilion / elevated stair tower); forward (sin a, cos a) faces the street. */
export interface Entrance { x: number; z: number; angle: number }

export interface RailPart {
  x: number; z: number; y: number;
  /** axis direction (radians): tracks run along (sin a, cos a) */
  angle: number;
  length: number;
  tracks: number;
  /** lateral offsets of tracks and platforms (right of axis = positive, right = (cos a, -sin a)) */
  trackOffsets: number[];
  platforms: { off: number; w: number }[];
  /** platform track edges (station === this station's id) */
  edges: number[];
  /** through tracks (no platform): how many, their lateral offsets, and their edges (ordinary rail edges, station === -1) */
  through: number;
  throughOffsets: number[];
  throughEdges: number[];
  /** width of the track area (platform and through tracks) */
  width: number;
  /** where the through tracks lie */
  throughMode?: ThroughMode;
  /** ground: the station building; elevated / underground: the first entrance (kept for older code) */
  building: Rect;
  /** 'ground', 'elevated' (viaduct: platform edges carry a full-length bridge section) or 'underground' (tunnel section) */
  level: StationLevel;
  underground: boolean;
  /** underground: platform level below the lowest ground above the station (else 0) */
  depth: number;
  /** elevated: deck level above the highest ground beneath (else 0) */
  height: number;
  /** underground entrance pavilions / elevated stair towers at street level */
  entrances: Entrance[];
  /** elevated: viaduct columns */
  piers: { x: number; z: number }[];
  /** ground: the street side of the station building, where the access road ends */
  forecourt?: { x: number; z: number };
  /** what the station cost to build (asset value) */
  cost?: number;
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
  /** stations linked for walking transfers (a transfer complex), both ways */
  links: number[];
  /** can passengers reach the station? (rail: a road at the forecourt / an entrance, or a stop of the station) */
  roadAccess: boolean;
}

/** Collision rectangle of a station structure with its vertical extent (y0..y1) and what it is. */
export interface Footprint extends Rect { y0?: number; y1?: number; part?: 'platforms' | 'building' | 'entrance' | 'deck' | 'pier' }
/** A station structure's volume (for clearance checks). */
interface Volume extends Rect { y0: number; y1: number; part: 'platforms' | 'building' | 'entrance' | 'deck' | 'pier' }

/** Station names after places in town, by where the station is: core, inner streets, edge, waterside, hill. */
const PLACE_NAMES: Record<'core' | 'inner' | 'edge' | 'water' | 'hill', string[]> = {
  core: ['Market', 'Town Hall', 'Cathedral', 'High Street', 'Exchange', 'Arcade', 'Museum', 'Library', 'Old Town', "Queen's Square",
    "King's Road", 'Guildhall', 'Theatre', 'Clock Tower', 'Corn Exchange', 'Castle', 'Abbey', 'Minster', 'Royal Square', 'Opera House',
    'City Hall', 'Cloth Hall', 'Assembly Rooms', 'Market Cross', 'Old Bank', 'Corn Market', 'Butter Cross', 'Moot Hall'],
  inner: ['Church Road', 'Station Road', 'Mill Lane', 'Hospital', 'University', 'College', 'Brewery', 'Gasworks', 'Barracks', 'Stadium',
    'Foundry', 'Victoria Road', 'Albert Street', 'Chapel Street', 'Infirmary', 'School Lane', 'Post Office', 'Bank Street', 'Tannery',
    'Ropewalk', 'Mint', 'Courthouse', 'Arsenal', 'Cattle Market', 'Hay Market', 'Baths', 'Workhouse', 'Almshouses', 'Printworks',
    'Waterworks', 'Ironworks', 'Malthouse', 'Drill Hall', 'Tram Depot', 'Fire Station'],
  edge: ['Park', 'Gardens', 'Fields', 'Common', 'Green', 'Meadows', 'Orchard', 'Woodside', 'Gate', 'Grange', 'Manor', 'Cemetery',
    'Allotments', 'Brook', 'Lane End', 'Farm', 'Heath', 'Moor', 'Wood', 'Pastures', 'Parkway', 'Mill', 'Racecourse', 'Showground',
    'Golf Links', 'Copse', 'Spinney', 'Windmill', 'Toll Gate', 'Turnpike', 'Hollow', 'Paddocks', 'Leas', 'Warren'],
  water: ['Harbour', 'Riverside', 'Quay', 'Wharf', 'Docks', 'Waterfront', 'Embankment', 'Ferry', 'Lock', 'Marina', 'Strand', 'Pier',
    'Boatyard', 'Weir', 'Bridge', 'Lighthouse', 'Basin', 'Landing', 'Promenade', 'Esplanade', 'Seafront', 'Mill Race', 'Ford'],
  hill: ['Heights', 'Hill', 'Upper Town', 'Ridge', 'Terrace', 'Summit', 'Mount', 'Belvedere', 'Highfield', 'Crest', 'Brow', 'Top',
    'Hillside', 'Prospect', 'Overlook', 'Beacon', 'Tor'],
};
/** Further landmarks, and street names built from two parts (hundreds of names before numbers are needed). */
const LANDMARKS = ['Junction', 'Cross', 'Square', 'Parade', 'Circus', 'Crescent', 'Walk', 'Court', 'Yard', 'Halt', 'Arches',
  'Viaduct', 'Interchange', 'Corner', 'Triangle', 'Precinct', 'Mews', 'Close', 'Plaza', 'Quarter', 'Village', 'Town', 'Exchange Place'];
const STREET_A = ['Elm', 'Oak', 'Ash', 'Beech', 'Birch', 'Cedar', 'Chestnut', 'Holly', 'Maple', 'Willow', 'Hawthorn', 'Linden', 'Victoria',
  'Albert', 'George', 'Princes', 'Queen', 'King', 'Duke', 'York', 'Clarence', 'Bridge', 'Church', 'Chapel', 'Market', 'Castle', 'Abbey',
  'Priory', 'Grove', 'Spring', 'Well', 'Bell', 'Crown', 'Rose', 'Lark', 'Swan', 'Fox', 'Hart', 'Garden', 'Meadow', 'Canal', 'Forge',
  'Kiln', 'Granary', 'Union', 'Waterloo', 'Trafalgar', 'Nelson', 'Wellington', 'Regent', 'Stone', 'Silver', 'Copper', 'North', 'South',
  'East', 'West', 'New', 'Old', 'Long'];
const STREET_B = ['Road', 'Street', 'Lane', 'Avenue', 'Way', 'Place', 'Hill', 'Row'];

export interface StationLayout {
  /** lateral offsets of the platform tracks (right of the axis = positive), left to right */
  trackOffsets: number[];
  /** lateral offsets of the through tracks (no platform), left to right */
  throughOffsets: number[];
  platforms: { off: number; w: number }[];
  /** width of the track area (platforms and through tracks) */
  width: number;
}

/** Where through tracks go: between the platform tracks ('middle': side platforms outside, e.g. p t T T t p) or outside the platform group ('outer', e.g. T t p t T). */
export type ThroughMode = 'middle' | 'outer';

/**
 * Station layout across the tracks (compact but realistic widths). Without through tracks: island platforms
 * between pairs of platform tracks (t p t, t p t t p t ...; one track: t p). With 1-2 through tracks: 'middle'
 * puts them between the platform tracks, which get side platforms (p t T T t p; p t T for one platform track),
 * 'outer' keeps the island layout and adds them outside (T t p t T).
 */
export function stationLayout(tracks: number, through = 0, mode: ThroughMode = 'middle'): StationLayout {
  const PW = 0.56, CL = 0.21; // platform width, platform edge to track centre
  type It = { kind: 't' | 'p' | 'T'; w: number };
  const islands = (n: number): It[] => {
    const out: It[] = [];
    for (let i = 0; i < n; i++) { out.push({ kind: 't', w: 0 }); if (i % 2 === 0) out.push({ kind: 'p', w: PW }); }
    return out;
  };
  /** platform tracks on one side of middle through tracks, outside in: a side platform when odd, then islands */
  const side = (k: number): It[] => {
    const out: It[] = [];
    if (k % 2) out.push({ kind: 'p', w: PW }, { kind: 't', w: 0 });
    for (let i = 0; i < Math.floor(k / 2); i++) out.push({ kind: 't', w: 0 }, { kind: 'p', w: PW }, { kind: 't', w: 0 });
    return out;
  };
  const T = Math.max(0, Math.min(2, Math.round(through)));
  const thr: It[] = Array.from({ length: T }, () => ({ kind: 'T' as const, w: 0 }));
  let items: It[];
  if (!T) items = islands(tracks);
  else if (mode === 'outer') items = T === 2 ? [thr[0], ...islands(tracks), thr[1]] : [...islands(tracks), thr[0]];
  else items = [...side(Math.ceil(tracks / 2)), ...thr, ...side(Math.floor(tracks / 2)).reverse()];
  const pos: number[] = [];
  let x = 0;
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    if (i > 0) {
      const prev = items[i - 1];
      if (prev.kind !== 'p' && it.kind !== 'p') x += RAIL.spacing + 0.1;
      else if (it.kind === 'p') x += CL + it.w / 2;
      else x += prev.w / 2 + CL;
    }
    pos.push(x);
  }
  const mid = (pos[0] + pos[pos.length - 1]) / 2;
  const out: StationLayout = { trackOffsets: [], throughOffsets: [], platforms: [], width: pos[pos.length - 1] - pos[0] + 0.6 };
  items.forEach((it, i) => {
    if (it.kind === 't') out.trackOffsets.push(pos[i] - mid);
    else if (it.kind === 'T') out.throughOffsets.push(pos[i] - mid);
    else out.platforms.push({ off: pos[i] - mid, w: it.w });
  });
  return out;
}

/** Compact station building scaled to the platform length and number of tracks (w along the tracks, d across). */
export function stationBuildingSize(length: number, tracks: number): { w: number; d: number } {
  return { w: Math.min(3.6, Math.max(1.6, 1.2 + length * 0.12 + tracks * 0.2)), d: Math.min(1.3, 0.8 + tracks * 0.08) };
}

/** Width of a station's track area (older saves lack the stored width). */
export function railWidth(r: RailPart): number { return r.width || stationLayout(r.tracks, r.through ?? 0).width; }

/** Catchment circles of rail platforms: along the axis (both ends and between), so the area is measured from the platforms. */
export function railCatchShapes(x: number, z: number, angle: number, length: number, active = true): CatchShape[] {
  const R = CATCHMENT_RADIUS.rail, fx = Math.sin(angle), fz = Math.cos(angle);
  const n = length < 2 ? 1 : Math.max(3, Math.ceil(length / (R * 0.5)) + 1);
  const out: CatchShape[] = [];
  for (let i = 0; i < n; i++) {
    const a = n === 1 ? 0 : -length / 2 + (length * i) / (n - 1);
    out.push({ x: x + fx * a, z: z + fz * a, r: R, mode: 'rail', active });
  }
  return out;
}

/** Catchment circle of a bus or tram stop. */
export function stopCatchShape(x: number, z: number, tram: boolean): CatchShape {
  return { x, z, r: tram ? CATCHMENT_RADIUS.tram : CATCHMENT_RADIUS.bus, mode: tram ? 'tram' : 'bus', active: true };
}

/** Distance between two oriented rectangles (0 if they overlap). */
function rectGap(a: Rect, b: Rect): number {
  if (rectsOverlap(a, b, 0)) return 0;
  let d = Infinity;
  for (const [p, q] of [[a, b], [b, a]] as [Rect, Rect][]) {
    const fx = Math.sin(p.angle), fz = Math.cos(p.angle), rx = fz, rz = -fx;
    for (const [sa, sb] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      const cx = p.x + rx * (p.w / 2) * sa + fx * (p.d / 2) * sb, cz = p.z + rz * (p.w / 2) * sa + fz * (p.d / 2) * sb;
      d = Math.min(d, distToRect(cx, cz, q.x, q.z, q.angle, q.w / 2, q.d / 2));
    }
  }
  return d;
}

const angleOf = (fx: number, fz: number) => Math.atan2(fx, fz);

export interface StationOpts {
  /** 'ground' (default), 'elevated' (viaduct) or 'underground' */
  level?: StationLevel;
  /** alias of level 'underground' */
  underground?: boolean;
  /** elevated: deck height above the highest ground beneath (STATION_HEIGHT) */
  height?: number;
  /** underground: platform level below the lowest ground above (STATION_DEPTH) */
  depth?: number;
  /** ground: put the building on this side of the tracks (+1 right, -1 left; default: the better side) */
  buildingSide?: 1 | -1;
  /** plan ignoring this station's own structures (rebuilding / relocating it) */
  ignoreStation?: number;
  /** plan ignoring these edges (approach track that becomes platform when rebuilding) */
  ignoreEdges?: Set<number>;
  /** through tracks without platforms (0-2) for trains that do not stop, and where they go */
  through?: number;
  throughMode?: ThroughMode;
  /** platform level fixed (a station inserted into an existing line at the track's height) */
  fixedY?: number;
}

export interface StationPlan {
  ok: boolean;
  error?: string;
  /** e.g. no road within reach (the station would have no road access, hence no passengers) */
  warnings: string[];
  x: number; z: number; y: number; angle: number;
  length: number; tracks: number;
  /** through tracks (no platform) and where they lie */
  through: number; throughMode: ThroughMode;
  level: StationLevel;
  underground: boolean;
  /** underground depth / elevated height (0 on the ground) */
  depth: number; height: number;
  layout: StationLayout;
  footprint: Rect;
  building: Rect;
  /** underground / elevated: street-level entrances (with road access or not) */
  entrances: (Entrance & { access: boolean })[];
  piers: { x: number; z: number }[];
  demolish: number[];
  cost: number;
  /** an own bus / tram stop station this station joins (one station), or null */
  join: Station | null;
  /** own stations within walking range that get linked for transfers */
  links: Station[];
  /** ground: the access street to build (its cost is part of `cost`), null if none is needed or possible */
  access: Proposal | null;
  /** will passengers reach the station (road at the forecourt / an entrance, or a joined stop)? */
  roadAccess: boolean;
  forecourt: { x: number; z: number } | null;
}

export interface BusStopPlan {
  ok: boolean; error?: string; edge?: NEdge; s?: number; px?: number; pz?: number; cost: number;
  /** own station the stop becomes part of (a rail station within walking range, or a stop across the street) */
  join: Station | null;
  /** own stations within walking range that get linked for transfers */
  links: Station[];
  mode: 'bus' | 'tram';
}

export interface UpgradeOpts { length?: number; tracks?: number; through?: number; level?: StationLevel; height?: number; depth?: number }

/** Planned rebuild of a rail station with longer platforms / more tracks (planStationUpgrade). */
export interface UpgradePlan {
  ok: boolean; error?: string; warnings: string[];
  station: number;
  cost: number;
  length: number; tracks: number; through: number;
  /** the new station part (null when the upgrade is not possible) */
  plan: StationPlan | null;
  /** how far each end moves out (+) or in (-): [front, back] */
  delta: [number, number];
  /** new layout key ('<i>' platform track i, 'T<i>' through track i) of every old track, in lateral order */
  keep: string[];
  /**
   * Connected ends that move out: per old track (lateral rank) the approach edges replaced by platform and the
   * edge split where the new platform end goes (or `at`, the node already there).
   */
  cuts: { end: 0 | 1; rank: number; node: number; remove: number[]; edge: number; s: number; fromA: boolean; at: number }[];
  /** whole rebuild through relocation (level change of an unconnected station) */
  rebuild: boolean;
}

export class Stations {
  map = new Map<number, Station>();
  nextId = 1;
  /** network version the stations' road access was last computed at */
  private accessVersion = -1;
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
          const j = st.rail.throughEdges.indexOf(old.id);
          if (j >= 0) st.rail.throughEdges.splice(j, 1, e1.id, e2.id);
        }
      }
    });
    net.onRemove.push((e) => {
      for (const st of [...this.map.values()]) {
        const before = st.stops.length;
        st.stops = st.stops.filter((p) => p.edge !== e.id);
        if (st.rail) { st.rail.edges = st.rail.edges.filter((x) => x !== e.id); st.rail.throughEdges = st.rail.throughEdges.filter((x) => x !== e.id); }
        if (st.stops.length !== before && !st.stops.length && !st.rail) this.deleteStation(st.id);
      }
    });
    game.listeners?.network?.push(() => this.refreshAccess());
  }

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  private create(x: number, z: number, owner: number): Station {
    const g = this.game;
    const town = g.towns.nearest(x, z);
    const st: Station = {
      id: this.nextId++, name: this.stationName(x, z, town), owner, townId: town ? town.id : -1, x, z, rail: null, stops: [],
      waiting: new Map(), waitingTotal: 0, rating: 0.65, lastPickup: g.day, lastSpeed: 0,
      catchPop: 0, genAccum: 0, genMonth: 0, genLast: 0, pickupMonth: 0, pickupLast: 0, arrivedMonth: 0, arrivedLast: 0, built: g.day,
      links: [], roadAccess: true,
    };
    this.map.set(st.id, st);
    return st;
  }

  // ---------------------------------------------------------------- names
  /** A unique name for a new station at (x, z): the town's name, then "<Town> <place>" by position, numbers last. */
  stationName(x: number, z: number, town: Town | null = this.game.towns.nearest(x, z)): string {
    const used = new Set<string>();
    for (const s of this.map.values()) used.add(s.name);
    const base = town ? town.name : 'Station';
    if (!used.has(base)) return base;
    for (const s of this.placeNames(x, z, town)) if (!used.has(`${base} ${s}`)) return `${base} ${s}`;
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  /**
   * Name suffixes for a station at (x, z), most fitting first: by the water (harbour, quay...), on a hill
   * (heights...), in the core (market, town hall...), the inner streets (church road, hospital...) or at
   * the edge (park, fields...), then the compass point, then all other places, landmarks and street names.
   */
  private placeNames(x: number, z: number, town: Town | null): string[] {
    const w = this.game.world;
    const kinds: (keyof typeof PLACE_NAMES)[] = [];
    let water = false;
    for (let k = 0; k < 12 && !water; k++) {
      const a = (k / 12) * Math.PI * 2, r = k % 2 ? 9 : 5;
      if (w.heightAt(x + Math.sin(a) * r, z + Math.cos(a) * r) < WATER_Y) water = true;
    }
    if (water) kinds.push('water');
    const dir: string[] = [];
    if (town) {
      const dx = x - town.x, dz = z - town.z, d = Math.hypot(dx, dz);
      if (w.heightAt(x, z) - w.heightAt(town.x, town.z) > 1.2) kinds.push('hill');
      if (d < 8) dir.push('Central');
      kinds.push(d < Math.max(7, town.radius * 0.3) ? 'core' : d < town.radius * 0.7 ? 'inner' : 'edge');
      const ns = dz > 0 ? 'South' : 'North', ew = dx > 0 ? 'East' : 'West';
      dir.push(Math.abs(dx) > Math.abs(dz) ? ew : ns, `${ns} ${ew}`.replace(/^(North|South) (East|West)$/, (_, a, b) => a + b.toLowerCase()));
    } else kinds.push('edge');
    for (const k of ['core', 'inner', 'edge', 'hill', 'water'] as const) if (!kinds.includes(k)) kinds.push(k);
    const seed = (n: number) => Math.floor(hash2(Math.round(x * 4), Math.round(z * 4), n) * n);
    const out: string[] = [];
    kinds.forEach((k, i) => {
      const list = PLACE_NAMES[k], s0 = seed(list.length);
      for (let j = 0; j < list.length; j++) out.push(list[(s0 + j) % list.length]);
      if (i === 0) out.push(...dir);
    });
    const l0 = seed(LANDMARKS.length);
    for (let j = 0; j < LANDMARKS.length; j++) out.push(LANDMARKS[(l0 + j) % LANDMARKS.length]);
    const a0 = seed(STREET_A.length), b0 = seed(STREET_B.length + 3);
    for (let j = 0; j < STREET_A.length * STREET_B.length; j++) {
      const a = STREET_A[(a0 + j) % STREET_A.length], b = STREET_B[(b0 + Math.floor(j / STREET_A.length) + j) % STREET_B.length];
      out.push(`${a} ${b}`);
    }
    return out;
  }

  deleteStation(id: number) {
    const st = this.map.get(id);
    if (!st) return;
    for (const o of st.links) { const os = this.map.get(o); if (os) os.links = os.links.filter((x) => x !== id); }
    st.links = [];
    this.map.delete(id);
    this.game.lines.onStationRemoved(id);
    this.markStation(st);
  }

  /** Mark the object chunks of a station's structures (platforms, building, entrances, piers) for re-rendering. */
  private markStation(st: Station) {
    const w = this.game.world;
    w.markObjArea(st.x - 20, st.z - 20, st.x + 20, st.z + 20);
    const r = st.rail;
    if (!r) return;
    w.markObjArea(r.x - r.length / 2 - 3, r.z - r.length / 2 - 3, r.x + r.length / 2 + 3, r.z + r.length / 2 + 3);
    for (const e of [...r.entrances, r.building, ...r.piers]) w.markObjArea(e.x - 2.5, e.z - 2.5, e.x + 2.5, e.z + 2.5);
    if (r.forecourt) w.markObjArea(r.forecourt.x - 2, r.forecourt.z - 2, r.forecourt.x + 2, r.forecourt.z + 2);
  }

  hasRail(st: Station) { return !!st.rail; }
  hasRoad(st: Station) { return st.stops.length > 0; }
  levelOf(st: Station): StationLevel { return st.rail?.level ?? 'ground'; }

  /** Collision rectangles of station structures at street level (underground: only the entrances). */
  footprints(st: Station): Footprint[] { return this.structures(st); }

  /** Cached station structure volumes (planning queries hit these per sample point). */
  private structCache = new WeakMap<RailPart, { key: string; v: Volume[] }>();

  private structures(st: Station): Volume[] {
    const r = st.rail;
    if (!r) return [];
    const b = r.building;
    const key = `${this.game.world.heightsVersion}|${r.x}|${r.z}|${r.y}|${r.angle}|${r.length}|${r.tracks}|${r.through ?? 0}|${r.width ?? 0}|${r.level}|${b.x}|${b.z}|${b.w}|${b.d}|${(r.entrances ?? []).length}|${(r.piers ?? []).length}`;
    const c = this.structCache.get(r);
    if (c && c.key === key) return c.v;
    const v = this.buildStructures(r);
    this.structCache.set(r, { key, v });
    return v;
  }

  private buildStructures(r: RailPart): Volume[] {
    const w = this.game.world;
    const lv = r.level ?? 'ground';
    const fp = { x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: r.length };
    if (lv === 'ground') return [{ ...fp, y0: r.y - 0.3, y1: r.y + 1.0, part: 'platforms' }, { ...r.building, y0: r.y - 0.2, y1: r.y + 1.4, part: 'building' }];
    const out: Volume[] = [];
    const sz = ENTRANCE_SIZE[lv];
    if (lv === 'elevated') {
      out.push({ ...fp, y0: r.y - 0.4, y1: r.y + 1.0, part: 'deck' });
      for (const p of r.piers ?? []) { const h = w.heightAt(p.x, p.z); out.push({ x: p.x, z: p.z, angle: r.angle, w: 0.4, d: 0.4, y0: h - 0.3, y1: r.y, part: 'pier' }); }
    }
    for (const e of r.entrances ?? []) { const h = w.heightAt(e.x, e.z); out.push({ x: e.x, z: e.z, angle: e.angle, w: sz.w, d: sz.d, y0: h - 0.2, y1: lv === 'elevated' ? r.y + 1.0 : h + 0.6, part: 'entrance' }); }
    return out;
  }

  /** Underground station box (platforms and tracks below ground), for 3D clearance checks. */
  private volumes(st: Station): Volume[] {
    const r = st.rail;
    if (!r) return [];
    const out = this.structures(st).slice();
    if ((r.level ?? 'ground') === 'underground') out.push({ x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: r.length, y0: r.y - 0.4, y1: r.y + 1.1, part: 'platforms' });
    return out;
  }

  footprintsNear(x: number, z: number, r: number): Station[] {
    const out: Station[] = [];
    for (const st of this.map.values()) {
      if (!st.rail) continue;
      if (Math.hypot(st.rail.x - x, st.rail.z - z) > st.rail.length / 2 + ENTRANCE_REACH + 6 + r) continue;
      for (const f of this.footprints(st)) if (distToRect(x, z, f.x, f.z, f.angle, f.w / 2, f.d / 2) <= r) { out.push(st); break; }
    }
    return out;
  }

  // ---------------------------------------------------------------- obstacles
  /**
   * Conflicts of a rectangle spanning heights y0..y1: buildings (collected in `demolish`, or a conflict without
   * it), network edges (`groundEdges`: any edge on the ground conflicts, as for a levelled site), stations and
   * depots. Returns the reason or null.
   */
  private rectConflict(rect: Rect, y0: number, y1: number, demolish: Set<number> | null, o: { groundEdges?: boolean; ignoreStation?: number; ignoreEdges?: Set<number>; skipRoad?: number } = {}): string | null {
    // edges: rail [y - 0.1, y + 0.5], road [y - 0.1, y + 0.45] (the planner's 0.62 clearance between running surfaces)
    const g = this.game, w = g.world, net = w.net;
    const R = Math.hypot(rect.w, rect.d) / 2 + 1;
    for (const id of w.bgrid.query(rect.x - R, rect.z - R, rect.x + R, rect.z + R)) {
      const b = w.buildings.get(id);
      if (!b || !rectsOverlap(rect, b, 0.05)) continue;
      if (b.y + b.floors * FLOOR_H + 0.45 < y0 || b.y - 0.2 > y1) continue;
      if (!demolish) return 'Building in the way';
      demolish.add(id);
    }
    for (const e of net.edgesNear(rect.x - R, rect.z - R, rect.x + R, rect.z + R)) {
      if (o.ignoreEdges?.has(e.id) || e.id === o.skipRoad) continue;
      if (o.ignoreStation !== undefined && e.station === o.ignoreStation) continue;
      const geo = net.geo(e), hw = net.halfWidth(e);
      for (let i = 0; i < geo.n; i++) {
        if (distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2) >= hw - 0.05) continue;
        const ey = geo.pts[i * 3 + 1];
        const sec = net.sectionAt(e, geo.cum[i]);
        if ((o.groundEdges && sec === 'ground') || (ey + (e.kind === 'rail' ? 0.5 : 0.45) > y0 && ey - 0.1 < y1)) return e.kind === 'rail' ? (sec === 'tunnel' ? 'Tunnel in the way' : 'Track in the way') : 'Road in the way';
      }
    }
    for (const st of this.footprintsNear(rect.x, rect.z, R + 2)) {
      if (st.id === o.ignoreStation) continue;
      for (const f of this.volumes(st)) if (f.y1 > y0 && f.y0 < y1 && rectsOverlap(rect, f, 0)) return 'Station in the way';
    }
    for (const st of this.map.values()) {
      if (!st.rail || st.id === o.ignoreStation || st.rail.level !== 'underground') continue;
      if (Math.hypot(st.rail.x - rect.x, st.rail.z - rect.z) > st.rail.length / 2 + R + 3) continue;
      for (const f of this.volumes(st)) if (f.y1 > y0 && f.y0 < y1 && rectsOverlap(rect, f, 0)) return 'Station in the way';
    }
    for (const d of g.depots.near(rect.x, rect.z, R)) {
      const sz = d.kind === 'rail' ? { w: 1.5, d: 4.2 } : d.kind === 'tram' ? { w: 2.0, d: 3.9 } : { w: 1.8, d: 1.6 };
      if (d.y + 1.0 > y0 && d.y - 0.2 < y1 && rectsOverlap(rect, { x: d.x, z: d.z, angle: d.angle, w: sz.w, d: sz.d }, 0)) return 'Depot in the way';
    }
    return null;
  }

  // ---------------------------------------------------------------- rail stations
  /**
   * Plan a rail station centred at (x, z) with tracks along `angle`. Ground stations level their site, demolish
   * what is in the way and get a building with an access street to the nearest road; elevated stations sit on
   * a viaduct (only pier and stair tower sites are cleared), underground ones below the surface with entrance
   * pavilions beside streets.
   */
  planRail(x: number, z: number, angle: number, length: number, tracks: number, owner: number, opts: StationOpts = {}): StationPlan {
    const g = this.game, w = g.world;
    const level: StationLevel = opts.level ?? (opts.underground ? 'underground' : 'ground');
    const through = Math.max(0, Math.min(2, Math.round(opts.through ?? 0))), throughMode = opts.throughMode ?? 'middle';
    const layout = stationLayout(tracks, through, throughMode);
    const fx = Math.sin(angle), fz = Math.cos(angle);
    const footprint: Rect = { x, z, angle, w: layout.width, d: length };
    const plan: StationPlan = {
      ok: true, warnings: [], x, z, y: 0, angle, length, tracks, through, throughMode, level, underground: level === 'underground', depth: 0, height: 0, layout, footprint,
      building: { x, z, angle, w: 0, d: 0 }, entrances: [], piers: [], demolish: [], cost: 0, join: null, links: [], access: null, roadAccess: false, forecourt: null,
    };
    const failp = (e: string) => { if (plan.ok) { plan.ok = false; plan.error = e; } };
    if (!(length >= 3) || !(tracks >= 1 && tracks <= 8)) failp('Invalid station size');
    // terrain over the site
    const rx = fz, rz = -fx;
    let sum = 0, cnt = 0, mn = Infinity, mx = -Infinity, wet = false;
    for (let a = -0.5; a <= 0.5; a += 0.125) for (let b = -0.5; b <= 0.5; b += 0.25) {
      const px = x + fx * length * a + rx * layout.width * b, pz = z + fz * length * a + rz * layout.width * b;
      if (!w.inside(px, pz, 2)) failp('Too close to the map edge');
      const h = w.heightAt(px, pz);
      if (h < 0.1) wet = true;
      sum += h; cnt++; mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    const demolish = new Set<number>();
    const base = (tracks + through * 0.7) * length * 9000 + 120000;
    const fixed = opts.fixedY;
    const ign = opts.ignoreStation;
    if (level === 'ground') {
      if (wet) failp('Cannot build on water');
      plan.y = fixed ?? Math.max(0.3, sum / cnt);
      if (fixed === undefined ? mx - mn > 3 : Math.max(mx - fixed, fixed - mn) > 3.5) failp('Ground is too uneven');
      const err = this.rectConflict(footprint, plan.y - 0.3, plan.y + 1.0, demolish, { groundEdges: true, ignoreStation: ign, ignoreEdges: opts.ignoreEdges });
      if (err) failp(err);
      // the building beside the platforms (either side, centred or towards an end) where its forecourt is
      // closest to a road on its own side of the tracks (or beyond the platform ends' lead corridors), with
      // nothing in the way but a few houses
      const bs = stationBuildingSize(length, tracks + through);
      const cands: { b: Rect; fc: { x: number; z: number }; dem: Set<number>; score: number; road: number }[] = [];
      const slide = Math.max(0, length / 2 - bs.w / 2 - 0.2);
      const roadPts: { x: number; z: number; lat: number; lon: number }[] = [];
      {
        const R = length / 2 + ACCESS_REACH, p = { x: 0, y: 0, z: 0 };
        for (const e of w.net.edgesNear(x - R, z - R, x + R, z + R)) {
          if (e.kind !== 'road' || e.depot >= 0) continue;
          for (let sv = 0; sv <= e.len; sv += 1) {
            w.net.pointAt(e, Math.min(sv, e.len), p);
            const dx = p.x - x, dz = p.z - z;
            if (dx * dx + dz * dz > R * R) continue;
            roadPts.push({ x: p.x, z: p.z, lat: dx * rx + dz * rz, lon: dx * fx + dz * fz });
          }
        }
      }
      const roadDist = (fc: { x: number; z: number }, side: number) => {
        let d = Infinity;
        for (const q of roadPts) {
          if (q.lat * side < layout.width / 2 + 0.3 && Math.abs(q.lon) < length / 2 + 26) continue;
          d = Math.min(d, Math.hypot(q.x - fc.x, q.z - fc.z));
        }
        return d;
      };
      for (const side of opts.buildingSide ? [opts.buildingSide] : [-1, 1] as const) for (const k of [0, 1, -1, 0.5, -0.5]) {
        const off = layout.width / 2 + bs.d / 2 + 0.15, along = slide * k;
        const bx = x + rx * off * side + fx * along, bz = z + rz * off * side + fz * along;
        const b: Rect = { x: bx, z: bz, angle: angle - (Math.PI / 2) * side, w: bs.w, d: bs.d };
        const fc = { x: bx + rx * (bs.d / 2 + FORECOURT) * side, z: bz + rz * (bs.d / 2 + FORECOURT) * side };
        const dem = new Set<number>();
        if (this.rectConflict(b, plan.y - 0.2, plan.y + 1.4, dem, { groundEdges: true, ignoreStation: ign, ignoreEdges: opts.ignoreEdges })) continue;
        let pop = 0;
        for (const id of dem) pop += w.buildings.get(id)?.pop ?? 0;
        const road = Math.max(0, roadDist(fc, side) - 0.9);
        cands.push({ b, fc, dem, road, score: pop + dem.size * 3 + Math.min(road, ACCESS_REACH * 1.5) * 3 + Math.abs(k) * 4 + (side === -1 ? 0 : 0.3) });
      }
      cands.sort((p, q) => p.score - q.score);
      const pick = (c: (typeof cands)[number]) => { plan.building = c.b; plan.forecourt = c.fc; for (const id of c.dem) demolish.add(id); };
      if (!cands.length) { failp('No room for the station building'); plan.building = { x: x - rx * (layout.width / 2 + 0.6), z: z - rz * (layout.width / 2 + 0.6), angle: angle + Math.PI / 2, w: bs.w, d: bs.d }; }
      else pick(cands[0]);
      (plan as StationPlan & { buildingCands?: typeof cands }).buildingCands = cands;
      plan.cost = base + (mx - mn) * length * layout.width * 600;
    } else if (level === 'underground') {
      if (wet) failp('Cannot build under water');
      plan.depth = Math.max(STATION_DEPTH.min, Math.min(STATION_DEPTH.max, opts.depth ?? STATION_DEPTH.def));
      plan.y = mn - plan.depth;
      if (fixed !== undefined) { plan.y = fixed; plan.depth = mn - fixed; if (plan.depth < STATION_DEPTH.min - 0.4) failp('Too close to the surface for an underground station'); }
      const err = this.rectConflict(footprint, plan.y - 0.4, plan.y + 1.1, null, { ignoreStation: ign, ignoreEdges: opts.ignoreEdges });
      if (err) failp(err === 'Building in the way' ? 'Foundations in the way' : err);
      const k = (plan.depth - STATION_DEPTH.min) / (STATION_DEPTH.max - STATION_DEPTH.min);
      plan.cost = base * (5 + 3 * k);
    } else {
      // elevated: the deck clears the ground, buildings, roads and tracks beneath
      plan.height = Math.max(STATION_HEIGHT.min, Math.min(STATION_HEIGHT.max, opts.height ?? STATION_HEIGHT.def));
      let top = mx + plan.height;
      const R = Math.hypot(footprint.w, footprint.d) / 2 + 1;
      for (const id of w.bgrid.query(x - R, z - R, x + R, z + R)) {
        const b = w.buildings.get(id);
        if (b && rectsOverlap(footprint, b, 0.1)) top = Math.max(top, b.y + b.floors * FLOOR_H + 0.95);
      }
      for (const e of w.net.edgesNear(x - R, z - R, x + R, z + R)) {
        if (ign !== undefined && e.station === ign) continue;
        const geo = w.net.geo(e), hw = w.net.halfWidth(e);
        for (let i = 0; i < geo.n; i++) {
          if (distToRect(geo.pts[i * 3], geo.pts[i * 3 + 2], x, z, angle, footprint.w / 2, footprint.d / 2) >= hw) continue;
          const ey = geo.pts[i * 3 + 1];
          if (ey < top + 0.5) top = Math.max(top, ey + RAIL.clearance + 0.3);
        }
      }
      if (fixed !== undefined) { if (fixed < top - 0.05) failp('Too low for an elevated station here'); top = fixed; }
      plan.y = top;
      if (top - mx > 5.2) failp('Too tall beneath (the deck would be over 50 m high)');
      plan.height = top - mx;
      const err = this.rectConflict(footprint, plan.y - 0.4, plan.y + 1.0, null, { ignoreStation: ign, ignoreEdges: opts.ignoreEdges });
      if (err) failp(err === 'Building in the way' ? 'Tall building in the way' : err);
      const pr = this.viaductPiers(footprint, layout.width, demolish, ign);
      if (pr.error) failp(pr.error);
      plan.piers = pr.piers;
      const k = Math.min(1, Math.max(0, (plan.height - STATION_HEIGHT.min) / 1.8));
      plan.cost = base * (3 + k);
    }
    if (level !== 'ground') {
      const want = length >= 20 ? 4 : length >= 13 ? 3 : 2;
      const sites = this.entranceSites(level, footprint, want, [], ign);
      if (!sites.length) failp('No room for station entrances');
      plan.entrances = sites.map((s) => ({ x: s.x, z: s.z, angle: s.angle, access: s.access }));
      for (const s of sites) for (const id of s.demolish) demolish.add(id);
      plan.cost += sites.length * ENTRANCE_COST[level];
      const e0 = plan.entrances[0];
      if (e0) { const sz = ENTRANCE_SIZE[level]; plan.building = { x: e0.x, z: e0.z, angle: e0.angle, w: sz.w, d: sz.d }; }
      plan.roadAccess = plan.entrances.some((e) => e.access);
    }
    // transfer complex: an own stop-only station within walking range is joined, other own stations are linked
    const cand = this.nearOwn(owner, (o) => this.gapToArea(o, footprint), ign);
    const rects = level === 'ground' ? [footprint, plan.building] : [footprint, ...plan.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle, w: ENTRANCE_SIZE[level].w, d: ENTRANCE_SIZE[level].d }))];
    for (const c of cand) {
      const close = !c.st.rail && c.st.stops.some((q) => rects.some((f) => distToRect(q.x, q.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < STOP_JOIN));
      if (!plan.join && close) plan.join = c.st;
      else if (c.gap <= TRANSFER_RANGE && c.st.id !== ign) plan.links.push(c.st);
    }
    // road access: a road at the forecourt, else an access street to a road within reach (other building sites
    // are tried when the best one gets none)
    const bc = (plan as StationPlan & { buildingCands?: { b: Rect; fc: { x: number; z: number }; dem: Set<number>; road: number }[] }).buildingCands;
    delete (plan as StationPlan & { buildingCands?: unknown }).buildingCands;
    if (level === 'ground' && plan.ok && plan.forecourt && bc) {
      const chosen = bc[0];
      for (const c of bc.slice(0, 6)) {
        if (c.road > ACCESS_REACH) continue;
        const swap = () => {
          if (c === chosen) return;
          for (const id of chosen.dem) if (!c.dem.has(id)) demolish.delete(id);
          for (const id of c.dem) demolish.add(id);
          plan.building = c.b; plan.forecourt = c.fc;
        };
        if (this.roadContact(c.fc.x, c.fc.z, 0.9)) { swap(); plan.roadAccess = true; break; }
        plan.building = c.b;
        const acc = this.planAccessStreet(c.fc.x, c.fc.z, plan, owner);
        plan.building = chosen.b;
        if (acc) { swap(); plan.access = acc; plan.cost += acc.cost; plan.roadAccess = true; break; }
      }
    }
    plan.demolish = [...demolish];
    for (const id of plan.demolish) { const b = w.buildings.get(id); if (b) plan.cost += 6000 + b.pop * 2500; }
    if (plan.join) plan.roadAccess = true;
    if (!plan.roadAccess && plan.ok) plan.warnings.push(level === 'ground' ? 'No road within reach: without road access the station draws no passengers' : 'No entrance next to a road: without road access the station draws no passengers');
    plan.cost = Math.round(plan.cost);
    return plan;
  }

  /** Own stations (or `pred`-matching ones) with their walking gap to an area, nearest first. */
  private nearOwn(owner: number, gap: (st: Station) => number, ignore?: number): { st: Station; gap: number }[] {
    const out: { st: Station; gap: number }[] = [];
    for (const st of this.map.values()) {
      if (st.owner !== owner || st.id === ignore) continue;
      const d = gap(st);
      if (d <= TRANSFER_RANGE * 2) out.push({ st, gap: d });
    }
    return out.sort((a, b) => a.gap - b.gap);
  }

  /** Walking gap from a station's platforms / stops to a rectangle. */
  private gapToArea(st: Station, rect: Rect): number {
    let d = Infinity;
    if (st.rail) d = rectGap(this.platformRect(st)!, rect);
    for (const p of st.stops) d = Math.min(d, distToRect(p.x, p.z, rect.x, rect.z, rect.angle, rect.w / 2, rect.d / 2));
    return d;
  }

  /** The platform area of a rail station. */
  platformRect(st: Station): Rect | null {
    const r = st.rail;
    return r ? { x: r.x, z: r.z, angle: r.angle, w: railWidth(r), d: r.length } : null;
  }

  /**
   * Access street from a station forecourt to a nearby road: not through the station, and clear of the lead
   * corridors beyond both platform ends (where the line and its throat go).
   */
  private planAccessStreet(fx: number, fz: number, plan: StationPlan, owner: number): Proposal | null {
    const g = this.game, net = g.world.net;
    const ax = Math.sin(plan.angle), az = Math.cos(plan.angle);
    const LEAD = 26, half = plan.layout.width / 2 + 1.2;
    const keepOut: Rect[] = [plan.footprint, plan.building,
      { x: plan.x + ax * (plan.length / 2 + LEAD / 2), z: plan.z + az * (plan.length / 2 + LEAD / 2), angle: plan.angle, w: half * 2, d: LEAD },
      { x: plan.x - ax * (plan.length / 2 + LEAD / 2), z: plan.z - az * (plan.length / 2 + LEAD / 2), angle: plan.angle, w: half * 2, d: LEAD }];
    const blocked = (x: number, z: number, m: number) => keepOut.some((r) => distToRect(x, z, r.x, r.z, r.angle, r.w / 2, r.d / 2) < m);
    // candidate road points: along every road near the forecourt, nearest first, outside the keep-out areas
    const cands: { e: NEdge; s: number; d: number }[] = [];
    const p = { x: 0, y: 0, z: 0 };
    for (const e of net.edgesNear(fx - ACCESS_REACH, fz - ACCESS_REACH, fx + ACCESS_REACH, fz + ACCESS_REACH)) {
      if (e.kind !== 'road' || e.depot >= 0) continue;
      let best: { s: number; d: number } | null = null;
      for (let s = 0; s <= e.len; s += Math.min(2, Math.max(0.5, e.len / 4))) {
        net.pointAt(e, s, p);
        const d = Math.hypot(p.x - fx, p.z - fz);
        if (d > ACCESS_REACH || blocked(p.x, p.z, 0.6) || net.sectionAt(e, s) !== 'ground') continue;
        if (!best || d < best.d) best = { s, d };
      }
      if (best) cands.push({ e, ...best });
    }
    cands.sort((a, b) => a.d - b.d);
    for (const c of cands.slice(0, 6)) {
      let end: Snap;
      if (c.s < 0.8 || c.s > c.e.len - 0.8) { const n = net.nodes.get(c.s < 0.8 ? c.e.a : c.e.b)!; end = { kind: 'node', x: n.x, z: n.z, y: n.y, node: n.id }; }
      else { net.pointAt(c.e, c.s, p); end = { kind: 'edge', x: p.x, z: p.z, y: p.y, edge: c.e.id, s: c.s }; }
      const start: Snap = { kind: 'free', x: fx, z: fz, y: g.world.heightAt(fx, fz) };
      const prop = planEdge(g, start, end, { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner });
      if (!prop.ok) continue;
      const tp = prop.tracks[0];
      let hit = false;
      for (let i = 1; i <= 24 && !hit; i++) {
        bezPoint(tp.bez, i / 24, p);
        if (Math.hypot(p.x - fx, p.z - fz) > 0.7 && blocked(p.x, p.z, 0.45)) hit = true;
      }
      if (!hit) return prop;
    }
    return null;
  }

  /** Viaduct columns under an elevated deck, rows every ~6 units, shifted to miss roads and tracks below. */
  private viaductPiers(fp: Rect, width: number, demolish: Set<number>, ignore?: number): { piers: { x: number; z: number }[]; error?: string } {
    const w = this.game.world, net = w.net;
    const fx = Math.sin(fp.angle), fz = Math.cos(fp.angle), rx = fz, rz = -fx;
    const L = fp.d, rows = Math.max(2, Math.ceil((L - 0.8) / 6) + 1);
    const lats = width >= 1.3 ? [-(width / 2 - 0.35), width / 2 - 0.35] : [0];
    const piers: { x: number; z: number }[] = [];
    const clear = (px: number, pz: number) => {
      for (const e of net.edgesNear(px - 1.5, pz - 1.5, px + 1.5, pz + 1.5)) {
        if (ignore !== undefined && e.station === ignore) continue;
        const geo = net.geo(e), hw = net.halfWidth(e);
        for (let i = 0; i < geo.n; i++) if (Math.hypot(geo.pts[i * 3] - px, geo.pts[i * 3 + 2] - pz) < hw + 0.3) return false;
      }
      return true;
    };
    for (let k = 0; k < rows; k++) {
      const a0 = -L / 2 + 0.4 + ((L - 0.8) * k) / (rows - 1);
      let placed = false;
      for (const sh of [0, 0.5, -0.5, 1, -1, 1.5, -1.5, 2, -2]) {
        const a = Math.max(-L / 2 + 0.3, Math.min(L / 2 - 0.3, a0 + sh));
        const cols = lats.map((l) => ({ x: fp.x + fx * a + rx * l, z: fp.z + fz * a + rz * l }));
        if (!cols.every((c) => clear(c.x, c.z))) continue;
        for (const c of cols) {
          piers.push(c);
          for (const b of w.buildingsNear(c.x, c.z, 1)) if (distToRect(c.x, c.z, b.x, b.z, b.angle, b.w / 2 + 0.25, b.d / 2 + 0.25) <= 0) demolish.add(b.id);
        }
        placed = true;
        break;
      }
      if (!placed && (k === 0 || k === rows - 1)) return { piers, error: 'No room for the viaduct piers (roads or tracks beneath)' };
    }
    return { piers };
  }

  /** Is (x, z) within `r` of a road that belongs to a real road network (not just an isolated stub)? */
  private roadContact(x: number, z: number, r: number): boolean {
    const net = this.game.world.net;
    const ne = net.nearestEdge(x, z, r, 'road', (e) => e.depot < 0);
    if (!ne) return false;
    // connected: at least ~20 units of road reachable from it
    const seen = new Set<number>([ne.edge.id]);
    const queue = [ne.edge];
    let len = 0;
    while (queue.length && seen.size < 48) {
      const e = queue.pop()!;
      len += e.len;
      if (len >= 20) return true;
      for (const nid of [e.a, e.b]) for (const id of net.nodes.get(nid)?.edges ?? []) {
        if (seen.has(id)) continue;
        const f = net.edges.get(id);
        if (f && f.kind === 'road' && f.depot < 0) { seen.add(id); queue.push(f); }
      }
    }
    return len >= 20;
  }

  /**
   * Entrance sites for an underground / elevated station: beside roads (on the sidewalk, facing the street)
   * near the platform ends, else on free land beside the platform ends (without road access).
   */
  private entranceSites(level: 'underground' | 'elevated', fp: Rect, want: number, taken: Entrance[], ignore?: number, reach?: number): (Entrance & { access: boolean; demolish: number[] })[] {
    const w = this.game.world, net = w.net;
    const sz = ENTRANCE_SIZE[level];
    const maxD = reach ?? (level === 'elevated' ? 6 : 12);
    const fx = Math.sin(fp.angle), fz = Math.cos(fp.angle), rx = fz, rz = -fx;
    const R = fp.d / 2 + maxD + 4;
    type Cand = Entrance & { access: boolean; demolish: number[]; gap: number };
    const cands: Cand[] = [];
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    for (const e of net.edgesNear(fp.x - R, fp.z - R, fp.x + R, fp.z + R)) {
      if (e.kind !== 'road' || e.depot >= 0) continue;
      const hw = net.halfWidth(e), ra = net.junctionRadius(e.a) + 0.5, rb = net.junctionRadius(e.b) + 0.5;
      for (let s = ra; s <= e.len - rb; s += 0.8) {
        if (net.sectionAt(e, s) !== 'ground') continue;
        net.pointAt(e, s, p, d);
        const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
        for (const side of [1, -1]) {
          const off = hw + sz.d / 2 + 0.06;
          const cx = p.x + nx * off * side, cz = p.z + nz * off * side;
          const gap = distToRect(cx, cz, fp.x, fp.z, fp.angle, fp.w / 2, fp.d / 2) - sz.d / 2;
          if (gap > maxD) continue;
          const ang = angleOf(-nx * side, -nz * side);
          const dem = this.entranceFree(level, cx, cz, ang, fp, e.id, ignore);
          if (!dem) continue;
          cands.push({ x: cx, z: cz, angle: ang, access: true, demolish: dem, gap });
        }
      }
    }
    const targets = [
      { x: fp.x + fx * fp.d / 2, z: fp.z + fz * fp.d / 2 }, { x: fp.x - fx * fp.d / 2, z: fp.z - fz * fp.d / 2 },
      { x: fp.x + rx * (fp.w / 2 + 2), z: fp.z + rz * (fp.w / 2 + 2) }, { x: fp.x - rx * (fp.w / 2 + 2), z: fp.z - rz * (fp.w / 2 + 2) },
    ].slice(0, Math.max(2, want));
    const chosen: (Entrance & { access: boolean; demolish: number[] })[] = [];
    const farFrom = (c: Entrance) => [...taken, ...chosen].every((q) => Math.hypot(q.x - c.x, q.z - c.z) >= 4);
    for (const t of targets) {
      let best: Cand | null = null, bs = Infinity;
      for (const c of cands) {
        if (!farFrom(c)) continue;
        const score = Math.hypot(c.x - t.x, c.z - t.z) + c.gap * 1.5 + c.demolish.length * 25;
        if (score < bs) { bs = score; best = c; }
      }
      if (best) chosen.push({ x: best.x, z: best.z, angle: best.angle, access: true, demolish: best.demolish });
    }
    if (!chosen.length) {
      // no street within reach: entrances on free land beside the platform ends (no road access yet)
      for (const t of targets.slice(0, 2)) for (const side of [1, -1]) {
        if (chosen.some((c) => Math.hypot(c.x - t.x, c.z - t.z) < fp.w + 3)) break;
        const off = fp.w / 2 + sz.d / 2 + 0.5;
        const cx = t.x + rx * off * side, cz = t.z + rz * off * side;
        const ang = angleOf(rx * side, rz * side);
        const dem = this.entranceFree(level, cx, cz, ang, fp, -1, ignore);
        if (dem && !dem.length && farFrom({ x: cx, z: cz, angle: ang })) chosen.push({ x: cx, z: cz, angle: ang, access: false, demolish: [] });
      }
    }
    return chosen;
  }

  /** Can an entrance stand at (x, z)? Returns the buildings it replaces (small houses only) or null. */
  private entranceFree(level: 'underground' | 'elevated', x: number, z: number, angle: number, fp: Rect, road: number, ignore?: number): number[] | null {
    const w = this.game.world;
    const sz = ENTRANCE_SIZE[level];
    const rect: Rect = { x, z, angle, w: sz.w, d: sz.d };
    if (!w.inside(x, z, 3)) return null;
    const fxa = Math.sin(angle), fza = Math.cos(angle), rxa = fza, rza = -fxa;
    let mn = Infinity, mx = -Infinity;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [0, 0]]) {
      const h = w.heightAt(x + rxa * sz.w * a + fxa * sz.d * b, z + rza * sz.w * a + fza * sz.d * b);
      mn = Math.min(mn, h); mx = Math.max(mx, h);
    }
    if (mn < WATER_Y + 0.15 || mx - mn > 0.6) return null;
    if (level === 'elevated' && rectsOverlap(rect, fp, 0.05)) return null;
    const dem = new Set<number>();
    const err = this.rectConflict(rect, mn - 0.2, mx + 0.8, dem, { skipRoad: road, ignoreStation: ignore });
    if (err) return null;
    for (const id of dem) if ((w.buildings.get(id)?.pop ?? 0) > 30) return null;
    return [...dem];
  }

  /** Build a planned rail station (a new station, or the rail part of a joined stop station). */
  commitRail(plan: StationPlan, owner: number): string | null {
    const g = this.game;
    if (!plan.ok) return plan.error ?? 'Cannot build';
    const co = g.company(owner);
    if (!co.economy.canAfford(plan.cost)) return 'Not enough money';
    const accessCost = plan.access ? plan.access.cost : 0;
    co.economy.spend(plan.cost - accessCost, 'construction');
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const join = plan.join && this.map.get(plan.join.id) === plan.join ? plan.join : null;
    const st = join ?? this.create(plan.x, plan.z, owner);
    this.buildRailPart(st, plan, owner);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    for (const o of plan.links) if (this.map.get(o.id) === o && !this.canLink(st.id, o.id)) this.addLink(st, o);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  /** Lay the platform edges of a plan for station `st` and shape the site. */
  private buildRailPart(st: Station, plan: StationPlan, owner: number, reuse?: Map<string, number>) {
    const g = this.game, w = g.world, net = w.net;
    const fx = Math.sin(plan.angle), fz = Math.cos(plan.angle), rx = fz, rz = -fx;
    const L = plan.length;
    const edges: NEdge[] = [], through: NEdge[] = [];
    const sec: Section[] = plan.level === 'underground' ? [{ s0: 0, s1: L, type: 'tunnel' }] : plan.level === 'elevated' ? [{ s0: 0, s1: L, type: 'bridge' }] : [];
    // platform tracks (station edges), then through tracks (ordinary edges); reused end nodes by '<i>:f|b' / 'T<i>:f|b'
    const lay = (off: number, key: string, station: number) => {
      const cx = plan.x + rx * off, cz = plan.z + rz * off;
      const ax = cx - fx * L / 2, az = cz - fz * L / 2, bx = cx + fx * L / 2, bz = cz + fz * L / 2;
      const ra = reuse?.get(key + ':b'), rb = reuse?.get(key + ':f');
      const na = ra !== undefined && net.nodes.get(ra) ? net.nodes.get(ra)! : net.addNode('rail', ax, plan.y, az, fx, fz, owner);
      const nb = rb !== undefined && net.nodes.get(rb) ? net.nodes.get(rb)! : net.addNode('rail', bx, plan.y, bz, fx, fz, owner);
      const len = Math.hypot(nb.x - na.x, nb.z - na.z);
      const m = Math.max(2, Math.ceil(len) + 1);
      const prof = new Float32Array(m).fill(plan.y);
      prof[0] = na.y; prof[m - 1] = nb.y;
      return net.addEdge('rail', na.id, nb.id, bezLine(na.x, na.z, nb.x, nb.z), prof, sec.map((s) => ({ ...s, s1: len })), 'standard', owner, { station });
    };
    plan.layout.trackOffsets.forEach((off, i) => edges.push(lay(off, String(i), st.id)));
    plan.layout.throughOffsets.forEach((off, i) => through.push(lay(off, 'T' + i, -1)));
    const level = plan.level;
    st.rail = {
      x: plan.x, z: plan.z, y: plan.y, angle: plan.angle, length: L, tracks: plan.tracks,
      trackOffsets: plan.layout.trackOffsets, platforms: plan.layout.platforms, edges: edges.map((e) => e.id),
      through: plan.layout.throughOffsets.length, throughOffsets: plan.layout.throughOffsets, throughEdges: through.map((e) => e.id), width: plan.layout.width, throughMode: plan.throughMode,
      building: plan.building,
      level, underground: level === 'underground', depth: plan.depth, height: plan.height,
      entrances: plan.entrances.map((e) => ({ x: e.x, z: e.z, angle: e.angle })), piers: plan.piers.map((p) => ({ ...p })),
      forecourt: plan.forecourt ?? undefined, cost: plan.cost,
    };
    st.x = plan.x; st.z = plan.z;
    if (level === 'ground') {
      this.levelGround(plan);
      applyEarthworks(w, [...edges, ...through]);
      for (const f of this.footprints(st)) w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.5);
    } else {
      // street level: pads under the entrances (and piers); trees under an elevated deck are cleared
      for (const f of this.footprints(st)) {
        if (f.part === 'deck') { w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.3); continue; }
        if (f.part === 'entrance') this.padGround(f);
        w.removeTreesNear(f.x, f.z, Math.hypot(f.w, f.d) / 2 + 0.4);
      }
    }
    w.markObjArea(plan.x - L - 30, plan.z - L - 30, plan.x + L + 30, plan.z + L + 30);
    this.markStation(st);
  }

  /** Flatten the ground under a small street-level structure. */
  private padGround(f: Rect) {
    const w = this.game.world;
    let sum = 0, n = 0;
    for (const [a, b] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      const fx = Math.sin(f.angle), fz = Math.cos(f.angle);
      sum += w.heightAt(f.x + fz * f.w * a + fx * f.d * b, f.z - fx * f.w * a + fz * f.d * b); n++;
    }
    const target = sum / n;
    const R = Math.hypot(f.w, f.d) / 2 + 1;
    for (let z = Math.floor(f.z - R); z <= Math.ceil(f.z + R); z++) for (let x = Math.floor(f.x - R); x <= Math.ceil(f.x + R); x++) {
      if (x < 1 || z < 1 || x >= w.size || z >= w.size) continue;
      const k = w.vi(x, z);
      if (w.lock[k]) continue;
      const d = distToRect(x, z, f.x, f.z, f.angle, f.w / 2 + 0.2, f.d / 2 + 0.2);
      const wgt = d <= 0 ? 1 : Math.max(0, 1 - d / 1.2);
      if (wgt > 0) w.setVertex(x, z, w.h[k] + (target - w.h[k]) * wgt);
    }
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
    if (st.rail) for (const eid of [...st.rail.edges, ...st.rail.throughEdges]) if (g.vehicles.isEdgeBusy(eid)) return 'Train in the station';
    if (st.rail) for (const eid of [...st.rail.edges, ...st.rail.throughEdges]) g.world.net.removeEdge(eid);
    this.markStation(st);
    st.rail = null;
    this.deleteStation(id);
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  // ---------------------------------------------------------------- entrances and road access
  /**
   * Plan an extra entrance for an underground / elevated station near (x, z): beside a road (snapped to its
   * sidewalk, facing the street), within ENTRANCE_REACH of the platforms. Returns the site and cost, or the reason.
   */
  planEntrance(stationId: number, x: number, z: number, owner: number): { ok: boolean; error?: string; entrance?: Entrance; cost: number } {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId);
    const r = st?.rail;
    if (!st || !r) return { ok: false, error: 'No such rail station', cost: 0 };
    if (st.owner !== owner) return { ok: false, error: 'Not your station', cost: 0 };
    const lv = r.level ?? 'ground';
    if (lv === 'ground') return { ok: false, error: 'Ground stations are entered through their building', cost: 0 };
    const sz = ENTRANCE_SIZE[lv];
    const ne = net.nearestEdge(x, z, 3, 'road', (e) => e.depot < 0);
    if (!ne) return { ok: false, error: 'Entrances go beside a road', cost: 0 };
    const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
    net.pointAt(ne.edge, ne.s, p, d);
    const l = Math.hypot(d.x, d.z) || 1, nx = -d.z / l, nz = d.x / l;
    const side = (x - p.x) * nx + (z - p.z) * nz >= 0 ? 1 : -1;
    const off = net.halfWidth(ne.edge) + sz.d / 2 + 0.06;
    const ex = p.x + nx * off * side, ez = p.z + nz * off * side, ang = angleOf(-nx * side, -nz * side);
    const fp = this.platformRect(st)!;
    if (distToRect(ex, ez, fp.x, fp.z, fp.angle, fp.w / 2, fp.d / 2) > ENTRANCE_REACH) return { ok: false, error: `Too far from the platforms (max ${ENTRANCE_REACH * 10} m)`, cost: 0 };
    if (r.entrances.some((q) => Math.hypot(q.x - ex, q.z - ez) < 3)) return { ok: false, error: 'Another entrance is too close', cost: 0 };
    const dem = this.entranceFree(lv, ex, ez, ang, fp, ne.edge.id, st.id);
    if (!dem || dem.length) return { ok: false, error: 'Something is in the way', cost: 0 };
    return { ok: true, entrance: { x: ex, z: ez, angle: ang }, cost: ENTRANCE_COST[lv] };
  }

  /** Add an entrance to an underground / elevated station (see planEntrance). Null = OK, else the reason. */
  addEntrance(stationId: number, x: number, z: number, owner: number): string | null {
    const g = this.game;
    const pl = this.planEntrance(stationId, x, z, owner);
    if (!pl.ok || !pl.entrance) return pl.error ?? 'Cannot build here';
    if (!g.company(owner).economy.spend(pl.cost, 'construction')) return 'Not enough money';
    const st = this.map.get(stationId)!;
    st.rail!.entrances.push(pl.entrance);
    const lv = st.rail!.level as 'underground' | 'elevated', sz = ENTRANCE_SIZE[lv];
    this.padGround({ x: pl.entrance.x, z: pl.entrance.z, angle: pl.entrance.angle, w: sz.w, d: sz.d });
    g.world.removeTreesNear(pl.entrance.x, pl.entrance.z, 1.2);
    g.world.markObjArea(pl.entrance.x - 3, pl.entrance.z - 3, pl.entrance.x + 3, pl.entrance.z + 3);
    this.accessVersion = -1;
    this.game.lines.catchmentDirty = true;
    return null;
  }

  /** Remove an entrance (a station keeps at least one). */
  removeEntrance(stationId: number, index: number, owner: number): string | null {
    const st = this.map.get(stationId);
    const r = st?.rail;
    if (!st || !r || !r.entrances[index]) return 'No such entrance';
    if (st.owner !== owner) return 'Not your station';
    if (r.entrances.length <= 1) return 'A station needs at least one entrance';
    const [e] = r.entrances.splice(index, 1);
    if (index === 0 && r.entrances[0]) { const lv = r.level as 'underground' | 'elevated', sz = ENTRANCE_SIZE[lv]; r.building = { x: r.entrances[0].x, z: r.entrances[0].z, angle: r.entrances[0].angle, w: sz.w, d: sz.d }; }
    this.game.world.markObjArea(e.x - 3, e.z - 3, e.x + 3, e.z + 3);
    this.accessVersion = -1;
    this.game.lines.catchmentDirty = true;
    return null;
  }

  /** Does an entrance touch a road (street side)? */
  entranceAccess(st: Station, e: Entrance): boolean {
    const lv = st.rail?.level ?? 'ground';
    if (lv === 'ground') return false;
    return this.roadContact(e.x, e.z, ENTRANCE_SIZE[lv].d / 2 + 0.9);
  }

  /** The street side of a ground station's building (where the access road ends). */
  forecourt(st: Station): { x: number; z: number } | null {
    const r = st.rail;
    if (!r || (r.level ?? 'ground') !== 'ground') return null;
    if (r.forecourt) return r.forecourt;
    const b = r.building, fx = Math.sin(b.angle), fz = Math.cos(b.angle);
    return { x: b.x - fx * (b.d / 2 + FORECOURT), z: b.z - fz * (b.d / 2 + FORECOURT) };
  }

  /** Can passengers reach the rail part (road at the forecourt / an entrance on a street, or a stop of the station)? */
  private railReachable(st: Station): boolean {
    const r = st.rail;
    if (!r) return false;
    if (st.stops.length) return true;
    if ((r.level ?? 'ground') === 'ground') { const f = this.forecourt(st); return !!f && this.roadContact(f.x, f.z, 0.9); }
    return r.entrances.some((e) => this.entranceAccess(st, e));
  }

  /** Recompute the stations' road access after the network changed (cheap when nothing changed). */
  refreshAccess(force = false) {
    const v = this.game.world.net.version;
    if (!force && v === this.accessVersion) return;
    this.accessVersion = v;
    let changed = false;
    for (const st of this.map.values()) {
      const a = !st.rail || this.railReachable(st);
      if (a !== st.roadAccess) { st.roadAccess = a; changed = true; }
    }
    if (changed) this.game.lines.catchmentDirty = true;
  }

  /** Does the station take part in passenger traffic? (a rail station needs road access, see Station.roadAccess) */
  hasAccess(st: Station): boolean {
    this.refreshAccess();
    return st.roadAccess;
  }

  // ---------------------------------------------------------------- bus stops
  planBusStop(x: number, z: number, owner: number): BusStopPlan {
    const g = this.game;
    const net = g.world.net;
    const none = (error: string): BusStopPlan => ({ ok: false, error, cost: 0, join: null, links: [], mode: 'bus' });
    const ne = net.nearestEdge(x, z, 1.4, 'road', (e) => e.depot < 0);
    if (!ne) return none('Click on a road');
    const e = ne.edge;
    const ra = net.junctionRadius(e.a) + 0.9, rb = net.junctionRadius(e.b) + 0.9;
    if (ne.s < ra || ne.s > e.len - rb) return none('Too close to a junction');
    if (net.sectionAt(e, ne.s) !== 'ground') return none('Cannot build on a bridge or in a tunnel');
    for (const st of this.map.values()) for (const p of st.stops) if (p.edge === e.id && Math.abs(p.s - ne.s) < 1.6) return none('Another stop is too close');
    const p = { x: 0, y: 0, z: 0 };
    net.pointAt(e, ne.s, p);
    // an own rail station within walking range takes the stop, else a stop-only station across the street
    let join: Station | null = null;
    const links: Station[] = [];
    const pt: Rect = { x: p.x, z: p.z, angle: 0, w: 0, d: 0 };
    const near = this.nearOwn(owner, (o) => this.gapToArea(o, pt));
    // within 80 m of an own rail station's platforms / building / entrances: the stop becomes part of it
    for (const c of near) if (c.st.rail && [this.platformRect(c.st)!, ...this.footprints(c.st)].some((f) => distToRect(p.x, p.z, f.x, f.z, f.angle, f.w / 2, f.d / 2) < STOP_JOIN)) { join = c.st; break; }
    if (!join) for (const c of near) if (!c.st.rail && c.st.stops.some((q) => Math.hypot(q.x - p.x, q.z - p.z) < 3)) { join = c.st; break; }
    for (const c of near) if (c.st !== join && c.gap <= TRANSFER_RANGE) links.push(c.st);
    return { ok: true, edge: e, s: ne.s, px: p.x, pz: p.z, cost: 30000, join, links, mode: e.tram ? 'tram' : 'bus' };
  }

  commitBusStop(x: number, z: number, owner: number): string | null {
    const g = this.game;
    const p = this.planBusStop(x, z, owner);
    if (!p.ok) return p.error!;
    if (!g.company(owner).economy.spend(p.cost, 'construction')) return 'Not enough money';
    const st = p.join ?? this.create(p.px!, p.pz!, owner);
    st.stops.push({ edge: p.edge!.id, s: p.s!, x: p.px!, z: p.pz! });
    if (!st.rail) { st.x = st.stops.reduce((a, q) => a + q.x, 0) / st.stops.length; st.z = st.stops.reduce((a, q) => a + q.z, 0) / st.stops.length; }
    for (const o of p.links) if (o !== st && this.map.get(o.id) === o && !this.canLink(st.id, o.id)) this.addLink(st, o);
    g.world.net.markEdge(p.edge!);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  /** Stops of a station on tram tracks that `user` may use: trams of a tram line stop there. */
  tramStops(st: Station, user: number): BusStop[] {
    const net = this.game.world.net;
    return st.stops.filter((p) => { const e = net.edges.get(p.edge); return !!e && !!e.tram && this.game.canUse(user, e.tramOwner ?? -1); });
  }

  removeStop(st: Station, idx: number) {
    const stop = st.stops[idx];
    if (!stop) return;
    st.stops.splice(idx, 1);
    const e = this.game.world.net.edges.get(stop.edge);
    if (e) this.game.world.net.markEdge(e);
    if (!st.stops.length && !st.rail) this.deleteStation(st.id);
    this.accessVersion = -1;
    this.game.lines.rebuild();
  }

  // ---------------------------------------------------------------- transfer complexes
  /** Walking distance between the platform areas / stops of two stations (0 when they overlap). */
  gap(a: Station, b: Station): number {
    let d = Infinity;
    const ra = this.platformRect(a), rb = this.platformRect(b);
    if (ra && rb) d = rectGap(ra, rb);
    for (const p of a.stops) {
      if (rb) d = Math.min(d, distToRect(p.x, p.z, rb.x, rb.z, rb.angle, rb.w / 2, rb.d / 2));
      for (const q of b.stops) d = Math.min(d, Math.hypot(p.x - q.x, p.z - q.z));
    }
    if (ra) for (const q of b.stops) d = Math.min(d, distToRect(q.x, q.z, ra.x, ra.z, ra.angle, ra.w / 2, ra.d / 2));
    return d;
  }

  /** Can `from` be merged into `into` (one station: stops, platforms, passengers and line stops move)? Null if yes, else the reason. */
  canMerge(intoId: number, fromId: number): string | null {
    const a = this.map.get(intoId), b = this.map.get(fromId);
    if (!a || !b) return 'No such station';
    if (a === b) return 'The same station';
    if (a.owner !== b.owner) return 'Only stations of the same company can be merged';
    if (a.rail && b.rail) return 'Two rail stations cannot be merged: link them for transfers instead';
    const d = this.gap(a, b);
    if (d > TRANSFER_RANGE) return `Too far apart (${Math.round(d * 10)} m, at most ${TRANSFER_RANGE * 10} m)`;
    // a line stopping at both would be left with a single stop
    for (const l of this.game.lines.map.values()) {
      if (!l.stops.includes(a.id) || !l.stops.includes(b.id)) continue;
      if (new Set(l.stops.map((s) => (s === b.id ? a.id : s))).size < 2) return `${l.name} would be left with one stop`;
    }
    return null;
  }

  /** Can two stations be linked for walking transfers? Null if yes, else the reason. */
  canLink(aId: number, bId: number): string | null {
    const g = this.game;
    const a = this.map.get(aId), b = this.map.get(bId);
    if (!a || !b) return 'No such station';
    if (a === b) return 'The same station';
    if (a.links.includes(b.id)) return 'Already linked';
    if (a.owner !== b.owner && !g.canUse(a.owner, b.owner) && !g.canUse(b.owner, a.owner)) return 'Stations of another company (no track access agreement)';
    const d = this.gap(a, b);
    if (d > TRANSFER_RANGE) return `Too far apart for a walking transfer (${Math.round(d * 10)} m, at most ${TRANSFER_RANGE * 10} m)`;
    return null;
  }

  private addLink(a: Station, b: Station) {
    if (!a.links.includes(b.id)) a.links.push(b.id);
    if (!b.links.includes(a.id)) b.links.push(a.id);
  }

  /** Link two stations for walking transfers (both stay separate stations). Null = OK, else the reason. */
  link(aId: number, bId: number): string | null {
    const err = this.canLink(aId, bId);
    if (err) return err;
    this.addLink(this.map.get(aId)!, this.map.get(bId)!);
    this.game.lines.rebuild();
    return null;
  }

  /** End a walking link between two stations. */
  unlink(aId: number, bId: number) {
    const a = this.map.get(aId), b = this.map.get(bId);
    let n = 0;
    if (a && a.links.includes(bId)) { a.links = a.links.filter((x) => x !== bId); n++; }
    if (b && b.links.includes(aId)) { b.links = b.links.filter((x) => x !== aId); n++; }
    if (n) this.game.lines.rebuild();
  }

  /** All stations of a station's transfer complex (itself and everything linked to it, transitively). */
  complex(id: number): number[] {
    const out = [id], seen = new Set(out);
    for (let i = 0; i < out.length; i++) for (const o of this.map.get(out[i])?.links ?? []) if (!seen.has(o) && this.map.has(o)) { seen.add(o); out.push(o); }
    return out;
  }

  /** Nearby stations for the merge / link controls: walking gap, linked, and why a merge / link is not possible. */
  transferOptions(id: number): { id: number; name: string; gap: number; linked: boolean; merge: string | null; link: string | null }[] {
    const st = this.map.get(id);
    if (!st) return [];
    const out: { id: number; name: string; gap: number; linked: boolean; merge: string | null; link: string | null }[] = [];
    for (const o of this.map.values()) {
      if (o === st) continue;
      if (Math.hypot(o.x - st.x, o.z - st.z) > TRANSFER_RANGE * 2 + (st.rail?.length ?? 0) + (o.rail?.length ?? 0)) continue;
      const d = this.gap(st, o);
      if (d > TRANSFER_RANGE * 2) continue;
      out.push({ id: o.id, name: o.name, gap: d, linked: st.links.includes(o.id), merge: this.canMerge(st.id, o.id), link: st.links.includes(o.id) ? null : this.canLink(st.id, o.id) });
    }
    return out.sort((a, b) => a.gap - b.gap);
  }

  /** Walking transfer cost between linked stations (Lines.rebuild adds its transfer penalty). */
  walkCost(a: Station, b: Station): number { return WALK_BASE + WALK_PER_UNIT * this.gap(a, b); }

  /** Walking transfer edges of all transfer complexes (both directions), for the line graph. */
  walkLinks(): { from: number; to: number; cost: number }[] {
    const out: { from: number; to: number; cost: number }[] = [];
    for (const st of this.map.values()) for (const id of st.links) {
      const o = this.map.get(id);
      if (o && o !== st) out.push({ from: st.id, to: id, cost: this.walkCost(st, o) });
    }
    return out;
  }

  /**
   * Merge station `from` into `into`: its stops (and platforms, if only `from` has any), waiting passengers,
   * links and the stops of every line (of any company) move to `into`, which keeps its name. Null = OK.
   */
  merge(intoId: number, fromId: number): string | null {
    const err = this.canMerge(intoId, fromId);
    if (err) return err;
    const g = this.game, net = g.world.net;
    const a = this.map.get(intoId)!, b = this.map.get(fromId)!;
    if (b.rail) {
      a.rail = b.rail; b.rail = null;
      for (const eid of a.rail.edges) { const e = net.edges.get(eid); if (e) { e.station = a.id; net.markEdge(e); } }
      a.x = a.rail.x; a.z = a.rail.z;
    }
    a.stops.push(...b.stops);
    b.stops = [];
    if (!a.rail && a.stops.length) { a.x = a.stops.reduce((s, q) => s + q.x, 0) / a.stops.length; a.z = a.stops.reduce((s, q) => s + q.z, 0) / a.stops.length; }
    // statistics
    a.genMonth += b.genMonth; a.pickupMonth += b.pickupMonth; a.arrivedMonth += b.arrivedMonth;
    a.genLast += b.genLast; a.pickupLast += b.pickupLast; a.arrivedLast += b.arrivedLast;
    a.lastPickup = Math.max(a.lastPickup, b.lastPickup); a.lastSpeed = Math.max(a.lastSpeed, b.lastSpeed);
    a.rating = Math.max(a.rating, b.rating);
    // links
    for (const o of b.links) { const os = this.map.get(o); if (os) os.links = os.links.filter((x) => x !== b.id); if (os && os !== a) this.addLink(a, os); }
    b.links = [];
    a.links = a.links.filter((x) => x !== b.id);
    // passengers: waiting at `from`, and everywhere heading to / changing at `from`
    const re = (id: number) => (id === b.id ? a.id : id);
    const moved = [...b.waiting.values()];
    b.waiting.clear(); b.waitingTotal = 0;
    for (const st of this.map.values()) {
      if (st === b) continue;
      let hit = false;
      for (const w of st.waiting.values()) if (w.alight === b.id || w.dest === b.id) { hit = true; break; }
      if (!hit) continue;
      const old = [...st.waiting.values()];
      st.waiting.clear(); st.waitingTotal = 0;
      for (const w of old) if (re(w.dest) !== st.id) this.addWaiting(st, w.line, re(w.alight), re(w.dest), w.count);
    }
    for (const w of moved) if (re(w.dest) !== a.id) this.addWaiting(a, w.line, re(w.alight), re(w.dest), w.count);
    for (const v of g.vehicles.map.values()) {
      let hit = false;
      for (const c of v.cargo.values()) if (c.alight === b.id || c.dest === b.id || c.from === b.id) { hit = true; break; }
      if (hit) {
        const old = [...v.cargo.values()];
        v.cargo.clear();
        for (const c of old) {
          const n = { ...c, alight: re(c.alight), dest: re(c.dest), from: re(c.from) };
          const k = n.from + ':' + n.alight + ':' + n.dest;
          const o = v.cargo.get(k);
          if (o) { o.day = (o.day * o.count + n.day * n.count) / Math.max(1, o.count + n.count); o.count += n.count; } else v.cargo.set(k, n);
        }
      }
      const t = v as unknown as { routeTarget?: number; atStation?: number };
      if (t.routeTarget === b.id) t.routeTarget = a.id;
      if (t.atStation === b.id) t.atStation = a.id;
    }
    // line stops (any company's lines): `from` becomes `into`, repeated stops collapse
    for (const l of g.lines.map.values()) {
      if (!l.stops.includes(b.id)) continue;
      const map: number[] = [], out: number[] = [];
      for (const s0 of l.stops) {
        const s = re(s0);
        if (out.length && out[out.length - 1] === s) { map.push(out.length - 1); continue; }
        out.push(s); map.push(out.length - 1);
      }
      if (out.length > 1 && out[0] === out[out.length - 1]) { out.pop(); for (let i = 0; i < map.length; i++) if (map[i] >= out.length) map[i] = 0; }
      l.stops = out;
      for (const vid of l.vehicles) {
        const v = g.vehicles.get(vid);
        if (!v) continue;
        v.stopIndex = map[v.stopIndex] ?? 0;
        v.onLineChanged();
      }
    }
    this.map.delete(b.id);
    g.world.markObjArea(Math.min(a.x, b.x) - 20, Math.min(a.z, b.z) - 20, Math.max(a.x, b.x) + 20, Math.max(a.z, b.z) + 20);
    this.markStation(a);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  // ---------------------------------------------------------------- catchment & passengers
  /**
   * Catchment circles of a station: rail along the platforms (ground) or around the entrances (elevated /
   * underground), tram and bus stops around the stop. Only active ones (with road access) unless `all`.
   */
  catchmentShapes(st: Station, all = false): CatchShape[] {
    const out: CatchShape[] = [];
    const r = st.rail;
    if (r) {
      this.refreshAccess();
      const act = st.roadAccess;
      if ((r.level ?? 'ground') === 'ground') out.push(...railCatchShapes(r.x, r.z, r.angle, r.length, act));
      else for (const e of r.entrances) out.push({ x: e.x, z: e.z, r: CATCHMENT_RADIUS.rail, mode: 'rail', active: act });
    }
    const net = this.game.world.net;
    for (const p of st.stops) out.push(stopCatchShape(p.x, p.z, !!net.edges.get(p.edge)?.tram));
    return all ? out : out.filter((c) => c.active);
  }

  /** Catchment circles a planned rail station would have (inactive without road access). */
  planCatchShapes(plan: StationPlan): CatchShape[] {
    if (plan.level === 'ground') return railCatchShapes(plan.x, plan.z, plan.angle, plan.length, plan.roadAccess);
    return plan.entrances.map((e) => ({ x: e.x, z: e.z, r: CATCHMENT_RADIUS.rail, mode: 'rail' as const, active: plan.roadAccess }));
  }

  /** Largest catchment radius of a station (rail: from the centre over the platforms). */
  catchmentRadius(st: Station) { return st.rail ? CATCHMENT_RADIUS.rail + st.rail.length / 2 : st.stops.some((p) => this.game.world.net.edges.get(p.edge)?.tram) ? CATCHMENT_RADIUS.tram : CATCHMENT_RADIUS.bus; }

  /** Residents within a set of catchment circles (each building counted once). */
  popInShapes(shapes: { x: number; z: number; r: number }[]): number {
    const w = this.game.world;
    const seen = new Set<number>();
    let pop = 0;
    for (const c of shapes) for (const id of w.bgrid.query(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r)) {
      if (seen.has(id)) continue;
      const b = w.buildings.get(id);
      if (b && (b.x - c.x) ** 2 + (b.z - c.z) ** 2 <= c.r * c.r) { seen.add(id); pop += b.pop; }
    }
    return pop;
  }

  /** Buildings within the (active) catchment of a station. */
  catchmentBuildings(st: Station): number[] {
    const w = this.game.world;
    const out = new Set<number>();
    for (const c of this.catchmentShapes(st)) for (const id of w.bgrid.query(c.x - c.r, c.z - c.r, c.x + c.r, c.z + c.r)) {
      const b = w.buildings.get(id);
      if (b && Math.hypot(b.x - c.x, b.z - c.z) <= c.r) out.add(id);
    }
    return [...out];
  }

  /**
   * Catchment population of every station: each building's people are shared among the stations
   * covering it (served ones first), weighted by rating. Building-major over a coarse grid of the
   * catchment circles, which is much cheaper than querying the building grid per station.
   */
  recomputeCatchment() {
    const w = this.game.world;
    this.refreshAccess();
    const circles: { st: Station; x: number; z: number; r: number }[] = [];
    for (const st of this.map.values()) {
      st.catchPop = 0;
      for (const c of this.catchmentShapes(st)) circles.push({ st, x: c.x, z: c.z, r: c.r });
    }
    if (!circles.length) return;
    const C = 32, key = (cx: number, cz: number) => cx * 4096 + cz;
    const cells = new Map<number, number[]>();
    circles.forEach((c, i) => {
      for (let cz = Math.floor((c.z - c.r) / C); cz <= Math.floor((c.z + c.r) / C); cz++) for (let cx = Math.floor((c.x - c.r) / C); cx <= Math.floor((c.x + c.r) / C); cx++) {
        const k = key(cx, cz);
        const a = cells.get(k);
        if (a) a.push(i); else cells.set(k, [i]);
      }
    });
    const served = new Map<number, boolean>();
    const isServed = (s: Station) => { let v = served.get(s.id); if (v === undefined) { v = this.game.lines.stationServed(s.id); served.set(s.id, v); } return v; };
    const list: Station[] = [], act: Station[] = [];
    for (const b of w.buildings.values()) {
      if (b.pop <= 0) continue;
      const idx = cells.get(key(Math.floor(b.x / C), Math.floor(b.z / C)));
      if (!idx) continue;
      list.length = 0; act.length = 0;
      for (const i of idx) {
        const c = circles[i];
        if ((b.x - c.x) * (b.x - c.x) + (b.z - c.z) * (b.z - c.z) > c.r * c.r || list.includes(c.st)) continue;
        list.push(c.st);
        if (isServed(c.st)) act.push(c.st);
      }
      if (!list.length) continue;
      const use = act.length ? act : list;
      let sum = 0;
      for (const s of use) sum += s.rating + 0.05;
      for (const s of use) s.catchPop += (b.pop * (s.rating + 0.05)) / sum;
    }
  }

  /**
   * Passengers wait at `st` for `line` to `alight` on their way to `dest`. A walking hop (WALK_LINE) takes them
   * straight to the linked station `alight`, where they arrive or wait for their next leg.
   */
  addWaiting(st: Station, line: number, alight: number, dest: number, count: number, depth = 0) {
    if (count <= 0) return;
    if (line === WALK_LINE) { this.walkTo(alight, dest, count, depth); return; }
    const key = line + ':' + alight + ':' + dest;
    const g = st.waiting.get(key);
    if (g) g.count += count;
    else st.waiting.set(key, { line, alight, dest, count });
    st.waitingTotal += count;
  }

  /** Passengers walk to the linked station `toId`: they have arrived, or wait there for their next leg. */
  private walkTo(toId: number, dest: number, count: number, depth: number) {
    const g = this.game;
    const to = this.map.get(toId);
    if (!to || depth > 4) return;
    if (toId === dest) {
      to.arrivedMonth += count;
      const town = g.towns.list[to.townId];
      if (town) town.passTransMonth += count;
      return;
    }
    const hop = g.lines.nextHop(toId, dest);
    if (!hop) return;
    g.lines.distribute(hop, count, (l, n) => this.addWaiting(to, l, hop.alight, dest, n, depth + 1));
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

  // ---------------------------------------------------------------- rebuilding and relocating
  /**
   * Plan rebuilding a ground rail station with longer (or shorter) platforms and / or more tracks, keeping the
   * station (id, name, lines, waiting passengers). Existing tracks keep their positions (new ones are added on
   * the side with room); ends without approach tracks move first, connected ends extend over straight approach
   * track (which is shortened to meet the new platform ends). A level change rebuilds an unconnected station.
   */
  planUpgrade(stationId: number, o: UpgradeOpts): UpgradePlan {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId);
    const r = st?.rail;
    const bad = (error: string): UpgradePlan => ({ ok: false, error, warnings: [], station: stationId, cost: 0, length: r?.length ?? 0, tracks: r?.tracks ?? 0, through: r?.through ?? 0, plan: null, delta: [0, 0], keep: [], cuts: [], rebuild: false });
    if (!st || !r) return bad('No such rail station');
    const Th0 = r.through ?? 0;
    const L2 = Math.max(4, Math.min(60, o.length ?? r.length)), T2 = Math.max(r.tracks, Math.min(8, o.tracks ?? r.tracks)), Th2 = Math.max(Th0, Math.min(2, o.through ?? Th0));
    const level = o.level ?? r.level ?? 'ground';
    if ((o.tracks ?? r.tracks) < r.tracks) return bad('Tracks can be added, not removed');
    if ((o.through ?? Th0) < Th0) return bad('Through tracks can be added, not removed');
    // through tracks added to a station without any go outside its platforms (the platform tracks stay put)
    const mode: ThroughMode = Th0 ? r.throughMode ?? 'middle' : 'outer';
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    // every track (platform and through) with its end nodes and the approach edges there
    const ends: { node: number; approach: number[] }[][] = [];
    const kinds: boolean[] = [];
    for (const [eid, thr] of [...r.edges.map((e) => [e, false] as const), ...r.throughEdges.map((e) => [e, true] as const)]) {
      const e = net.edges.get(eid);
      if (!e) return bad('Station track missing');
      const na = net.nodes.get(e.a)!, nb = net.nodes.get(e.b)!;
      const fwd = (nb.x - na.x) * fx + (nb.z - na.z) * fz >= 0;
      const back = fwd ? na : nb, front = fwd ? nb : na;
      const appr = (n: typeof na) => n.edges.filter((id) => { const f = net.edges.get(id); return f && id !== eid && f.station !== st.id; });
      ends.push([{ node: front.id, approach: appr(front) }, { node: back.id, approach: appr(back) }]);
      kinds.push(thr);
    }
    if (ends.length !== r.tracks + Th0) return bad('A station track is split (signals on it?): rebuild not possible');
    const latOf = (nid: number) => { const n = net.nodes.get(nid)!; return (n.x - r.x) * rx + (n.z - r.z) * rz; };
    const order = ends.map((_, i) => i).sort((p, q) => latOf(ends[p][0].node) - latOf(ends[q][0].node));
    const connected = [ends.some((t) => t[0].approach.length > 0), ends.some((t) => t[1].approach.length > 0)];
    const rebuild = (lv: StationLevel) => {
      if (connected[0] || connected[1]) return bad(lv !== (r.level ?? 'ground') ? 'The level of a connected station cannot be changed' : 'The tracks of a connected station cannot be rearranged like that');
      const plan = this.planRail(r.x, r.z, r.angle, L2, T2, st.owner, { level: lv, height: o.height, depth: o.depth, ignoreStation: st.id, through: Th2, throughMode: mode });
      return { ok: plan.ok, error: plan.error, warnings: plan.warnings, station: st.id, cost: plan.cost + 20000, length: L2, tracks: T2, through: Th2, plan, delta: [0, 0] as [number, number], keep: [], cuts: [], rebuild: true };
    };
    if (level !== (r.level ?? 'ground')) return rebuild(level);
    if (level !== 'ground') return bad('Only ground stations can be extended in place');
    const dL = L2 - r.length;
    const splits: [number, number][] = dL === 0 ? [[0, 0]] : !connected[0] && !connected[1] ? [[dL / 2, dL / 2]] : !connected[0] ? [[dL, 0], [dL / 2, dL / 2]] : !connected[1] ? [[0, dL], [dL / 2, dL / 2]] : [[dL / 2, dL / 2], [dL, 0], [0, dL]];
    // lateral: the old tracks keep their offsets (and kinds) inside the new layout, new ones go beside them
    const lay2 = stationLayout(T2, Th2, mode);
    const newAll = [...lay2.trackOffsets.map((off, i) => ({ off, key: String(i), thr: false })), ...lay2.throughOffsets.map((off, i) => ({ off, key: 'T' + i, thr: true }))].sort((p, q) => p.off - q.off);
    const old = order.map((i) => ({ off: latOf(ends[i][0].node), thr: kinds[i] }));
    const shifts: { k: number; c: number; keys: string[] }[] = [];
    for (let k = 0; k + old.length <= newAll.length; k++) {
      const c = old[0].off - newAll[k].off;
      if (old.every((v, j) => Math.abs(newAll[k + j].off + c - v.off) < 0.03 && newAll[k + j].thr === v.thr)) shifts.push({ k, c, keys: newAll.slice(k, k + old.length).map((q) => q.key) });
    }
    if (!shifts.length) return rebuild(level);
    let firstErr = '';
    for (const [dF, dB] of splits) for (const sh of shifts) {
      const res = this.tryUpgrade(st, L2, T2, Th2, mode, dF, dB, sh, order, ends);
      if (res.ok) return res;
      if (!firstErr) firstErr = res.error ?? '';
    }
    return bad(firstErr || 'Cannot rebuild the station');
  }

  private tryUpgrade(st: Station, L2: number, T2: number, Th2: number, mode: ThroughMode, dF: number, dB: number, sh: { k: number; c: number; keys: string[] }, order: number[], ends: { node: number; approach: number[] }[][]): UpgradePlan {
    const g = this.game, net = g.world.net;
    const r = st.rail!;
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const along = (dF - dB) / 2;
    const cx = r.x + fx * along + rx * sh.c, cz = r.z + fz * along + rz * sh.c;
    const bad = (error: string): UpgradePlan => ({ ok: false, error, warnings: [], station: st.id, cost: 0, length: L2, tracks: T2, through: Th2, plan: null, delta: [dF, dB], keep: [], cuts: [], rebuild: false });
    // connected ends that move out: the approach must run straight and level on for the extension (no switch)
    const cuts: UpgradePlan['cuts'] = [];
    // track attached at the platform ends starts on the station's boundary (and is cut back where the ends move)
    const ignoreEdges = new Set<number>(ends.flatMap((t) => [...t[0].approach, ...t[1].approach]));
    for (const id of r.throughEdges) ignoreEdges.add(id);
    const p = { x: 0, y: 0, z: 0 };
    for (const [end, d] of [[0, dF], [1, dB]] as [0 | 1, number][]) {
      if (d < -1e-6 && ends.some((t) => t[end].approach.length)) return bad('Connected platform ends cannot be shortened');
      if (d <= 1e-6) continue;
      const dir = end === 0 ? 1 : -1;
      for (let j = 0; j < order.length; j++) {
        const t = ends[order[j]][end];
        if (!t.approach.length) continue;
        if (t.approach.length > 1) return bad('A switch sits right at the end of the platforms');
        let node = net.nodes.get(t.node)!, eid = t.approach[0], acc = 0;
        const remove: number[] = [];
        let cut: UpgradePlan['cuts'][number] | null = null;
        for (let guard = 0; guard < 24 && !cut; guard++) {
          const e = net.edges.get(eid);
          if (!e || e.kind !== 'rail' || e.station >= 0 || e.depot >= 0) return bad('No plain track beyond the platforms');
          const fromA = e.a === node.id;
          const need = Math.min(e.len, d - acc + 0.6);
          for (const sc of e.sections) { const s0 = fromA ? sc.s0 : e.len - sc.s1; if (s0 < need) return bad('A bridge or tunnel starts right after the platforms'); }
          for (let s = 0.5; s <= need + 1e-6; s += 0.5) {
            net.pointAt(e, fromA ? s : e.len - s, p);
            const lat = (p.x - node.x) * rx + (p.z - node.z) * rz, lon = ((p.x - node.x) * fx + (p.z - node.z) * fz) * dir;
            if (Math.abs(lat) > 0.04 || Math.abs(lon - s) > 0.06) return bad('The approach track curves away right after the platforms');
            if (Math.abs(p.y - r.y) > 0.08) return bad('The approach track climbs or falls right after the platforms');
          }
          const rest = d - acc;
          if (Math.abs(e.len - rest) < 0.3) { remove.push(e.id); cut = { end, rank: j, node: t.node, remove, edge: -1, s: 0, fromA, at: fromA ? e.b : e.a }; break; }
          if (e.len > rest) { cut = { end, rank: j, node: t.node, remove, edge: e.id, s: fromA ? rest : e.len - rest, fromA, at: -1 }; break; }
          remove.push(e.id);
          acc += e.len;
          const nn = net.nodes.get(fromA ? e.b : e.a)!;
          if (nn.edges.length !== 2) return bad('A switch is too close to the end of the platforms');
          node = nn;
          eid = nn.edges.find((x) => x !== e.id)!;
        }
        if (!cut) return bad('No plain track beyond the platforms');
        for (const id of cut.remove) ignoreEdges.add(id);
        if (cut.edge >= 0) ignoreEdges.add(cut.edge);
        cuts.push(cut);
      }
    }
    const plan = this.planRail(cx, cz, r.angle, L2, T2, st.owner, { ignoreStation: st.id, ignoreEdges, through: Th2, throughMode: mode, fixedY: r.y });
    if (!plan.ok) return bad(plan.error ?? 'Cannot build');
    plan.join = null;
    const extra = Math.max(0, (T2 + Th2 * 0.7) * L2 - (r.tracks + (r.through ?? 0) * 0.7) * r.length);
    let cost = extra * 9000 + 60000 + (plan.access?.cost ?? 0);
    for (const id of plan.demolish) cost += 6000 + (g.world.buildings.get(id)?.pop ?? 0) * 2500;
    const warnings = [...plan.warnings];
    if (T2 + Th2 > r.tracks + (r.through ?? 0) && ends.some((t) => t[0].approach.length || t[1].approach.length)) warnings.push('New tracks get turnouts onto the neighbouring track where there is room');
    return { ok: true, warnings, station: st.id, cost: Math.round(cost), length: L2, tracks: T2, through: Th2, plan, delta: [dF, dB], keep: sh.keys, cuts, rebuild: false };
  }

  /**
   * Rebuild a station as planned by planUpgrade. Fails with 'busy' when a train stands on its platforms or the
   * approach track being converted. Null = OK, else the reason.
   */
  commitUpgrade(up: UpgradePlan): string | null {
    const g = this.game, net = g.world.net;
    if (!up.ok) return up.error ?? 'Cannot rebuild';
    const st = this.map.get(up.station);
    const r = st?.rail;
    if (!st || !r) return 'No such rail station';
    if (!up.plan) return up.error ?? 'Cannot rebuild';
    if (up.rebuild) return this.relocate(st.id, up.plan, up.cost);
    // the network must still be as planned
    for (const c of up.cuts) {
      for (const id of c.remove) if (!net.edges.has(id)) return 'The track changed, plan again';
      if (c.edge >= 0) { const e = net.edges.get(c.edge); if (!e || c.s <= 0.05 || c.s >= e.len - 0.05) return 'The track changed, plan again'; }
      if (c.at >= 0 && !net.nodes.has(c.at)) return 'The track changed, plan again';
    }
    for (const eid of [...r.edges, ...r.throughEdges, ...up.cuts.flatMap((c) => [...c.remove, c.edge])]) if (eid >= 0 && g.vehicles.isEdgeBusy(eid)) return 'busy';
    const co = g.company(st.owner);
    if (!co.economy.canAfford(up.cost)) return 'Not enough money';
    co.economy.spend(up.cost - (up.plan.access?.cost ?? 0), 'construction');
    const plan = up.plan;
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    // the new track ends: kept connected end nodes, or nodes where the approach is cut
    const reuse = new Map<string, number>();
    const oldEnds = this.trackEnds(st, true);
    for (let j = 0; j < oldEnds.length; j++) {
      const t = oldEnds[j], key = up.keep[j];
      if (key === undefined) continue;
      const conn = (nid: number) => !!net.nodes.get(nid)?.edges.some((id) => id !== t.edge && net.edges.get(id)?.station !== st.id);
      if (Math.abs(up.delta[0]) < 1e-6 && conn(t.front)) reuse.set(key + ':f', t.front);
      if (Math.abs(up.delta[1]) < 1e-6 && conn(t.back)) reuse.set(key + ':b', t.back);
    }
    for (const c of up.cuts) {
      const rm = [...c.remove];
      let nodeId = c.at;
      if (c.edge >= 0) {
        const res = net.splitEdge(c.edge, c.s)!;
        nodeId = res.node.id;
        rm.push(c.fromA ? res.e1.id : res.e2.id);
      }
      reuse.set(up.keep[c.rank] + (c.end === 0 ? ':f' : ':b'), nodeId);
      for (const id of rm) net.removeEdge(id);
    }
    for (const eid of [...r.edges, ...r.throughEdges]) net.removeEdge(eid);
    this.markStation(st);
    st.rail = null;
    this.buildRailPart(st, { ...plan, cost: (r.cost ?? 0) + up.cost }, st.owner, reuse);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    // new tracks at connected ends: turnouts onto the neighbouring tracks' approaches
    connectStationThroat(g, st.id, st.owner);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }

  /**
   * Track end nodes of a rail station in lateral order (left to right): per track the front (+axis) and back node,
   * its edge, and whether it is a through track (only listed with `withThrough`).
   */
  trackEnds(st: Station, withThrough = false): { front: number; back: number; edge: number; through: boolean }[] {
    const net = this.game.world.net, r = st.rail;
    if (!r) return [];
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const out: { front: number; back: number; edge: number; through: boolean; lat: number }[] = [];
    const add = (eid: number, through: boolean) => {
      const e = net.edges.get(eid);
      if (!e) return;
      const a = net.nodes.get(e.a)!, b = net.nodes.get(e.b)!;
      const fw = (b.x - a.x) * fx + (b.z - a.z) * fz >= 0;
      out.push({ front: fw ? b.id : a.id, back: fw ? a.id : b.id, edge: eid, through, lat: ((a.x + b.x) / 2 - r.x) * rx + ((a.z + b.z) / 2 - r.z) * rz });
    };
    for (const eid of r.edges) add(eid, false);
    if (withThrough) for (const eid of r.throughEdges) add(eid, true);
    // a split track (e.g. a signal on a through track) is listed once, by its outermost pieces
    const merged: typeof out = [];
    for (const t of out.sort((p, q) => p.lat - q.lat)) {
      const m = merged.find((q) => Math.abs(q.lat - t.lat) < 0.05);
      if (!m) { merged.push({ ...t }); continue; }
      const along = (id: number) => { const n = net.nodes.get(id)!; return (n.x - r.x) * fx + (n.z - r.z) * fz; };
      if (along(t.front) > along(m.front)) m.front = t.front;
      if (along(t.back) < along(m.back)) m.back = t.back;
    }
    return merged.map(({ front, back, edge, through }) => ({ front, back, edge, through }));
  }

  /**
   * Move a station's rail part to a new site (a plan from planRail, e.g. with { ignoreStation }): the old platforms
   * are removed, the station keeps its id, name, lines and waiting passengers. Fails with 'busy' when a train stands
   * in the station. Null = OK, else the reason.
   */
  relocate(stationId: number, plan: StationPlan, cost?: number): string | null {
    const g = this.game, net = g.world.net;
    const st = this.map.get(stationId);
    if (!st || !st.rail) return 'No such rail station';
    if (!plan.ok) return plan.error ?? 'Cannot build';
    for (const eid of [...st.rail.edges, ...st.rail.throughEdges]) if (g.vehicles.isEdgeBusy(eid)) return 'busy';
    const total = cost ?? plan.cost + 20000;
    const co = g.company(st.owner);
    if (!co.economy.canAfford(total)) return 'Not enough money';
    co.economy.spend(total - (plan.access?.cost ?? 0), 'construction');
    for (const id of plan.demolish) g.towns.demolishBuilding(id);
    const old = st.rail;
    for (const eid of [...old.edges, ...old.throughEdges]) net.removeEdge(eid);
    this.markStation(st);
    st.rail = null;
    this.buildRailPart(st, plan, st.owner);
    if (plan.access && plan.access.ok) commitProposal(g, plan.access);
    for (const o of plan.links) if (o !== st && this.map.get(o.id) === o && !this.canLink(st.id, o.id)) this.addLink(st, o);
    this.accessVersion = -1;
    g.onNetworkChanged();
    g.lines.rebuild();
    return null;
  }
}

/** A station restored from a save: own copies of every array, defaults for fields older saves lack. */
export function restoreStation(s: any): Station {
  const r = s.rail;
  const lv: StationLevel = r ? (r.level ?? (r.underground ? 'underground' : 'ground')) : 'ground';
  return {
    ...s,
    rail: r ? {
      ...r, edges: [...r.edges], trackOffsets: [...(r.trackOffsets ?? [])], platforms: (r.platforms ?? []).map((p: any) => ({ ...p })), building: { ...r.building },
      through: r.through ?? 0, throughOffsets: [...(r.throughOffsets ?? [])], throughEdges: [...(r.throughEdges ?? [])], width: r.width ?? stationLayout(r.tracks, r.through ?? 0).width,
      level: lv, underground: lv === 'underground', depth: r.depth ?? 0, height: r.height ?? 0,
      entrances: (r.entrances ?? []).map((e: any) => ({ ...e })), piers: (r.piers ?? []).map((p: any) => ({ ...p })),
      forecourt: r.forecourt ? { ...r.forecourt } : undefined,
    } : null,
    stops: (s.stops ?? []).map((p: any) => ({ ...p })),
    links: [...(s.links ?? [])],
    roadAccess: s.roadAccess ?? true,
    waiting: new Map(),
  };
}

// ------------------------------------------------------------------ game-level wrappers (AI / UI)

/** Plan rebuilding a rail station with longer platforms / more tracks / another level (see Stations.planUpgrade). */
export function planStationUpgrade(g: Game, stationId: number, o: UpgradeOpts): UpgradePlan { return g.stations.planUpgrade(stationId, o); }
/** Rebuild a station as planned; 'busy' while a train stands in it. Null = OK, else the reason. */
export function commitStationUpgrade(g: Game, plan: UpgradePlan): string | null { return g.stations.commitUpgrade(plan); }
/** Move a station to a new site (plan from planRail with { ignoreStation: id } when it overlaps the old site). */
export function relocateStation(g: Game, stationId: number, plan: StationPlan): string | null { return g.stations.relocate(stationId, plan); }

export { ROAD_TYPES };
