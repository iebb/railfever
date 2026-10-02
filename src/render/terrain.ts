// Terrain chunks (1 vertex per world unit, distance LOD), map-edge skirts, water surface and exact ray picking.
import * as THREE from 'three';
import { World, TERRAIN_CHUNK, OBJ_CHUNK } from '../game/world';
import { WATER_Y } from '../game/constants';
import { NOISE_GLSL } from './shaders';
import { GeoBuilder } from './geo';
import { detailTextures } from './terrain-tex';

export interface TerrainUniforms {
  uGrid: { value: number };
  uHiRect: { value: THREE.Vector4 };
  uHiColor: { value: THREE.Color };
  uHiOn: { value: number };
  uCircle: { value: THREE.Vector4 };
  uCircleColor: { value: THREE.Color };
  uSnow: { value: number };
  uTime: { value: number };
}

/** Depth of the crack-hiding skirts hanging below every chunk border. */
const SKIRT = 6;
/** LOD steps (vertex spacing 1, 2, 4, 8, 16 units). */
const LODS = 5;
/** Render chunk size (a multiple of the world's TERRAIN_CHUNK dirty-tracking size): few draw calls. */
export const RENDER_CHUNK = 128;
/** Larger chunks on big maps keep the whole-map view at <= 36 terrain draws. */
export function renderChunkFor(size: number) { return size >= 1024 ? 256 : RENDER_CHUNK; }
/** Heights are stored as 16-bit integers in 1/128 units (7.8 cm), positions relative to the chunk. */
const YQ = 128;
/**
 * Pixels per world unit below which a chunk drops to the next coarser level. Conservative: coarse cells
 * cannot follow 1-unit earthworks (cuttings would cover tracks), so they only start below ~4 px per unit.
 */
const LOD_PPU = [4, 2, 1, 0.5];

interface ChunkIndex {
  index: THREE.BufferAttribute;
  /** [start, count] of grid triangles per LOD, and of grid + skirt triangles per LOD */
  grid: [number, number][];
  full: [number, number][];
}

/** Shared index buffers per chunk vertex dimensions (same split as World.heightAt), all LODs in one buffer. */
const indexCache = new Map<string, ChunkIndex>();
function chunkIndex(vw: number, vh: number): ChunkIndex {
  const key = vw + 'x' + vh;
  const c = indexCache.get(key);
  if (c) return c;
  const nv = vw * vh;
  const sb = nv; // skirt vertices: north row, south row, west column, east column
  const idx: number[] = [];
  const grid: [number, number][] = [], full: [number, number][] = [];
  const v = (i: number, j: number) => j * vw + i;
  for (let k = 0; k < LODS; k++) {
    const st = 1 << k;
    if ((vw - 1) % st || (vh - 1) % st) { grid.push(grid[k - 1]); full.push(full[k - 1]); continue; }
    const start = idx.length;
    for (let j = 0; j < vh - 1; j += st) for (let i = 0; i < vw - 1; i += st) {
      const a = v(i, j), b = v(i + st, j), cc = v(i + st, j + st), d = v(i, j + st);
      // (x,z),(x+1,z+1),(x+1,z) and (x,z),(x,z+1),(x+1,z+1): CCW seen from above
      idx.push(a, cc, b, a, d, cc);
    }
    const gEnd = idx.length;
    for (let i = 0; i < vw - 1; i += st) {
      const p0 = v(i, 0), p1 = v(i + st, 0), b0 = sb + i, b1 = sb + i + st;
      idx.push(p0, p1, b1, p0, b1, b0);
      const q0 = v(i, vh - 1), q1 = v(i + st, vh - 1), c0 = sb + vw + i, c1 = sb + vw + i + st;
      idx.push(q1, q0, c0, q1, c0, c1);
    }
    for (let j = 0; j < vh - 1; j += st) {
      const p0 = v(0, j), p1 = v(0, j + st), b0 = sb + 2 * vw + j, b1 = sb + 2 * vw + j + st;
      idx.push(p1, p0, b0, p1, b0, b1);
      const q0 = v(vw - 1, j), q1 = v(vw - 1, j + st), c0 = sb + 2 * vw + vh + j, c1 = sb + 2 * vw + vh + j + st;
      idx.push(q0, q1, c1, q0, c1, c0);
    }
    grid.push([start, gEnd - start]);
    full.push([start, idx.length - start]);
  }
  const total = nv + 2 * (vw + vh);
  const index = new THREE.BufferAttribute(total > 65535 ? new Uint32Array(idx) : new Uint16Array(idx), 1);
  const ci = { index, grid, full };
  indexCache.set(key, ci);
  return ci;
}

interface ChunkInfo {
  x0: number; z0: number; x1: number; z1: number; minY: number; maxY: number;
  /** LOD wanted for the camera, and the one drawn (a coarse mesh may still wait to be built) */
  lod: number; shown: number; range: number; ix: ChunkIndex;
  /** full resolution (all LOD index ranges: the shadow pass draws a coarser one) */
  geo0: THREE.BufferGeometry;
  /** LOD >= 1: own vertices every 2^lod units, each lowered by the local LOD error (built lazily) */
  coarse: (THREE.BufferGeometry | null)[];
  drops: (Float32Array | null)[];
  /** lowering of geo0's shadow-pass range (< 0: not computed yet) */
  shadowDrop: number;
}
const NEIGH = [-1, 0, 1, 0, 0, -1, 0, 1];

/**
 * Far chunks merge in 2x2 groups drawn as one mesh: once all four are at LOD >= groupLod the group's own
 * grid (vertex spacing of that LOD, identical vertices, so seams stay exact) replaces them - the whole-map
 * view needs 9 terrain draws instead of 36. groupLod keeps a group at <= 129 x 129 vertices (LOD 1 for
 * 128-unit chunks, LOD 2 for 256-unit chunks).
 */
const GROUP_GRID = 128;
interface GroupInfo {
  members: number[]; x0: number; z0: number; x1: number; z1: number;
  mesh: THREE.Mesh | null;
  /** merged geometry per absolute LOD (>= groupLod), lowered like the chunks' coarse levels, built lazily */
  geos: (THREE.BufferGeometry | null)[];
  /** vegetation attributes out of date (a member's were refreshed) */
  auxStale: boolean;
  active: boolean; level: number; ok: boolean;
}

const quantY = (y: number) => Math.max(-32767, Math.min(32767, Math.round(y * YQ)));

/**
 * Lift of draped road surfaces above the exact terrain (World.heightAt): road vehicles on ground sections ride
 * on it, the static road drape uses it.
 */
export const ROAD_DRAPE = 0.02;

/**
 * Per-vertex lowering of a coarse grid (cw x ch cells of st units from (x0, z0)) so that no coarse triangle
 * rises above the exact 1-unit surface: each vertex drops by the largest error (coarse - exact) of the coarse
 * triangles around it, including the cells just outside the region, so neighbouring regions agree on shared
 * borders. Anything lying on the exact surface (draped roads, rails, buildings) stays visible at every LOD,
 * and coarse shadow casters cannot shadow the surface itself.
 */
function coarseDrops(w: World, x0: number, z0: number, cw: number, ch: number, st: number): Float32Array {
  const CW = cw + 2, CH = ch + 2;
  const errB = new Float32Array(CW * CH), errD = new Float32Array(CW * CH);
  const inv = 1 / st;
  for (let cj = 0; cj < CH; cj++) for (let ci = 0; ci < CW; ci++) {
    const xa = x0 + (ci - 1) * st, za = z0 + (cj - 1) * st;
    const ha = w.vh(xa, za), hb = w.vh(xa + st, za), hc = w.vh(xa + st, za + st), hd = w.vh(xa, za + st);
    let eB = 0, eD = 0;
    // same split as World.heightAt: triangles (a, c, b) for u >= v and (a, d, c) for v >= u
    for (let j = 0; j <= st; j++) {
      const v = j * inv;
      for (let i = 0; i <= st; i++) {
        const u = i * inv, h = w.vh(xa + i, za + j);
        if (u >= v) { const e = ha + (hb - ha) * u + (hc - hb) * v - h; if (e > eB) eB = e; }
        if (v >= u) { const e = ha + (hc - hd) * u + (hd - ha) * v - h; if (e > eD) eD = e; }
      }
    }
    errB[cj * CW + ci] = eB; errD[cj * CW + ci] = eD;
  }
  // border vertices stay within the crack-hiding skirts of neighbouring regions; inside, any depth is fine
  const vw = cw + 1, vh = ch + 1, drop = new Float32Array(vw * vh), cap = SKIRT - 0.5;
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
    // vertex (i, j) is corner a of cell (i, j) [both triangles], b of (i-1, j) [B], c of (i-1, j-1) [both], d of (i, j-1) [D]
    const A = (j + 1) * CW + i + 1, Bc = (j + 1) * CW + i, Cc = j * CW + i, Dc = j * CW + i + 1;
    const e = Math.max(errB[A], errD[A], errB[Bc], errB[Cc], errD[Cc], errD[Dc]);
    const edge = i === 0 || j === 0 || i === vw - 1 || j === vh - 1;
    drop[j * vw + i] = e > 0.004 ? Math.min(edge ? cap : 60, e + 0.01) : 0;
  }
  return drop;
}

