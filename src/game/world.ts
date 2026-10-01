// The tile world: terrain heights, tracks, roads, buildings and structures.
import {
  HSTEP, DX, DZ, OPP, EDGE_CORNERS, CORNER_DX, CORNER_DZ, PIECE_EDGES, PIECE_COUNT,
} from './constants';

export const OBJ_CHUNK = 16;
export const TERRAIN_CHUNK = 32;

export type Transport = 'rail' | 'road';

export interface Structure {
  id: number;
  kind: 'bridge' | 'tunnel';
  transport: Transport;
  /** Head tile A and the direction from A towards B. */
  ax: number; az: number;
  bx: number; bz: number;
  dir: number;
  /** Deck / tunnel floor level. */
  h: number;
  /** Number of span tiles between the heads. */
  span: number;
}

export interface Building {
  id: number;
  townId: number;
  x: number; z: number;
  type: number;
  floors: number;
  pop: number;
  seed: number;
  /** Direction the facade faces (towards a road). */
  face: number;
  built: number; // day built
}

export interface Depot {
  id: number;
  kind: Transport;
  x: number; z: number;
  dir: number; // exit direction
}

/** Slope classification of a tile. */
export const SLOPE_FLAT = 0;
export const SLOPE_IRREGULAR = 5;
// 1..4 => incline rising towards direction (value-1)

export class World {
  readonly size: number;
  readonly hgt: Int16Array;        // (size+1)^2 corner levels
  readonly rail: Uint8Array;       // piece bitmask
  readonly road: Uint8Array;       // edge bitmask
  readonly roadOwner: Uint8Array;  // 0 none, 1 town, 2 player
  readonly building: Int32Array;   // building id or -1
  readonly station: Int32Array;    // station id or -1
  readonly stationKind: Uint8Array;// 0 none, 1 rail platform, 2 road stop
  readonly depot: Int32Array;      // depot id or -1
  readonly trees: Uint8Array;      // low nibble: count, high nibble: type
  readonly signal: Uint8Array;     // signals (see signals in rail.ts)
  readonly span: Int32Array;       // structure id spanning this tile (bridge over / tunnel under) or -1
  readonly townOf: Int16Array;     // owning town for town roads/buildings (-1)
  readonly tileVersion: Uint32Array;

  buildings: (Building | null)[] = [];
  freeBuildingIds: number[] = [];
  structures = new Map<number, Structure>();
  /** key = tileIndex*4 + edge  ->  structure id  (structure heads) */
  heads = new Map<number, number>();
  depots = new Map<number, Depot>();
  nextStructureId = 1;
  nextDepotId = 1;

  dirtyObj = new Set<number>();
  dirtyTerrain = new Set<number>();
  heightsVersion = 0;

  constructor(size: number) {
    this.size = size;
    const n = size * size;
    this.hgt = new Int16Array((size + 1) * (size + 1));
    this.rail = new Uint8Array(n);
    this.road = new Uint8Array(n);
    this.roadOwner = new Uint8Array(n);
    this.building = new Int32Array(n).fill(-1);
    this.station = new Int32Array(n).fill(-1);
    this.stationKind = new Uint8Array(n);
    this.depot = new Int32Array(n).fill(-1);
    this.trees = new Uint8Array(n);
    this.signal = new Uint8Array(n);
    this.span = new Int32Array(n).fill(-1);
    this.townOf = new Int16Array(n).fill(-1);
    this.tileVersion = new Uint32Array(n);
  }

  // ---------- indexing ----------
  idx(x: number, z: number): number { return z * this.size + x; }
  tx(t: number): number { return t % this.size; }
  tz(t: number): number { return (t / this.size) | 0; }
  inBounds(x: number, z: number): boolean { return x >= 0 && z >= 0 && x < this.size && z < this.size; }
  cidx(cx: number, cz: number): number { return cz * (this.size + 1) + cx; }

