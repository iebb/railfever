// The world: continuous terrain heightmap, trees, buildings and the transport network.
import { SpatialGrid, RegionVersions, type RegionSnapshot } from './spatial';
import { Network } from './network';
import { WATER_Y } from './constants';

export const TERRAIN_CHUNK = 64;
export const OBJ_CHUNK = 32;

export interface Building {
  id: number;
  townId: number;
  x: number; z: number;
  /** rotation (radians); facade faces direction (sin a, cos a) */
  angle: number;
  w: number; d: number;
  type: number;
  floors: number;
  pop: number;
  seed: number;
  /** base height (top of foundation) */
  y: number;
  built: number;
}

export interface Tree { x: number; z: number; s: number; type: number; tint: number }

export class World {
  readonly size: number;
  /** vertex heights, (size+1)^2 */
  readonly h: Float32Array;
  /** vertex locks: bit 1 network formation, bit 2 building, bit 4 rail formation */
  readonly lock: Uint8Array;
  net: Network;
  buildings = new Map<number, Building>();
  readonly lotVersions = new RegionVersions();
  private lotChanges = new Map<number, Map<number, number>>();
  readonly terrainVersions = new RegionVersions();
  /** Facade connectors are short: a small terrain edit need not re-snap every door in a 32-unit region. */
  readonly frontageTerrainVersions = new RegionVersions(4);
  // Index hooks also cover save load's direct map/index writes and footprint relocations.
  bgrid = new SpatialGrid(4, 100000, (id, box) => {
    this.lotVersions.bump(box);
    if (!box) { this.lotChanges.clear(); return; }
    for (const region of RegionVersions.ids(box)) {
      let changes = this.lotChanges.get(region);
      if (!changes) { changes = new Map(); this.lotChanges.set(region, changes); }
      changes.set(id, this.lotVersions.version);
    }
  });
  nextBuildingId = 1;
  trees: (Tree | null)[] = [];
  treeGrid = new SpatialGrid(8);
  freeTrees: number[] = [];

  dirtyTerrain = new Set<number>();
  dirtyObj = new Set<number>();
  heightsVersion = 0;
  private catchHeights = 0;
  private catchTerrain = 0;

  /** Bulk height writers (generation/load tools) may only have a global version: invalidate safely. */
  syncCatchmentTerrain() {
    if (this.heightsVersion - this.catchHeights > this.terrainVersions.version - this.catchTerrain) {
      this.terrainVersions.bump(); this.frontageTerrainVersions.bump();
    }
    this.catchHeights = this.heightsVersion; this.catchTerrain = this.terrainVersions.version;
  }

  constructor(size: number) {
    this.size = size;
    this.h = new Float32Array((size + 1) * (size + 1));
    this.lock = new Uint8Array((size + 1) * (size + 1));
    this.net = new Network(this);
  }

  // ---------------------------------------------------------------- terrain
  vi(x: number, z: number) { return z * (this.size + 1) + x; }
  vh(x: number, z: number): number {
    const s = this.size;
    x = x < 0 ? 0 : x > s ? s : x;
    z = z < 0 ? 0 : z > s ? s : z;
    return this.h[z * (s + 1) + x];
  }
  inside(x: number, z: number, margin = 0) { return x >= margin && z >= margin && x <= this.size - margin && z <= this.size - margin; }

  /** Terrain height at a world position, matching the rendered triangles (NW-SE split). */
  heightAt(wx: number, wz: number): number {
    const s = this.size;
    if (wx < 0) wx = 0; if (wz < 0) wz = 0;
    if (wx > s - 1e-4) wx = s - 1e-4; if (wz > s - 1e-4) wz = s - 1e-4;
    const x = Math.floor(wx), z = Math.floor(wz);
    const fx = wx - x, fz = wz - z;
    const i = z * (s + 1) + x;
    const h0 = this.h[i], h1 = this.h[i + 1], h2 = this.h[i + s + 2], h3 = this.h[i + s + 1];
    if (fx >= fz) return h0 + (h1 - h0) * fx + (h2 - h1) * fz;
    return h0 + (h2 - h3) * fx + (h3 - h0) * fz;
  }

  slopeAt(wx: number, wz: number): number {
    const e = 0.5;
    const dx = this.heightAt(wx + e, wz) - this.heightAt(wx - e, wz);
    const dz = this.heightAt(wx, wz + e) - this.heightAt(wx, wz - e);
    return Math.hypot(dx, dz) / (2 * e);
  }

  isWater(wx: number, wz: number) { return this.heightAt(wx, wz) < WATER_Y + 0.02; }