/**
 * Compact vertices of a vw x vh grid with spacing `st` from (x0, z0): chunk-local integer x/z, height in 1/128
 * units, 8-bit normals (from the 1-unit heightfield, so every LOD shades alike), then the skirt vertices.
 * Returns [minY, maxY].
 */
function fillGrid(w: World, x0: number, z0: number, st: number, vw: number, vh: number, pos: Int16Array, nrm: Int8Array): [number, number] {
  let k = 0, minY = Infinity, maxY = -Infinity;
  for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
    const x = x0 + i * st, z = z0 + j * st;
    const y = w.vh(x, z);
    pos[k * 3] = i * st; pos[k * 3 + 1] = quantY(y); pos[k * 3 + 2] = j * st;
    if (y < minY) minY = y; if (y > maxY) maxY = y;
    const dx = (w.vh(x + 1, z) - w.vh(x - 1, z)) * 0.5;
    const dz = (w.vh(x, z + 1) - w.vh(x, z - 1)) * 0.5;
    const l = 127 / Math.hypot(dx, 1, dz);
    nrm[k * 4] = Math.round(-dx * l); nrm[k * 4 + 1] = Math.round(l); nrm[k * 4 + 2] = Math.round(-dz * l);
    k++;
  }
  addSkirts(pos, nrm, vw, vh);
  return [minY, maxY];
}

/** Skirt vertices below the border of a vw x vh grid (copy normals so they shade like the surface). */
function addSkirts(pos: Int16Array, nrm: Int8Array, vw: number, vh: number) {
  let k = vw * vh;
  const skirtOf = (src: number) => {
    pos[k * 3] = pos[src * 3]; pos[k * 3 + 1] = Math.max(-32767, pos[src * 3 + 1] - SKIRT * YQ); pos[k * 3 + 2] = pos[src * 3 + 2];
    nrm[k * 4] = nrm[src * 4]; nrm[k * 4 + 1] = nrm[src * 4 + 1]; nrm[k * 4 + 2] = nrm[src * 4 + 2];
    k++;
  };
  for (let i = 0; i < vw; i++) skirtOf(i);
  for (let i = 0; i < vw; i++) skirtOf((vh - 1) * vw + i);
  for (let j = 0; j < vh; j++) skirtOf(j * vw);
  for (let j = 0; j < vh; j++) skirtOf(j * vw + vw - 1);
}

/** Copy the attribute values of the border vertices to the skirt vertices that follow the grid. */
function copySkirts(a: Int8Array | Float32Array, size: number, vw: number, vh: number) {
  let k = vw * vh;
  const cp = (src: number) => { for (let c = 0; c < size; c++) a[k * size + c] = a[src * size + c]; k++; };
  for (let i = 0; i < vw; i++) cp(i);
  for (let i = 0; i < vw; i++) cp((vh - 1) * vw + i);
  for (let j = 0; j < vh; j++) cp(j * vw);
  for (let j = 0; j < vh; j++) cp(j * vw + vw - 1);
}

export class TerrainView {
  group = new THREE.Group();
  material: THREE.MeshStandardMaterial;
  uniforms: TerrainUniforms;
  chunks: (THREE.Mesh | null)[] = [];
  skirt: THREE.Mesh | null = null;
  waterSides: THREE.Mesh | null = null;
  water: THREE.Mesh;
  waterMat: THREE.ShaderMaterial;
  heightTex: THREE.DataTexture;
  base: THREE.Mesh;
  /** max milliseconds spent rebuilding dirty chunks per update */
  budgetMs = 6;
  /** distance LOD (half/quarter resolution for far chunks) */
  lodEnabled = true;
  private info: ChunkInfo[] = [];
  private heightData: Uint16Array;
  private nc: number;
  /** render chunk size for this map */
  readonly rc: number;
  /** shadow pass: same integer vertex decoding as the terrain material */
  private depthMat: THREE.MeshDepthMaterial;
  private auxTmp: Float32Array | null = null;
  private bottom = -6;
  /** object chunks already seen dirty (their trees/edges feed the terrain attributes) */
  private objSeen = new Set<number>();
  private auxDirty = new Set<number>();
  private geoDirty = new Set<number>();
  private auxAt: number[] = [];
  private edgeH: Float32Array;
  private camPos = new THREE.Vector3();
  private saved = new THREE.Vector2();
  private shadowSwapped = false;
  /** minimum LOD used when the terrain casts shadows */
  shadowLod = 1;
  /** shadow camera that gets exact full-resolution casters (the near cascade), set by the renderer */
  exactShadowCamera: THREE.Camera | null = null;
  /** 2x2 merged far-chunk meshes */
  private groups: GroupInfo[] = [];
  private ng = 0;
  private readonly groupLod: number;
  private readonly groupStep: number;

  constructor(public world: World) {
    const s = world.size;
    this.rc = renderChunkFor(s);
    this.nc = Math.ceil(s / this.rc);
    this.groupLod = Math.max(1, Math.min(LODS - 1, Math.round(Math.log2((2 * this.rc) / GROUP_GRID))));
    this.groupStep = 1 << this.groupLod;
    this.uniforms = {
      uGrid: { value: 0 },
      uHiRect: { value: new THREE.Vector4(0, 0, 0, 0) },
      uHiColor: { value: new THREE.Color(0.3, 0.8, 1.0) },
      uHiOn: { value: 0 },
      uCircle: { value: new THREE.Vector4(0, 0, 0, 0) },
      uCircleColor: { value: new THREE.Color(0.35, 0.75, 1.0) },
      uSnow: { value: 20 },
      uTime: { value: 0 },
    };
    this.material = createTerrainMaterial(this.uniforms);
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    this.depthMat.onBeforeCompile = (sh) => { sh.vertexShader = sh.vertexShader.replace('#include <begin_vertex>', DECODE); };
    this.depthMat.customProgramCacheKey = () => 'rf-terrain-depth';

    let minH = 0;
    for (let i = 0; i < world.h.length; i++) if (world.h[i] < minH) minH = world.h[i];
    this.bottom = Math.min(minH, WATER_Y) - 3;

    // height field texture (half float: filterable everywhere) for the water shader
    this.heightData = new Uint16Array((s + 1) * (s + 1));
    this.heightTex = new THREE.DataTexture(this.heightData, s + 1, s + 1, THREE.RedFormat, THREE.HalfFloatType);
    this.heightTex.magFilter = THREE.LinearFilter;
    this.heightTex.minFilter = THREE.LinearFilter;
    this.heightTex.wrapS = this.heightTex.wrapT = THREE.ClampToEdgeWrapping;
    this.fillHeights(0, s);

    this.waterMat = createWaterMaterial(this.heightTex, s);
    const wg = new THREE.PlaneGeometry(s, s, 1, 1);
    wg.rotateX(-Math.PI / 2);
    wg.translate(s / 2, WATER_Y, s / 2);
    this.water = new THREE.Mesh(wg, this.waterMat);
    this.water.renderOrder = 2;
    this.group.add(this.water);

    // base plate under the diorama
    const bg = new THREE.PlaneGeometry(s * 12, s * 12);
    bg.rotateX(-Math.PI / 2);
    bg.translate(s / 2, this.bottom, s / 2);
    this.base = new THREE.Mesh(bg, new THREE.MeshStandardMaterial({ color: 0x5b6150, roughness: 1 }));
    this.base.receiveShadow = true;
    this.group.add(this.base);

    this.chunks = new Array(this.nc * this.nc).fill(null);
    for (let i = 0; i < this.nc * this.nc; i++) this.buildChunk(i);
    this.ng = this.nc >= 2 ? Math.ceil(this.nc / 2) : 0;
    for (let gz = 0; gz < this.ng; gz++) for (let gx = 0; gx < this.ng; gx++) {
      const members: number[] = [];
      for (let dz = 0; dz < 2; dz++) for (let dx = 0; dx < 2; dx++) {
        const cx = gx * 2 + dx, cz = gz * 2 + dz;
        if (cx < this.nc && cz < this.nc) members.push(cz * this.nc + cx);
      }
      const x0 = gx * 2 * this.rc, z0 = gz * 2 * this.rc, x1 = Math.min(s, x0 + 2 * this.rc), z1 = Math.min(s, z0 + 2 * this.rc);
      const ok = members.length > 1 && (x1 - x0) % this.groupStep === 0 && (z1 - z0) % this.groupStep === 0;
      this.groups.push({ members, x0, z0, x1, z1, mesh: null, geos: [], auxStale: false, active: false, level: -1, ok });
    }
    this.edgeH = new Float32Array((s + 1) * 4);
    this.edgesChanged();
    this.rebuildSkirt();
  }

  get chunkCount() { return this.nc; }