  // ---------- heights ----------
  cornerH(cx: number, cz: number): number { return this.hgt[cz * (this.size + 1) + cx]; }
  corner(x: number, z: number, c: number): number { return this.hgt[(z + CORNER_DZ[c]) * (this.size + 1) + x + CORNER_DX[c]]; }
  corners(x: number, z: number, out: number[] = [0, 0, 0, 0]): number[] {
    const s1 = this.size + 1;
    const i = z * s1 + x;
    out[0] = this.hgt[i]; out[1] = this.hgt[i + 1]; out[2] = this.hgt[i + s1 + 1]; out[3] = this.hgt[i + s1];
    return out;
  }
  tileMin(x: number, z: number): number { const c = this.corners(x, z, tmp4); return Math.min(c[0], c[1], c[2], c[3]); }
  tileMax(x: number, z: number): number { const c = this.corners(x, z, tmp4); return Math.max(c[0], c[1], c[2], c[3]); }
  isWater(x: number, z: number): boolean { return this.tileMax(x, z) <= 0; }
  isWaterT(t: number): boolean { return this.isWater(t % this.size, (t / this.size) | 0); }

  /** Level of an edge if both its corners are equal, else NaN. */
  edgeLevel(x: number, z: number, e: number): number {
    const [a, b] = EDGE_CORNERS[e];
    const ha = this.corner(x, z, a), hb = this.corner(x, z, b);
    return ha === hb ? ha : NaN;
  }

  static slopeOf(c: number[]): number {
    const mn = Math.min(c[0], c[1], c[2], c[3]);
    const mx = Math.max(c[0], c[1], c[2], c[3]);
    if (mn === mx) return SLOPE_FLAT;
    if (mx - mn !== 1) return SLOPE_IRREGULAR;
    for (let d = 0; d < 4; d++) {
      const [a, b] = EDGE_CORNERS[d];
      const [o1, o2] = EDGE_CORNERS[OPP[d]];
      if (c[a] === mx && c[b] === mx && c[o1] === mn && c[o2] === mn) return 1 + d;
    }
    return SLOPE_IRREGULAR;
  }
  slope(x: number, z: number): number { return World.slopeOf(this.corners(x, z, tmp4)); }

  /** Whether a tile shape supports transport using the given edge mask. */
  static shapeSupports(c: number[], edgeMask: number): boolean {
    const s = World.slopeOf(c);
    if (s === SLOPE_FLAT) return true;
    if (s === SLOPE_IRREGULAR) return edgeMask === 0;
    const d = s - 1;
    const allowed = (1 << d) | (1 << OPP[d]);
    return (edgeMask & ~allowed) === 0;
  }

  /** Triangle split: true => split along NE-SW diagonal, false => NW-SE. */
  static splitOf(c: number[]): boolean {
    return Math.abs(c[0] - c[2]) > Math.abs(c[1] - c[3]);
  }

  /** World-space terrain height at a world position (matches the rendered mesh). */
  heightAt(wx: number, wz: number): number {
    const s = this.size;
    if (wx < 0) wx = 0; if (wz < 0) wz = 0;
    if (wx > s - 1e-4) wx = s - 1e-4; if (wz > s - 1e-4) wz = s - 1e-4;
    const x = Math.floor(wx), z = Math.floor(wz);
    const fx = wx - x, fz = wz - z;
    const c = this.corners(x, z, tmp4);
    const h0 = c[0], h1 = c[1], h2 = c[2], h3 = c[3];
    let h: number;
    if (!World.splitOf(c)) {
      // NW-SE split: triangles (NW,NE,SE) where fx>=fz, and (NW,SE,SW)
      if (fx >= fz) h = h0 + (h1 - h0) * fx + (h2 - h1) * fz;
      else h = h0 + (h2 - h3) * fx + (h3 - h0) * fz;
    } else {
      // NE-SW split: triangles (NW,NE,SW) where fx+fz<=1, and (NE,SE,SW)
      if (fx + fz <= 1) h = h0 + (h1 - h0) * fx + (h3 - h0) * fz;
      else h = h2 + (h3 - h2) * (1 - fx) + (h1 - h2) * (1 - fz);
    }
    return h * HSTEP;
  }