  setVertex(x: number, z: number, v: number) {
    const i = this.vi(x, z);
    if (this.h[i] === v) return;
    this.h[i] = v;
    this.heightsVersion++;
    this.terrainVersions.bump([x - 1, z - 1, x + 1, z + 1]);
    this.frontageTerrainVersions.bump([x - 1, z - 1, x + 1, z + 1]);
    const tc = Math.ceil(this.size / TERRAIN_CHUNK);
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      const cx = x + dx, cz = z + dz;
      if (cx < 0 || cz < 0 || cx >= this.size || cz >= this.size) continue;
      this.dirtyTerrain.add(Math.floor(cz / TERRAIN_CHUNK) * tc + Math.floor(cx / TERRAIN_CHUNK));
    }
    this.markObj(x, z);
  }

  markObj(x: number, z: number) {
    const oc = Math.ceil(this.size / OBJ_CHUNK);
    const cx = Math.max(0, Math.min(oc - 1, Math.floor(x / OBJ_CHUNK))), cz = Math.max(0, Math.min(oc - 1, Math.floor(z / OBJ_CHUNK)));
    this.dirtyObj.add(cz * oc + cx);
  }
  markObjArea(x0: number, z0: number, x1: number, z1: number) {
    const oc = Math.ceil(this.size / OBJ_CHUNK);
    for (let cz = Math.max(0, Math.floor(z0 / OBJ_CHUNK)); cz <= Math.min(oc - 1, Math.floor(z1 / OBJ_CHUNK)); cz++)
      for (let cx = Math.max(0, Math.floor(x0 / OBJ_CHUNK)); cx <= Math.min(oc - 1, Math.floor(x1 / OBJ_CHUNK)); cx++) this.dirtyObj.add(cz * oc + cx);
  }

  // ---------------------------------------------------------------- buildings
  addBuilding(b: Omit<Building, 'id'>): Building {
    const bb: Building = { ...b, id: this.nextBuildingId++ };
    this.buildings.set(bb.id, bb);
    const r = Math.hypot(b.w, b.d) / 2;
    this.bgrid.insert(bb.id, b.x - r, b.z - r, b.x + r, b.z + r);
    this.markObj(b.x, b.z);
    this.setBuildingLocks(bb, true);
    return bb;
  }
  removeBuilding(id: number) {
    const b = this.buildings.get(id);
    if (!b) return;
    this.buildings.delete(id);
    this.bgrid.remove(id);
    this.markObj(b.x, b.z);
    this.setBuildingLocks(b, false);
  }
  /** Call after an in-place building change; reindexing invalidates both its old and new regions. */
  touchBuilding(b: Building) {
    const r = Math.hypot(b.w, b.d) / 2;
    this.bgrid.insert(b.id, b.x - r, b.z - r, b.x + r, b.z + r);
    this.markObj(b.x, b.z);
  }
  /** Changed building IDs in a dependency snapshot; null means a bulk change needs a full local query. */
  changedLots(s: RegionSnapshot): Set<number> | null {
    if (this.lotVersions.fallbackVersion > s.version) return null;
    const ids = new Set<number>();
    for (const region of s.ids) for (const [id, version] of this.lotChanges.get(region) ?? []) if (version > s.version) ids.add(id);
    return ids;
  }
  private setBuildingLocks(b: Building, on: boolean) {
    const r = Math.hypot(b.w, b.d) / 2 + 0.5;
    // Pad for rounded vertex bounds and rotated neighbours' margins (the spatial grid indexes footprints).
    const nearby = on ? [] : this.buildingsNear(b.x, b.z, r + 2);
    for (let z = Math.floor(b.z - r); z <= Math.ceil(b.z + r); z++) for (let x = Math.floor(b.x - r); x <= Math.ceil(b.x + r); x++) {
      if (x < 0 || z < 0 || x > this.size || z > this.size) continue;
      if (!pointInRect(x, z, b.x, b.z, b.angle, b.w / 2 + 0.6, b.d / 2 + 0.6)) continue;
      const i = this.vi(x, z);
      if (on || nearby.some((other) => pointInRect(x, z, other.x, other.z, other.angle, other.w / 2 + 0.6, other.d / 2 + 0.6))) this.lock[i] |= 2;
      else this.lock[i] &= ~2;
    }
  }
  /** Buildings whose footprint (expanded by margin) contains or touches the point. */
  buildingsNear(x: number, z: number, r: number): Building[] {
    const out: Building[] = [];
    for (const id of this.bgrid.query(x - r, z - r, x + r, z + r)) { const b = this.buildings.get(id); if (b) out.push(b); }
    return out;
  }

  // ---------------------------------------------------------------- trees
  addTree(t: Tree) {
    const id = this.freeTrees.length ? this.freeTrees.pop()! : this.trees.length;
    this.trees[id] = t;
    this.treeGrid.insert(id, t.x, t.z, t.x, t.z);
    return id;
  }
  /** Remove trees within distance `r` of a point; returns count. */
  removeTreesNear(x: number, z: number, r: number): number {
    let n = 0;
    for (const id of this.treeGrid.query(x - r, z - r, x + r, z + r)) {
      const t = this.trees[id];
      if (!t || Math.hypot(t.x - x, t.z - z) > r) continue;
      this.trees[id] = null;
      this.freeTrees.push(id);
      this.treeGrid.remove(id);
      this.markObj(t.x, t.z);
      n++;
    }
    return n;
  }
  countTreesNear(x: number, z: number, r: number): number {
    let n = 0;
    for (const id of this.treeGrid.query(x - r, z - r, x + r, z + r)) { const t = this.trees[id]; if (t && Math.hypot(t.x - x, t.z - z) <= r) n++; }
    return n;
  }
}

/** Is (px,pz) inside the rectangle centred at (cx,cz) with rotation `a` and half extents (hw along local x, hd along local z)? */
export function pointInRect(px: number, pz: number, cx: number, cz: number, a: number, hw: number, hd: number): boolean {
  const dx = px - cx, dz = pz - cz;
  const fx = Math.sin(a), fz = Math.cos(a); // forward (local z)
  const rx = fz, rz = -fx;                  // right (local x)
  const lx = dx * rx + dz * rz, lz = dx * fx + dz * fz;
  return Math.abs(lx) <= hw && Math.abs(lz) <= hd;
}

/** Distance from point to an oriented rectangle (0 if inside). */
export function distToRect(px: number, pz: number, cx: number, cz: number, a: number, hw: number, hd: number): number {
  const dx = px - cx, dz = pz - cz;
  const fx = Math.sin(a), fz = Math.cos(a);
  const rx = fz, rz = -fx;
  const lx = Math.abs(dx * rx + dz * rz) - hw, lz = Math.abs(dx * fx + dz * fz) - hd;
  const ox = Math.max(lx, 0), oz = Math.max(lz, 0);
  return Math.hypot(ox, oz);
}