  /**
   * Rebuild dirty chunks (consumes world.dirtyTerrain) within the time budget, refresh the
   * vegetation/earthwork attributes of chunks whose objects changed, and pick LODs for the camera.
   */
  update(camera?: THREE.Camera, pxScale = 0) {
    const w = this.world;
    const t0 = performance.now();
    if (w.dirtyTerrain.size) {
      // world chunks (TERRAIN_CHUNK) map onto the larger render chunks
      const wn = Math.ceil(w.size / TERRAIN_CHUNK), f = this.rc / TERRAIN_CHUNK;
      for (const wc of w.dirtyTerrain) this.geoDirty.add(Math.floor(Math.floor(wc / wn) / f) * this.nc + Math.floor((wc % wn) / f));
      w.dirtyTerrain.clear();
    }
    if (this.geoDirty.size) {
      let border = false;
      for (const ci of [...this.geoDirty]) {
        this.geoDirty.delete(ci);
        if (ci < 0 || ci >= this.chunks.length) continue;
        this.buildChunk(ci);
        this.auxDirty.delete(ci);
        const cx = ci % this.nc, cz = Math.floor(ci / this.nc);
        this.fillHeights(cz * this.rc, Math.min(w.size, (cz + 1) * this.rc));
        if (cx === 0 || cz === 0 || cx === this.nc - 1 || cz === this.nc - 1) border = true;
        if (performance.now() - t0 > this.budgetMs) break;
      }
      if (border && this.edgesChanged()) this.rebuildSkirt();
    }
    // object changes (trees cut, tracks built) alter forest floor and earthwork shading
    if (w.dirtyObj.size || this.objSeen.size) {
      const on = Math.ceil(w.size / OBJ_CHUNK);
      for (const oc of w.dirtyObj) {
        if (this.objSeen.has(oc)) continue;
        this.objSeen.add(oc);
        const ox = (oc % on) * OBJ_CHUNK, oz = Math.floor(oc / on) * OBJ_CHUNK;
        const m = 6;
        const rc = this.rc;
        for (let cz = Math.max(0, Math.floor((oz - m) / rc)); cz <= Math.min(this.nc - 1, Math.floor((oz + OBJ_CHUNK + m) / rc)); cz++)
          for (let cx = Math.max(0, Math.floor((ox - m) / rc)); cx <= Math.min(this.nc - 1, Math.floor((ox + OBJ_CHUNK + m) / rc)); cx++) this.auxDirty.add(cz * this.nc + cx);
      }
      for (const oc of this.objSeen) if (!w.dirtyObj.has(oc)) this.objSeen.delete(oc);
    }
    if (this.auxDirty.size) {
      // cosmetic: at most one chunk per frame, and each chunk at most every 2 s (towns grow constantly)
      const now = performance.now();
      for (const ci of this.auxDirty) {
        if (now - (this.auxAt[ci] ?? -1e9) < 2000) continue;
        this.auxDirty.delete(ci);
        this.auxAt[ci] = now;
        this.refreshAux(ci);
        const G = this.groupOf(ci);
        if (G) G.auxStale = true;
        break;
      }
    }
    if (camera && pxScale > 0) this.updateLod(camera, pxScale);
  }

  /** Per-chunk resolution from the projected size of a terrain cell. */
  private updateLod(camera: THREE.Camera, pxScale: number) {
    const c = this.camPos.copy(camera.position);
    const n = this.nc;
    for (let ci = 0; ci < this.info.length; ci++) {
      const f = this.info[ci];
      const dx = Math.max(f.x0 - c.x, 0, c.x - f.x1), dy = Math.max(f.minY - c.y, 0, c.y - f.maxY), dz = Math.max(f.z0 - c.z, 0, c.z - f.z1);
      // pixels per world unit at the nearest point of the chunk
      const ppu = pxScale / Math.max(1e-3, Math.hypot(dx, dy, dz));
      let target = 0;
      if (this.lodEnabled) while (target < LODS - 1 && ppu < LOD_PPU[target]) target++;
      if (target === f.lod) continue;
      // hysteresis around the boundary between adjacent levels avoids flicker
      const edge = LOD_PPU[Math.min(target, f.lod)];
      if (Math.abs(target - f.lod) > 1 || Math.abs(ppu / edge - 1) > 0.1 || !this.lodEnabled) f.lod = target;
    }
    this.updateGroups();
    // coarse meshes are built lazily within a small budget; until then a finer built level is drawn
    const t0 = performance.now();
    for (let ci = 0; ci < this.info.length; ci++) {
      const f = this.info[ci];
      if (f.shown === f.lod) continue;
      let want = f.lod;
      if (want > 0 && !f.coarse[want]) {
        if (performance.now() - t0 < 3) this.buildCoarse(ci, want);
        while (want > 0 && !f.coarse[want]) want--;
      }
      f.shown = want;
    }
    for (let ci = 0; ci < this.info.length; ci++) {
      const f = this.info[ci], m = this.chunks[ci];
      if (!m || !m.visible) continue;
      if (f.shown > 0) {
        const g = f.coarse[f.shown]!;
        if (m.geometry !== g) { m.geometry = g; f.range = -1; }
        continue;
      }
      if (m.geometry !== f.geo0) { m.geometry = f.geo0; f.range = -1; }
      // full resolution: skirts only when a neighbour is drawn coarser (cracks)
      const cx = ci % n, cz = Math.floor(ci / n);
      let skirt = false;
      for (let k = 0; k < 8 && !skirt; k += 2) {
        const nx = cx + NEIGH[k], nz = cz + NEIGH[k + 1];
        if (nx >= 0 && nz >= 0 && nx < n && nz < n && this.shownLevel(nz * n + nx) > 0) skirt = true;
      }
      const key = skirt ? 1 : 0;
      if (key === f.range) continue;
      f.range = key;
      const r = skirt ? f.ix.full[0] : f.ix.grid[0];
      m.geometry.setDrawRange(r[0], r[1]);
    }
  }

  /** LOD drawn for a chunk (its group's level when merged). */
  private shownLevel(ci: number): number {
    const G = this.groupOf(ci);
    return G && G.active ? G.level : this.info[ci].shown;
  }

  /** Lowering of a chunk's level-k grid (cached until the chunk is rebuilt). */
  private chunkDrops(ci: number, k: number): Float32Array | null {
    const f = this.info[ci], st = 1 << k;
    if ((f.x1 - f.x0) % st || (f.z1 - f.z0) % st) return null;
    return f.drops[k] ?? (f.drops[k] = coarseDrops(this.world, f.x0, f.z0, (f.x1 - f.x0) / st, (f.z1 - f.z0) / st, st));
  }

  private buildCoarse(ci: number, k: number) {
    const f = this.info[ci], drop = this.chunkDrops(ci, k);
    if (drop) f.coarse[k] = this.coarseGeometry(f.x0, f.z0, f.x1, f.z1, 1 << k, drop);
  }