  setCorner(cx: number, cz: number, level: number) {
    const i = this.cidx(cx, cz);
    if (this.hgt[i] === level) return;
    this.hgt[i] = level;
    this.heightsVersion++;
    // terrain chunks touching this corner
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const x = cx + dx, z = cz + dz;
      if (this.inBounds(x, z)) { this.markTile(x, z); }
    }
  }

  // ---------- dirty tracking ----------
  markTile(x: number, z: number) {
    if (!this.inBounds(x, z)) return;
    this.tileVersion[this.idx(x, z)]++;
    const oc = Math.ceil(this.size / OBJ_CHUNK);
    this.dirtyObj.add(((z / OBJ_CHUNK) | 0) * oc + ((x / OBJ_CHUNK) | 0));
    const tc = Math.ceil(this.size / TERRAIN_CHUNK);
    this.dirtyTerrain.add(((z / TERRAIN_CHUNK) | 0) * tc + ((x / TERRAIN_CHUNK) | 0));
    // geometry of tracks depends on neighbours (tangents), so mark neighbour chunks too
    for (let d = 0; d < 4; d++) {
      const nx = x + DX[d], nz = z + DZ[d];
      if (this.inBounds(nx, nz)) {
        this.tileVersion[this.idx(nx, nz)]++;
        this.dirtyObj.add(((nz / OBJ_CHUNK) | 0) * oc + ((nx / OBJ_CHUNK) | 0));
      }
    }
  }
  markObjOnly(x: number, z: number) {
    const oc = Math.ceil(this.size / OBJ_CHUNK);
    this.dirtyObj.add(((z / OBJ_CHUNK) | 0) * oc + ((x / OBJ_CHUNK) | 0));
  }

  // ---------- rail ----------
  hasPiece(t: number, p: number): boolean { return (this.rail[t] & (1 << p)) !== 0; }
  /** Bitmask of edges touched by rail pieces on a tile. */
  railEdges(t: number): number {
    const m = this.rail[t];
    let e = 0;
    for (let p = 0; p < PIECE_COUNT; p++) if (m & (1 << p)) { e |= 1 << PIECE_EDGES[p][0]; e |= 1 << PIECE_EDGES[p][1]; }
    return e;
  }
  /** Mask of edges reachable from entry edge `a` through rail pieces. */
  railExits(t: number, a: number): number {
    const m = this.rail[t];
    let out = 0;
    for (let p = 0; p < PIECE_COUNT; p++) {
      if (!(m & (1 << p))) continue;
      const [e1, e2] = PIECE_EDGES[p];
      if (e1 === a) out |= 1 << e2; else if (e2 === a) out |= 1 << e1;
    }
    return out;
  }
  pieceCount(t: number): number { let c = 0, m = this.rail[t]; while (m) { c += m & 1; m >>= 1; } return c; }

  /** Structure id attached at a tile edge (bridge/tunnel head), or -1. */
  headAt(t: number, e: number): number { return this.heads.get(t * 4 + e) ?? -1; }

  // ---------- buildings ----------
  addBuilding(b: Omit<Building, 'id'>): Building {
    const id = this.freeBuildingIds.length ? this.freeBuildingIds.pop()! : this.buildings.length;
    const bb: Building = { ...b, id };
    this.buildings[id] = bb;
    const t = this.idx(b.x, b.z);
    this.building[t] = id;
    this.townOf[t] = b.townId;
    this.trees[t] = 0;
    this.markTile(b.x, b.z);
    return bb;
  }
  removeBuilding(id: number) {
    const b = this.buildings[id];
    if (!b) return;
    const t = this.idx(b.x, b.z);
    this.building[t] = -1;
    this.buildings[id] = null;
    this.freeBuildingIds.push(id);
    this.markTile(b.x, b.z);
  }

  /** True if the tile carries nothing at all (trees allowed). */
  isEmpty(t: number): boolean {
    return this.rail[t] === 0 && this.road[t] === 0 && this.building[t] < 0 && this.station[t] < 0 && this.depot[t] < 0;
  }

  neighbour(t: number, d: number): number {
    const x = (t % this.size) + DX[d], z = ((t / this.size) | 0) + DZ[d];
    return this.inBounds(x, z) ? z * this.size + x : -1;
  }
}

const tmp4 = [0, 0, 0, 0];