  /**
   * Coarse LOD geometry of a region (vertices every st units, lowered by `drop`), with skirts; normals and
   * vegetation / earthwork attributes come from the full-resolution chunks.
   */
  private coarseGeometry(x0: number, z0: number, x1: number, z1: number, st: number, drop: Float32Array): THREE.BufferGeometry {
    const w = this.world, vw = (x1 - x0) / st + 1, vh = (z1 - z0) / st + 1, total = vw * vh + 2 * (vw + vh);
    const pos = new Int16Array(total * 3), nrm = new Int8Array(total * 4), aux = new Int8Array(total * 4);
    let minY = Infinity, maxY = -Infinity;
    for (let j = 0, k = 0; j < vh; j++) for (let i = 0; i < vw; i++, k++) {
      const y = w.vh(x0 + i * st, z0 + j * st) - drop[k];
      pos[k * 3] = i * st; pos[k * 3 + 1] = quantY(y); pos[k * 3 + 2] = j * st;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    this.copyFine(x0, z0, vw, vh, st, nrm, aux);
    addSkirts(pos, nrm, vw, vh);
    copySkirts(aux, 4, vw, vh);
    const ix = chunkIndex(vw, vh);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 4, true));
    g.setAttribute('aAux', new THREE.BufferAttribute(aux, 4, true));
    g.setIndex(ix.index);
    g.setDrawRange(ix.full[0][0], ix.full[0][1]);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY - SKIRT, 0), new THREE.Vector3(x1 - x0, maxY, z1 - z0));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    return g;
  }

  /** Normals (nrm) and / or vegetation attributes (aux) of grid vertices, copied from the full-resolution chunks. */
  private copyFine(x0: number, z0: number, vw: number, vh: number, st: number, nrm: Int8Array | null, aux: Int8Array | null) {
    const rc = this.rc, nc = this.nc;
    for (let j = 0, k = 0; j < vh; j++) {
      const z = z0 + j * st, cz = Math.min(nc - 1, Math.floor(z / rc));
      for (let i = 0; i < vw; i++, k++) {
        const x = x0 + i * st, cx = Math.min(nc - 1, Math.floor(x / rc));
        const f = this.info[cz * nc + cx];
        if (!f) continue;
        const o = ((z - f.z0) * (f.x1 - f.x0 + 1) + (x - f.x0)) * 4;
        if (nrm) { const src = (f.geo0.getAttribute('normal') as THREE.BufferAttribute).array as Int8Array; nrm[k * 4] = src[o]; nrm[k * 4 + 1] = src[o + 1]; nrm[k * 4 + 2] = src[o + 2]; }
        if (aux) { const src = (f.geo0.getAttribute('aAux') as THREE.BufferAttribute).array as Int8Array; aux[k * 4] = src[o]; aux[k * 4 + 1] = src[o + 1]; aux[k * 4 + 2] = src[o + 2]; aux[k * 4 + 3] = src[o + 3]; }
      }
    }
  }

  /** Re-copy the vegetation attributes into a built coarse geometry. */
  private refreshCoarseAux(g: THREE.BufferGeometry, x0: number, z0: number, x1: number, z1: number, st: number) {
    const a = g.getAttribute('aAux') as THREE.BufferAttribute, vw = (x1 - x0) / st + 1, vh = (z1 - z0) / st + 1;
    this.copyFine(x0, z0, vw, vh, st, null, a.array as Int8Array);
    copySkirts(a.array as Int8Array, 4, vw, vh);
    a.needsUpdate = true;
  }

  private groupOf(ci: number): GroupInfo | null {
    if (!this.ng) return null;
    const cx = ci % this.nc, cz = Math.floor(ci / this.nc);
    return this.groups[(cz >> 1) * this.ng + (cx >> 1)] ?? null;
  }

  /** Swap 2x2 blocks of far chunks for their merged mesh (at most one group level built per frame). */
  private updateGroups() {
    let builds = 0;
    for (const G of this.groups) {
      let want = G.ok && this.lodEnabled, lod = LODS - 1;
      if (want) for (const ci of G.members) {
        const f = this.info[ci];
        if (!f || !this.chunks[ci] || f.lod < this.groupLod) { want = false; break; }
        if (f.lod < lod) lod = f.lod;
      }
      if (want && !G.geos[lod]) {
        if (builds < 1) { this.buildGroupLevel(G, lod); builds++; }
        while (lod >= this.groupLod && !G.geos[lod]) lod--;
        if (lod < this.groupLod) want = false;
      }
      if (want && G.auxStale) this.groupAux(G);
      if (want && G.mesh && lod !== G.level) { G.level = lod; G.mesh.geometry = G.geos[lod]!; }
      if (want !== G.active) {
        G.active = want;
        if (G.mesh) G.mesh.visible = want;
        for (const ci of G.members) { const m = this.chunks[ci]; if (m) m.visible = !want; }
      }
    }
  }

  /** Merged level-L geometry of a group: the members' level-L grids (same vertices and lowering) in one mesh. */
  private buildGroupLevel(G: GroupInfo, L: number) {
    const st = 1 << L;
    if ((G.x1 - G.x0) % st || (G.z1 - G.z0) % st) return;
    const drop = coarseDrops(this.world, G.x0, G.z0, (G.x1 - G.x0) / st, (G.z1 - G.z0) / st, st);
    const g = this.coarseGeometry(G.x0, G.z0, G.x1, G.z1, st, drop);
    G.geos[L] = g;
    if (!G.mesh) {
      const m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      m.castShadow = true;
      m.customDepthMaterial = this.depthMat;
      m.position.set(G.x0, 0, G.z0);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.visible = false;
      G.mesh = m;
      G.level = L;
      this.group.add(m);
    }
  }

  /** Vegetation / earthwork attributes of a group's built levels (copied from the members). */
  private groupAux(G: GroupInfo) {
    G.auxStale = false;
    for (let L = 0; L < G.geos.length; L++) { const g = G.geos[L]; if (g) this.refreshCoarseAux(g, G.x0, G.z0, G.x1, G.z1, 1 << L); }
  }

  /** Drop a group's merged levels (a member was rebuilt). */
  private resetGroup(G: GroupInfo) {
    if (G.active) {
      G.active = false;
      if (G.mesh) G.mesh.visible = false;
      for (const ci of G.members) { const m = this.chunks[ci]; if (m) m.visible = true; }
    }
    for (const g of G.geos) g?.dispose();
    G.geos = [];
    G.level = -1;
  }

  /** Did any height along the map border change since the skirt was built? */
  private edgesChanged(): boolean {
    const w = this.world, s = w.size, e = this.edgeH;
    let changed = false;
    for (let i = 0; i <= s; i++) {
      const a = w.vh(i, 0), b = w.vh(i, s), c = w.vh(0, i), d = w.vh(s, i);
      const k = i * 4;
      if (e[k] !== a || e[k + 1] !== b || e[k + 2] !== c || e[k + 3] !== d) { changed = true; e[k] = a; e[k + 1] = b; e[k + 2] = c; e[k + 3] = d; }
    }
    return changed;
  }

  /** Copy vertex heights of rows z0..z1 into the height texture. */
  private fillHeights(z0: number, z1: number) {
    const w = this.world, s1 = w.size + 1;
    const a = this.heightData, h = w.h;
    const i0 = z0 * s1, i1 = (z1 + 1) * s1;
    for (let i = i0; i < i1; i++) a[i] = THREE.DataUtils.toHalfFloat(Math.max(-60000, Math.min(60000, h[i])));
    // (three's partial texture updates only support RGBA data: re-upload the whole texture)
    this.heightTex.needsUpdate = true;
  }

  private bounds(ci: number) {
    const s = this.world.size;
    const cx = ci % this.nc, cz = Math.floor(ci / this.nc);
    const x0 = cx * this.rc, z0 = cz * this.rc;
    return { x0, z0, x1: Math.min(s, x0 + this.rc), z1: Math.min(s, z0 + this.rc) };
  }

  buildChunk(ci: number) {
    const w = this.world;
    const { x0, z0, x1, z1 } = this.bounds(ci);
    const vw = x1 - x0 + 1, vh = z1 - z0 + 1;
    const nv = vw * vh, total = nv + 2 * (vw + vh);
    // compact vertices: chunk-local integer x/z, height in 1/128 units, 8-bit normals (14 bytes per vertex)
    const pos = new Int16Array(total * 3);
    const nrm = new Int8Array(total * 4);
    const [minY, maxY] = fillGrid(w, x0, z0, 1, vw, vh, pos, nrm);
    const G = this.groupOf(ci);
    if (G) this.resetGroup(G);
    const aux = new Int8Array(total * 4);
    this.packAux(x0, z0, x1, z1, aux, total);
    const ix = chunkIndex(vw, vh);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 4, true));
    g.setAttribute('aAux', new THREE.BufferAttribute(aux, 4, true));
    g.setIndex(ix.index);
    g.setDrawRange(ix.grid[0][0], ix.grid[0][1]);
    // bounds in decoded chunk-local units (three never reads the integer positions on the CPU)
    g.boundingBox = new THREE.Box3(new THREE.Vector3(0, minY - SKIRT, 0), new THREE.Vector3(x1 - x0, maxY, z1 - z0));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    const old = this.info[ci];
    if (old) { old.geo0.dispose(); for (const c of old.coarse) c?.dispose(); }
    this.info[ci] = { x0, z0, x1, z1, minY, maxY, lod: old ? old.lod : 0, shown: 0, range: 0, ix, geo0: g, coarse: [], drops: [], shadowDrop: -1 };
    let m = this.chunks[ci];
    if (m) m.geometry = g;
    else {
      m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      m.castShadow = true;
      m.customDepthMaterial = this.depthMat;
      m.position.set(x0, 0, z0);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      // shadow casting only needs the silhouette: a full-resolution chunk casts a coarser level (with skirts),
      // lowered by that level's error so it cannot shadow the exact surface in hollows and cuttings
      const mesh = m, idx = ci;
      mesh.onBeforeShadow = (_r, _o, _c, shadowCamera) => {
        const f = this.info[idx];
        this.shadowSwapped = false;
        if (mesh.geometry !== f.geo0 || this.shadowLod <= 0 || (this.exactShadowCamera !== null && shadowCamera === this.exactShadowCamera)) return;
        const lv = Math.min(LODS - 1, this.shadowLod);
        if (f.shadowDrop < 0) { const d = this.chunkDrops(idx, lv); let mx = 0; if (d) for (let i = 0; i < d.length; i++) if (d[i] > mx) mx = d[i]; f.shadowDrop = d ? mx : 0; }
        const r = f.ix.full[lv];
        const dr = mesh.geometry.drawRange;
        this.saved.set(dr.start, dr.count);
        mesh.geometry.setDrawRange(r[0], r[1]);
        this.shadowSwapped = true;
        const e = mesh.modelViewMatrix.elements, d = f.shadowDrop;
        e[12] -= d * e[4]; e[13] -= d * e[5]; e[14] -= d * e[6];
      };
      mesh.onAfterShadow = () => { if (this.shadowSwapped) mesh.geometry.setDrawRange(this.saved.x, this.saved.y); this.shadowSwapped = false; };
      this.chunks[ci] = m;
      this.group.add(m);
    }
  }

  /** Recompute only the vegetation / earthwork / cavity / shore attribute of a chunk (and its coarse copies). */
  private refreshAux(ci: number) {
    const f = this.info[ci];
    if (!f) return;
    const a = f.geo0.getAttribute('aAux') as THREE.BufferAttribute;
    this.packAux(f.x0, f.z0, f.x1, f.z1, a.array as Int8Array, a.count);
    a.needsUpdate = true;
    for (let k = 1; k < f.coarse.length; k++) { const g = f.coarse[k]; if (g) this.refreshCoarseAux(g, f.x0, f.z0, f.x1, f.z1, 1 << k); }
  }

  /**
   * computeAux into a scratch buffer, then pack as normalised bytes (forest 0..1, works 0..1, cavity -1..1,
   * shore 0..1).
   */
  private packAux(x0: number, z0: number, x1: number, z1: number, out: Int8Array, total: number) {
    if (!this.auxTmp || this.auxTmp.length < total * 4) this.auxTmp = new Float32Array(total * 4);
    const t = this.auxTmp;
    t.fill(0, 0, total * 4);
    this.computeAux(x0, z0, x1, z1, t);
    for (let i = 0; i < total; i++) {
      out[i * 4] = Math.round(Math.min(1, t[i * 4]) * 127);
      out[i * 4 + 1] = Math.round(Math.min(1, t[i * 4 + 1]) * 127);
      out[i * 4 + 2] = Math.round(Math.max(-1, Math.min(1, t[i * 4 + 2])) * 127);
      out[i * 4 + 3] = Math.round(Math.max(0, Math.min(1, t[i * 4 + 3])) * 127);
    }
  }

  /**
   * Per-vertex attributes: x forest density (forest floor under tree clusters), y earthworks (cuttings and
   * embankments next to network edges on the ground), z cavity (height above the local mean), w shore
   * (1 at the water's edge fading to 0 about 4 units inland: beaches only next to water, not on low land).
   */
  private computeAux(x0: number, z0: number, x1: number, z1: number, out: Float32Array) {
    const w = this.world, net = w.net;
    const vw = x1 - x0 + 1, vh = z1 - z0 + 1;
    // heights of the chunk plus a margin, read once (cavity and shore both use them)
    const M = 5, gw = vw + 2 * M, gh = vh + 2 * M, hh = new Float32Array(gw * gh);
    let anyWet = false;
    for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
      const y = w.vh(x0 - M + i, z0 - M + j);
      hh[j * gw + i] = y;
      if (y < WATER_Y) anyWet = true;
    }
    // cavity from a summed-area table (radius 3)
    const R = 3, aw = vw + 2 * R, ah = vh + 2 * R, sw = aw + 1, off = M - R;
    const sat = new Float64Array(sw * (ah + 1));
    for (let j = 0; j < ah; j++) {
      let row = 0;
      const src = (j + off) * gw + off;
      for (let i = 0; i < aw; i++) { row += hh[src + i]; sat[(j + 1) * sw + i + 1] = sat[j * sw + i + 1] + row; }
    }
    const D = 2 * R + 1, inv = 1 / (D * D);
    for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
      const sum = sat[(j + D) * sw + i + D] - sat[j * sw + i + D] - sat[(j + D) * sw + i] + sat[j * sw + i];
      const c = hh[(j + M) * gw + i + M] - sum * inv;
      out[(j * vw + i) * 4 + 2] = Math.max(-1, Math.min(1, c * 0.7));
    }
    // shore: chamfer distance (1, sqrt 2) to the nearest vertex under water, over the chunk plus the margin
    if (anyWet) {
      const INF = 1e6, dist = new Float32Array(gw * gh), D2 = Math.SQRT2;
      for (let k = 0; k < gw * gh; k++) dist[k] = hh[k] < WATER_Y ? 0 : INF;
      for (let j = 0; j < gh; j++) for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        let d = dist[k];
        if (i > 0) d = Math.min(d, dist[k - 1] + 1);
        if (j > 0) {
          d = Math.min(d, dist[k - gw] + 1);
          if (i > 0) d = Math.min(d, dist[k - gw - 1] + D2);
          if (i < gw - 1) d = Math.min(d, dist[k - gw + 1] + D2);
        }
        dist[k] = d;
      }
      for (let j = gh - 1; j >= 0; j--) for (let i = gw - 1; i >= 0; i--) {
        const k = j * gw + i;
        let d = dist[k];
        if (i < gw - 1) d = Math.min(d, dist[k + 1] + 1);
        if (j < gh - 1) {
          d = Math.min(d, dist[k + gw] + 1);
          if (i < gw - 1) d = Math.min(d, dist[k + gw + 1] + D2);
          if (i > 0) d = Math.min(d, dist[k + gw - 1] + D2);
        }
        dist[k] = d;
      }
      for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
        const d = dist[(j + M) * gw + i + M];
        out[(j * vw + i) * 4 + 3] = Math.max(0, Math.min(1, 1 - (d - 0.5) / 3.5));
      }
    }
    // forest floor
    const TR = 1.8;
    for (const id of w.treeGrid.query(x0 - TR, z0 - TR, x1 + TR, z1 + TR)) {
      const t = w.trees[id];
      if (!t) continue;
      for (let z = Math.max(z0, Math.ceil(t.z - TR)); z <= Math.min(z1, Math.floor(t.z + TR)); z++) {
        for (let x = Math.max(x0, Math.ceil(t.x - TR)); x <= Math.min(x1, Math.floor(t.x + TR)); x++) {
          const d = Math.hypot(x - t.x, z - t.z);
          if (d < TR) out[((z - z0) * vw + (x - x0)) * 4] += (1 - d / TR) * 0.4 * t.s;
        }
      }
    }
    // earthworks: graded ground beside edges (the visible band is kept narrow)
    const ER = 3.5;
    for (const e of net.edgesNear(x0 - ER - 1, z0 - ER - 1, x1 + ER + 1, z1 + ER + 1)) {
      const g = net.geo(e);
      // town streets: gentler, mostly grassed verges
      const town = e.kind === 'road' && e.owner < 0;
      const er = town ? 2 : ER, wk = town ? 0.4 : 1;
      const core = net.halfWidth(e) + 0.3, outer = core + er;
      let last = -1e9;
      for (let i = 0; i < g.n; i++) {
        const sp = g.cum[i];
        if (i > 0 && i < g.n - 1 && sp - last < 0.6) continue;
        last = sp;
        if (net.sectionAt(e, sp) !== 'ground') continue;
        const px = g.pts[i * 3], pz = g.pts[i * 3 + 2];
        if (px < x0 - outer || px > x1 + outer || pz < z0 - outer || pz > z1 + outer) continue;
        for (let z = Math.max(z0, Math.ceil(pz - outer)); z <= Math.min(z1, Math.floor(pz + outer)); z++) {
          for (let x = Math.max(x0, Math.ceil(px - outer)); x <= Math.min(x1, Math.floor(px + outer)); x++) {
            const d = Math.hypot(x - px, z - pz);
            if (d >= outer) continue;
            const f = (d <= core ? 1 : 1 - (d - core) / er) * wk;
            const k = ((z - z0) * vw + (x - x0)) * 4 + 1;
            if (f > out[k]) out[k] = f;
          }
        }
      }
    }
    // skirts copy their border vertex
    copySkirts(out, 4, vw, vh);
  }

  private rebuildSkirt() {
    const w = this.world;
    const s = w.size;
    const gb = new GeoBuilder();
    const wb = new GeoBuilder();
    const bottom = this.bottom;
    const edge = (x0: number, z0: number, x1: number, z1: number, nx: number, nz: number) => {
      const h0 = w.vh(x0, z0), h1 = w.vh(x1, z1);
      const mid0 = Math.min(h0 - 0.6, -1.5), mid1 = Math.min(h1 - 0.6, -1.5);
      const q = (ya0: number, ya1: number, yb0: number, yb1: number) => {
        if (nx + nz > 0) gb.quad(x0, ya0, z0, x1, ya1, z1, x1, yb1, z1, x0, yb0, z0);
        else gb.quad(x1, ya1, z1, x0, ya0, z0, x0, yb0, z0, x1, yb1, z1);
      };
      gb.color(0x4e4234);
      q(bottom, bottom, Math.max(bottom, mid0), Math.max(bottom, mid1));
      gb.color(0x7a6448);
      q(Math.max(bottom, mid0), Math.max(bottom, mid1), h0, h1);
      if (h0 < WATER_Y || h1 < WATER_Y) {
        wb.color(0x2c6f86);
        const a0 = Math.min(h0, WATER_Y), a1 = Math.min(h1, WATER_Y);
        if (nx + nz > 0) wb.quad(x0, a0, z0, x1, a1, z1, x1, WATER_Y, z1, x0, WATER_Y, z0);
        else wb.quad(x1, a1, z1, x0, a0, z0, x0, WATER_Y, z0, x1, WATER_Y, z1);
      }
    };
    for (let i = 0; i < s; i++) {
      edge(i, 0, i + 1, 0, 0, -1);
      edge(i, s, i + 1, s, 0, 1);
      edge(0, i, 0, i + 1, -1, 0);
      edge(s, i, s, i + 1, 1, 0);
    }
    const g = gb.build();
    if (this.skirt) { this.skirt.geometry.dispose(); this.skirt.geometry = g; }
    else {
      this.skirt = new THREE.Mesh(g, new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, side: THREE.DoubleSide }));
      this.skirt.receiveShadow = true;
      this.group.add(this.skirt);
    }
    const wgeo = wb.build();
    if (this.waterSides) { this.waterSides.geometry.dispose(); this.waterSides.geometry = wgeo; }
    else {
      this.waterSides = new THREE.Mesh(wgeo, new THREE.MeshStandardMaterial({ vertexColors: true, transparent: true, opacity: 0.75, roughness: 0.2, side: THREE.DoubleSide }));
      this.group.add(this.waterSides);
    }
  }

  /** Triangles currently submitted per pass (for stats). */
  triangles(): number {
    let n = 0;
    for (const m of this.chunks) if (m && m.visible) n += m.geometry.drawRange.count / 3;
    for (const G of this.groups) if (G.active && G.mesh) n += G.mesh.geometry.drawRange.count / 3;
    return Math.round(n);
  }

  dispose() {
    for (const f of this.info) { if (!f) continue; f.geo0.dispose(); for (const c of f.coarse) c?.dispose(); }
    for (const G of this.groups) for (const g of G.geos) g?.dispose();
    this.skirt?.geometry.dispose();
    this.waterSides?.geometry.dispose();
    this.water.geometry.dispose();
    this.base.geometry.dispose();
    this.heightTex.dispose();
    this.waterMat.dispose();
    this.material.dispose();
  }
}

// ------------------------------------------------------------------------------------ picking

export interface V3 { x: number; y: number; z: number }

/**
 * Exact intersection of a ray with the visible surface max(terrain, WATER_Y) inside the map.
 * The terrain is piecewise planar between the lines x = int, z = int and x - z = int (the cell
 * diagonals of World.heightAt), so the ray is walked across those lines and each piece is solved
 * linearly. Returns false when the ray misses the map (or enters it through the side walls).
 */
export function raycastTerrain(w: World, o: V3, d: V3, maxH: number, out: V3, maxT = 1e5): boolean {
  const s = w.size;
  let t0 = 0, t1 = maxT;
  const clip = (oc: number, dc: number) => {
    if (Math.abs(dc) < 1e-12) return oc >= 0 && oc <= s;
    let a = (0 - oc) / dc, b = (s - oc) / dc;
    if (a > b) { const t = a; a = b; b = t; }
    if (a > t0) t0 = a;
    if (b < t1) t1 = b;
    return true;
  };
  if (!clip(o.x, d.x) || !clip(o.z, d.z) || t0 >= t1) return false;
  const top = Math.max(maxH, WATER_Y) + 1e-3;
  if (d.y < 0) { const tt = (top - o.y) / d.y; if (tt > t0) t0 = tt; }
  else if (o.y + d.y * t0 > top) return false;
  if (d.y > 0) t1 = Math.min(t1, (top - o.y) / d.y);
  if (t0 >= t1) return false;
  const terr = (t: number) => w.heightAt(o.x + d.x * t, o.z + d.z * t);
  let t = t0;
  let gT = o.y + d.y * t - terr(t), gW = o.y + d.y * t - WATER_Y;
  if (gT <= 0 || gW <= 0) return false; // entered below the surface: side wall or camera underground
  const dw = d.x - d.z;
  const nextLine = (v: number, dv: number) => (dv > 0 ? Math.floor(v) + 1 : Math.ceil(v) - 1);
  let ix = nextLine(o.x + d.x * t, d.x), iz = nextLine(o.z + d.z * t, d.z), iw = nextLine(o.x - o.z + dw * t, dw);
  let tx = Math.abs(d.x) > 1e-12 ? (ix - o.x) / d.x : Infinity;
  let tz = Math.abs(d.z) > 1e-12 ? (iz - o.z) / d.z : Infinity;
  let tw = Math.abs(dw) > 1e-12 ? (iw - (o.x - o.z)) / dw : Infinity;
  for (let guard = 0; guard < 8 * s + 16; guard++) {
    const tn = Math.min(tx, tz, tw, t1);
    const nT = o.y + d.y * tn - terr(tn), nW = o.y + d.y * tn - WATER_Y;
    if (nT <= 0 || nW <= 0) {
      let th = Infinity;
      if (nT <= 0) th = t + (gT / (gT - nT)) * (tn - t);
      if (nW <= 0) th = Math.min(th, t + (gW / (gW - nW)) * (tn - t));
      out.x = o.x + d.x * th; out.z = o.z + d.z * th;
      out.y = Math.max(w.heightAt(out.x, out.z), WATER_Y);
      return true;
    }
    if (tn >= t1) return false;
    t = tn; gT = nT; gW = nW;
    if (tx <= tn) { ix += d.x > 0 ? 1 : -1; tx = (ix - o.x) / d.x; }
    if (tz <= tn) { iz += d.z > 0 ? 1 : -1; tz = (iz - o.z) / d.z; }
    if (tw <= tn) { iw += dw > 0 ? 1 : -1; tw = (iw - (o.x - o.z)) / dw; }
  }
  return false;
}

// ------------------------------------------------------------------------------------ materials

/** Vertex decode of the compact chunk positions (height stored in 1/128 units). */
const DECODE = `vec3 transformed = vec3(position.x, position.y * ${(1 / YQ).toFixed(10)}, position.z);`;

/**
 * Terrain shading: procedural detail texture layers (grass, dirt, scree, rock, sand; see terrain-tex.ts) at
 * two world scales blended by view distance, combined by height so transitions follow clumps and stones;
 * triplanar rock only on truly steep natural ground; earthworks as grass with soil patches; sand only next to
 * water (aux.w) with a crisp wet band; per-pixel macro colour variation; whiteout-blended detail normals.
 */
function createTerrainMaterial(U: TerrainUniforms): THREE.MeshStandardMaterial {
  // the sky environment adds a blue cast to steep, sun-averted slopes: keep it modest on the ground
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, envMapIntensity: 0.5 });
  const det = detailTextures();
  const extra = {
    uDetA: { value: det.albedo },
    uDetN: { value: det.normal },
    uMacro: { value: det.macro },
    uDetMean: { value: det.mean.map((m) => new THREE.Vector3(m[0], m[1], m[2])) },
  };
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U, extra);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aAux;
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec4 vAux;`)
      .replace('#include <begin_vertex>', `${DECODE}
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vAux = aAux;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uGrid; uniform vec4 uHiRect; uniform vec3 uHiColor; uniform float uHiOn;
uniform vec4 uCircle; uniform vec3 uCircleColor; uniform float uSnow; uniform float uTime;
uniform sampler2DArray uDetA;
uniform sampler2DArray uDetN;
uniform sampler2D uMacro;
uniform vec3 uDetMean[5];
varying vec3 vWPos; varying vec3 vWNormal; varying vec4 vAux;
${NOISE_GLSL}
// one detail layer: albedo (linear rgb) + height, tangent normal xy (-1..1) + cavity + roughness
struct RfL { vec4 a; vec4 n; };
// planar (top) projection at the mid scale, detail of the near scale multiplied in close to the camera
// the near scale is rotated 37 degrees against the mid scale (no aligned repetition): its normals turn back
const mat2 RF_NROT = mat2(0.7986, -0.6018, 0.6018, 0.7986);
RfL rfPlanar(float l, vec2 uvM, vec2 gxM, vec2 gyM, vec2 uvN, vec2 gxN, vec2 gyN, float wN) {
  RfL r;
  r.a = textureGrad(uDetA, vec3(uvM, l), gxM, gyM);
  r.n = textureGrad(uDetN, vec3(uvM, l), gxM, gyM);
  r.n.xy = r.n.xy * 2.0 - 1.0;
  if (wN > 0.003) {
    vec4 a2 = textureGrad(uDetA, vec3(uvN, l), gxN, gyN);
    vec4 n2 = textureGrad(uDetN, vec3(uvN, l), gxN, gyN);
    r.a.rgb *= mix(vec3(1.0), a2.rgb / max(uDetMean[int(l)], vec3(1e-3)), wN * 0.6);
    r.a.a = mix(r.a.a, a2.a, wN * 0.5);
    r.n.xy += RF_NROT * (n2.xy * 2.0 - 1.0) * wN * 0.6;
    r.n.z = mix(r.n.z, r.n.z * n2.z / 0.8, wN);
    r.n.w = mix(r.n.w, n2.w, wN * 0.5);
  }
  return r;
}
// coverage t of layer b over a, following their heights (crisp but organic transitions)
float rfHB(float ha, float hb, float t) {
  float a = ha + (1.0 - t) * 1.5, b = hb + t * 1.5;
  float m = max(a, b) - 0.2;
  float wa = max(a - m, 0.0), wb = max(b - m, 0.0);
  return wb / (wa + wb);
}`)
      .replace('#include <map_fragment>', `
vec3 rfGlow = vec3(0.0);
float rfRough = 0.95;
vec3 rfNrm = normalize(vWNormal);
{
  vec2 p = vWPos.xz;
  float h = vWPos.y;
  vec3 gN = normalize(vWNormal);
  float slope = 1.0 - gN.y;
  float vd = length(vViewPosition);
  vec3 dpx = dFdx(vWPos), dpy = dFdy(vWPos);
  float fw = max(length(fwidth(p)), 1e-4);

  // macro variation per pixel (two scales): no per-vertex blotches at coarse LODs
  vec4 M = texture2D(uMacro, p * 0.0019);
  vec4 M2 = texture2D(uMacro, p * 0.0077 + vec2(0.41, 0.73));
  float nb = M2.z - 0.5;
  float works = clamp(vAux.y, 0.0, 1.0), forest = clamp(vAux.x, 0.0, 1.0), shore = clamp(vAux.w, 0.0, 1.0);
  float above = h;
  float moist = max(shore * 0.7, 1.0 - smoothstep(0.3, 2.5, h));

  // two world scales: mid (5.3 units) everywhere, near (1.35 units) detail close to the camera
  const float SM = 0.1887, SN = 0.7407, SR = 0.2778;
  const mat2 RN = mat2(0.7986, 0.6018, -0.6018, 0.7986);
  vec2 uvM = p * SM + vec2(0.37, 0.11), uvN = (RN * p) * SN + vec2(0.71, 0.23);
  vec2 gxM = dpx.xz * SM, gyM = dpy.xz * SM, gxN = (RN * dpx.xz) * SN, gyN = (RN * dpy.xz) * SN;
  float wN = 1.0 - smoothstep(10.0, 30.0, vd);
  // far away the tiled detail fades into the layer's mean colour (no repetition patterns)
  float farF = smoothstep(15.0, 85.0, vd) * 0.85;
  // alpine zone: drier, yellower short grass, more scree and rock outcrops - never paler than the meadow
  float alp = smoothstep(uSnow * 0.5, uSnow * 0.9, h + (M.x - 0.5) * 3.0);

  // ---- layer weights
  // rock only on truly steep natural ground (from ~48 degrees), never on earthworks; scree patches below it
  float wRock = smoothstep(0.33 - 0.09 * alp, 0.47 - 0.09 * alp, slope + nb * 0.12) * (1.0 - works);
  float wScree = smoothstep(0.27 - 0.12 * alp, 0.39 - 0.12 * alp, slope + nb * 0.16) * smoothstep(0.45 - 0.25 * alp, 0.7 - 0.25 * alp, M.z + nb * 0.5) * (1.0 - works);
  // exposed soil on steep grass, soil patches on cut / fill slopes, forest floor under trees
  float wDirt = smoothstep(0.18, 0.32, slope + nb * 0.25) * 0.4 * (1.0 - works);
  wDirt = max(wDirt, works * (0.16 + 0.42 * smoothstep(0.05, 0.3, slope)) * smoothstep(0.3, 0.7, M2.x + nb * 0.7));
  wDirt = max(wDirt, smoothstep(0.15, 0.75, forest) * 0.55);
  // beaches: next to water, low and gentle only
  float wSand = shore * (1.0 - smoothstep(0.25, 0.6, above + nb * 0.3)) * (1.0 - smoothstep(0.1, 0.22, slope));
  wSand = max(wSand, (1.0 - smoothstep(-0.06, 0.0, above)) * 0.85);

  // ---- grass base, tinted by region (lush / fresh / dry / alpine / young grass on earthworks)
  RfL G = rfPlanar(0.0, uvM, gxM, gyM, uvN, gxN, gyN, wN);
  vec3 tint = mix(vec3(1.42, 1.42, 1.6), vec3(0.85, 1.02, 1.05), smoothstep(0.35, 0.75, M.x));
  tint = mix(tint, vec3(2.2, 1.45, 2.4), smoothstep(0.5, 0.82, M.y * 0.65 + M2.y * 0.35) * 0.55 * (1.0 - moist * 0.8));
  tint *= mix(vec3(1.0), vec3(1.1, 0.92, 0.78), alp * 0.75);
  tint = mix(tint, vec3(1.55, 1.48, 1.75), works * 0.5);
  tint *= mix(1.0, 0.8, forest * 0.6) * (0.93 + 0.14 * M2.w);
  vec3 col = mix(G.a.rgb, uDetMean[0], farF) * tint;
  float hgt = G.a.a;
  vec2 nT = G.n.xy * 0.45 * (1.0 - farF);
  float cav = G.n.z, rough = G.n.w;
  float t;
  // ---- dirt / forest floor
  if (wDirt > 0.01) {
    RfL D = rfPlanar(1.0, uvM, gxM, gyM, uvN, gxN, gyN, wN);
    t = rfHB(hgt, D.a.a, wDirt);
    vec3 dt = mix(vec3(1.08, 1.04, 1.0), vec3(0.82, 0.92, 0.62), smoothstep(0.1, 0.6, forest)) * (0.92 + 0.16 * M2.w);
    col = mix(col, mix(D.a.rgb, uDetMean[1], farF) * dt, t); hgt = mix(hgt, D.a.a, t); nT = mix(nT, D.n.xy * (1.0 - farF), t); cav = mix(cav, D.n.z, t); rough = mix(rough, D.n.w, t);
  }
  // ---- scree
  if (wScree > 0.01) {
    RfL S = rfPlanar(2.0, uvM * 1.6, gxM * 1.6, gyM * 1.6, uvN * 1.6, gxN * 1.6, gyN * 1.6, wN);
    t = rfHB(hgt, S.a.a, wScree);
    col = mix(col, S.a.rgb * vec3(0.86, 0.83, 0.79), t); hgt = mix(hgt, S.a.a, t); nT = mix(nT, S.n.xy, t); cav = mix(cav, S.n.z, t); rough = mix(rough, S.n.w, t);
  }
  // planar detail normal over the geometric normal (whiteout)
  vec2 nT2 = nT * 0.9;
  float tz = sqrt(max(0.0, 1.0 - dot(nT2, nT2) * 0.25));
  vec3 nW = normalize(vec3(gN.x + nT2.x, gN.y * tz, gN.z + nT2.y));
  // ---- rock: triplanar (strata stay horizontal on cliff faces), darker warm grey-brown
  if (wRock > 0.01) {
    vec3 bw = pow(abs(gN), vec3(4.0));
    bw /= bw.x + bw.y + bw.z;
    vec3 sg = sign(gN);
    vec2 uX = vec2(vWPos.z * sg.x, vWPos.y) * SR, uY = vec2(vWPos.x * sg.y, vWPos.z) * SR, uZ = vec2(-vWPos.x * sg.z, vWPos.y) * SR;
    vec2 gxX = vec2(dpx.z * sg.x, dpx.y) * SR, gyX = vec2(dpy.z * sg.x, dpy.y) * SR;
    vec2 gxY = vec2(dpx.x * sg.y, dpx.z) * SR, gyY = vec2(dpy.x * sg.y, dpy.z) * SR;
    vec2 gxZ = vec2(-dpx.x * sg.z, dpx.y) * SR, gyZ = vec2(-dpy.x * sg.z, dpy.y) * SR;
    vec4 rA = vec4(0.0), rNx = vec4(0.5, 0.5, 0.8, 0.8), rNy = rNx, rNz = rNx;
    if (bw.x > 0.02) { rA += textureGrad(uDetA, vec3(uX, 3.0), gxX, gyX) * bw.x; rNx = textureGrad(uDetN, vec3(uX, 3.0), gxX, gyX); }
    if (bw.y > 0.02) { rA += textureGrad(uDetA, vec3(uY, 3.0), gxY, gyY) * bw.y; rNy = textureGrad(uDetN, vec3(uY, 3.0), gxY, gyY); }
    if (bw.z > 0.02) { rA += textureGrad(uDetA, vec3(uZ, 3.0), gxZ, gyZ) * bw.z; rNz = textureGrad(uDetN, vec3(uZ, 3.0), gxZ, gyZ); }
    rA /= max(1e-3, (bw.x > 0.02 ? bw.x : 0.0) + (bw.y > 0.02 ? bw.y : 0.0) + (bw.z > 0.02 ? bw.z : 0.0));
    // whiteout per projection (normal maps' x flipped with the mirrored uvs)
    vec2 tx = (rNx.xy * 2.0 - 1.0) * 1.1, ty = (rNy.xy * 2.0 - 1.0) * 1.1, tzz = (rNz.xy * 2.0 - 1.0) * 1.1;
    tx.x *= sg.x; ty.x *= sg.y; tzz.x *= -sg.z;
    vec3 nX = vec3(tx + gN.zy, abs(gN.x)), nY = vec3(ty + gN.xz, abs(gN.y)), nZ = vec3(tzz + gN.xy, abs(gN.z));
    vec3 nR = normalize(nX.zyx * vec3(sg.x, 1.0, 1.0) * bw.x + nY.xzy * vec3(1.0, sg.y, 1.0) * bw.y + nZ.xyz * vec3(1.0, 1.0, sg.z) * bw.z);
    float rCav = rNx.z * bw.x + rNy.z * bw.y + rNz.z * bw.z, rRough = rNx.w * bw.x + rNy.w * bw.y + rNz.w * bw.z;
    t = rfHB(hgt, rA.a, wRock);
    col = mix(col, rA.rgb * vec3(0.78, 0.73, 0.66) * (0.9 + 0.2 * M2.w), t);
    hgt = mix(hgt, rA.a, t); nW = normalize(mix(nW, nR, t)); cav = mix(cav, rCav, t); rough = mix(rough, rRough, t);
  }
  // ---- beaches, wet band at the waterline, sea bed
  if (wSand > 0.01) {
    RfL B = rfPlanar(4.0, uvM, gxM, gyM, uvN, gxN, gyN, wN);
    t = rfHB(hgt, B.a.a, wSand);
    col = mix(col, B.a.rgb * vec3(0.95, 0.94, 0.9), t); hgt = mix(hgt, B.a.a, t); cav = mix(cav, B.n.z, t); rough = mix(rough, B.n.w, t);
    vec2 sb = B.n.xy * 0.6;
    nW = normalize(mix(nW, normalize(vec3(gN.x + sb.x, gN.y, gN.z + sb.y)), t));
  }
  float wet = (1.0 - smoothstep(0.0, 0.06, above)) * smoothstep(0.15, 0.4, shore);
  col *= mix(1.0, 0.6, wet);
  rough = mix(rough, 0.32, wet);
  col = mix(col, col * vec3(0.55, 0.6, 0.6), 1.0 - smoothstep(-0.5, -0.03, above));
  // micro occlusion from the detail cavity, gentle ridge / hollow shading from the vertex cavity
  col *= clamp(0.35 + 0.8 * cav, 0.55, 1.08);
  col *= 1.0 + clamp(vAux.z, -1.0, 1.0) * 0.04 * (1.0 - works);
  // snow above the snow line, not on cliffs
  // snow above the snow line (mountainous maps only), crisp edge following the surface detail; on steeper
  // slopes it keeps to the hollows and rock shows through on faces; albedo ~0.8 (sRGB) so it stays shaded
  float snowAmt = smoothstep(uSnow - 0.1, uSnow + 0.25, h + (M.x - 0.5) * 2.5 + nb * 0.6 + (hgt - 0.5) * 0.6);
  snowAmt *= 1.0 - smoothstep(0.24, 0.4, slope + (hgt - 0.5) * 0.25);
  col = mix(col, vec3(0.6, 0.63, 0.68) * (0.93 + 0.1 * hgt), snowAmt);
  nW = normalize(mix(nW, gN, snowAmt * 0.35));
  rough = mix(rough, 0.72, snowAmt);
  // crack-hiding skirts (vertical faces under chunk borders): shade as a small earth step, not a streak
  vec3 fc = cross(dpx, dpy);
  vec3 fN = dot(fc, fc) > 1e-24 ? normalize(fc) : gN;
  float skirtF = (1.0 - smoothstep(0.2, 0.4, abs(fN.y))) * smoothstep(0.35, 0.6, gN.y);
  col = mix(col, uDetMean[1] * 0.8, skirtF);
  nW = normalize(mix(nW, fN, skirtF));
  rfNrm = nW;
  rfRough = rough;

  if (uHiOn > 0.5) {
    vec2 dd = min(p - uHiRect.xy, uHiRect.zw - p);
    float md = min(dd.x, dd.y);
    if (md >= 0.0) {
      float edge = 1.0 - smoothstep(fw, fw * 2.5, md);
      col = mix(col, uHiColor, 0.25 + edge * 0.6);
      rfGlow += uHiColor * (0.05 + edge * 0.3);
    }
  }
  if (uCircle.w > 0.5) {
    float d = length(p - uCircle.xy);
    float ring = 1.0 - smoothstep(fw, fw * 2.5, abs(d - uCircle.z));
    float inside = 1.0 - step(uCircle.z, d);
    col = mix(col, uCircleColor, inside * 0.15 + ring * 0.8);
    rfGlow += uCircleColor * (inside * 0.03 + ring * 0.3);
  }
  if (uGrid > 0.5) {
    vec2 gw = fwidth(p);
    vec2 g1 = 1.0 - smoothstep(gw * 0.5, gw * 1.5, abs(fract(p + 0.5) - 0.5));
    float minor = max(g1.x, g1.y) * (1.0 - smoothstep(0.08, 0.25, fw));
    vec2 g10 = 1.0 - smoothstep(gw * 0.75, gw * 2.0, abs(fract(p / 10.0 + 0.5) - 0.5) * 10.0);
    float major = max(g10.x, g10.y) * (1.0 - smoothstep(0.8, 2.5, fw));
    float hw = max(fwidth(h), 1e-4);
    float c1 = (1.0 - smoothstep(hw * 0.6, hw * 1.6, abs(fract(h + 0.5) - 0.5))) * (1.0 - smoothstep(0.25, 0.8, hw));
    float c5 = 1.0 - smoothstep(hw * 0.8, hw * 2.0, abs(fract(h / 5.0 + 0.5) - 0.5) * 5.0);
    col = mix(col, vec3(0.0), minor * 0.22);
    col = mix(col, vec3(0.01), major * 0.4);
    col = mix(col, rf_srgb(vec3(0.98, 0.92, 0.62)), max(c1 * 0.35, c5 * 0.5));
    rfGlow += rf_srgb(vec3(0.98, 0.92, 0.62)) * max(c1, c5) * 0.04;
  }
  diffuseColor.rgb = col;
}`)
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = rfRough;')
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
normal = normalize((viewMatrix * vec4(rfNrm, 0.0)).xyz);`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rfGlow;');
  };
  mat.customProgramCacheKey = () => 'rf-terrain-v8';
  return mat;
}

function createWaterMaterial(heightTex: THREE.Texture, size: number): THREE.ShaderMaterial {
  const uniforms = THREE.UniformsUtils.merge([
    THREE.UniformsLib.fog,
    {
      uHeight: { value: null },
      uSize: { value: size },
      uTime: { value: 0 },
      uSunDir: { value: new THREE.Vector3(0.5, 0.8, 0.3).normalize() },
      uSunColor: { value: new THREE.Color(1, 0.95, 0.85) },
      uSkyColor: { value: new THREE.Color(0.35, 0.55, 0.85) },
      uHorizon: { value: new THREE.Color(0.75, 0.82, 0.9) },
      uLight: { value: 1 },
    },
  ]);
  uniforms.uHeight.value = heightTex;
  return new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    fog: true,
    vertexShader: /* glsl */ `
      varying vec3 vWPos;
      #include <common>
      #include <fog_pars_vertex>
      void main() {
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWPos = wp.xyz;
        vec4 mvPosition = viewMatrix * wp;
        gl_Position = projectionMatrix * mvPosition;
        #include <fog_vertex>
      }`,
    fragmentShader: /* glsl */ `
      uniform sampler2D uHeight; uniform float uSize; uniform float uTime;
      uniform vec3 uSunDir; uniform vec3 uSunColor; uniform vec3 uSkyColor; uniform vec3 uHorizon; uniform float uLight;
      varying vec3 vWPos;
      #include <common>
      #include <fog_pars_fragment>
      ${NOISE_GLSL}
      // value noise with analytic derivatives
      vec3 rfNoiseD(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        vec2 u = f * f * (3.0 - 2.0 * f), du = 6.0 * f * (1.0 - f);
        float a = rf_hash12(i), b = rf_hash12(i + vec2(1.0, 0.0)), c = rf_hash12(i + vec2(0.0, 1.0)), d = rf_hash12(i + vec2(1.0, 1.0));
        float k1 = b - a, k2 = c - a, k4 = a - b - c + d;
        return vec3(a + k1 * u.x + k2 * u.y + k4 * u.x * u.y, du * vec2(k1 + k4 * u.y, k2 + k4 * u.x));
      }
      void main() {
        vec2 uv = (vWPos.xz + 0.5) / (uSize + 1.0);
        float th = texture2D(uHeight, uv).r;
        float depth = max(vWPos.y - th, 0.0);
        vec2 p = vWPos.xz;
        float fw = max(length(fwidth(p)), 1e-4);
        // calmer water in the shallows
        float calm = 0.45 + 0.55 * smoothstep(0.0, 0.6, depth);
        vec2 g = vec2(0.0);
        g += rfNoiseD(p * 0.18 + vec2(uTime * 0.02, uTime * 0.013)).yz * 0.18 * 0.5;
        g += rfNoiseD(p * 0.9 - vec2(uTime * 0.07, -uTime * 0.05)).yz * 0.9 * 0.06 * (1.0 - smoothstep(0.3, 0.7, fw * 0.9));
        g += rfNoiseD(p * 3.3 + vec2(-uTime * 0.21, uTime * 0.17)).yz * 3.3 * 0.012 * (1.0 - smoothstep(0.3, 0.7, fw * 3.3));
        g += rfNoiseD(p * 11.0 + vec2(uTime * 0.5, uTime * 0.37)).yz * 11.0 * 0.003 * (1.0 - smoothstep(0.3, 0.7, fw * 11.0));
        g *= calm;
        vec3 N = normalize(vec3(-g.x, 1.0, -g.y));
        vec3 V = normalize(cameraPosition - vWPos);
        float fres = 0.03 + 0.97 * pow(1.0 - max(dot(N, V), 0.0), 5.0);
        // depth-graded colour: red is absorbed first, so the shallows show the (sandy) bottom with a turquoise
        // tint and deep water turns dark blue-green (depth in units of 10 m)
        vec3 absorb = exp(-depth * vec3(6.0, 2.4, 1.5));
        vec3 deep = vec3(0.008, 0.045, 0.075);
        vec3 shallow = vec3(0.09, 0.33, 0.31);
        vec3 col = mix(deep, shallow, absorb.g);
        float lit = 0.25 + 0.75 * max(uSunDir.y, 0.0);
        col *= lit * uLight + 0.03;
        vec3 R = reflect(-V, N);
        vec3 refl = mix(uHorizon, uSkyColor, clamp(R.y * 1.8, 0.0, 1.0)) * uLight;
        col = mix(col, refl, clamp(fres, 0.0, 0.85));
        float spec = pow(max(dot(R, uSunDir), 0.0), 240.0) * 4.0 + pow(max(dot(R, uSunDir), 0.0), 24.0) * 0.12;
        col += uSunColor * spec * step(0.0, uSunDir.y);
        // foam: a crisp line at the waterline, lapping in and out, and a fainter line just offshore
        float foamVis = 1.0 - smoothstep(0.15, 0.6, fw * 6.0);
        float lap = 0.5 + 0.5 * sin(uTime * 0.9 + p.x * 0.6 + p.y * 0.45);
        float fn = foamVis > 0.0 ? rf_vnoise(p * 7.0 + vec2(uTime * 0.5, -uTime * 0.4)) : 0.5;
        float line = 1.0 - smoothstep(0.0, 0.03 + 0.025 * lap, depth);
        float foam = line * smoothstep(0.3, 0.6, fn + line * 0.45);
        float off = 1.0 - smoothstep(0.0, 0.012, abs(depth - (0.07 + 0.03 * lap)));
        foam = max(foam, off * smoothstep(0.5, 0.75, fn) * 0.55 * foamVis);
        foam *= mix(0.45, 1.0, foamVis);
        col = mix(col, vec3(0.82, 0.86, 0.88) * max(uLight, 0.15), foam * 0.75);
        float alpha = 1.0 - absorb.b * 0.72;
        alpha = max(alpha, foam * 0.85);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
