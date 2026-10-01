// Terrain chunks (1 vertex per world unit, distance LOD), map-edge skirts, water surface and exact ray picking.
import * as THREE from 'three';
import { World, TERRAIN_CHUNK, OBJ_CHUNK } from '../game/world';
import { WATER_Y } from '../game/constants';
import { NOISE_GLSL } from './shaders';
import { GeoBuilder } from './geo';

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
const SKIRT = 4;
/** LOD steps (vertex spacing 1, 2, 4, 8 units). */
const LODS = 4;
/** Render chunk size (a multiple of the world's TERRAIN_CHUNK dirty-tracking size): few draw calls. */
export const RENDER_CHUNK = 128;
/**
 * Pixels per world unit below which a chunk drops to the next coarser level. Conservative: coarse cells
 * cannot follow 1-unit earthworks (cuttings would cover tracks), so they only start below ~4 px per unit.
 */
const LOD_PPU = [4, 2, 1];

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

interface ChunkInfo { x0: number; z0: number; x1: number; z1: number; minY: number; maxY: number; lod: number; range: number; ix: ChunkIndex }
const NEIGH = [-1, 0, 1, 0, 0, -1, 0, 1];

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
  private bottom = -6;
  /** object chunks already seen dirty (their trees/edges feed the terrain attributes) */
  private objSeen = new Set<number>();
  private auxDirty = new Set<number>();
  private geoDirty = new Set<number>();
  private edgeH: Float32Array;
  private camPos = new THREE.Vector3();
  private saved = new THREE.Vector2();
  /** minimum LOD used when the terrain casts shadows */
  shadowLod = 1;

  constructor(public world: World) {
    const s = world.size;
    this.nc = Math.ceil(s / RENDER_CHUNK);
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
      const wn = Math.ceil(w.size / TERRAIN_CHUNK), f = RENDER_CHUNK / TERRAIN_CHUNK;
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
        this.fillHeights(cz * RENDER_CHUNK, Math.min(w.size, (cz + 1) * RENDER_CHUNK));
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
        for (let cz = Math.max(0, Math.floor((oz - m) / RENDER_CHUNK)); cz <= Math.min(this.nc - 1, Math.floor((oz + OBJ_CHUNK + m) / RENDER_CHUNK)); cz++)
          for (let cx = Math.max(0, Math.floor((ox - m) / RENDER_CHUNK)); cx <= Math.min(this.nc - 1, Math.floor((ox + OBJ_CHUNK + m) / RENDER_CHUNK)); cx++) this.auxDirty.add(cz * this.nc + cx);
      }
      for (const oc of this.objSeen) if (!w.dirtyObj.has(oc)) this.objSeen.delete(oc);
    }
    if (this.auxDirty.size) {
      for (const ci of [...this.auxDirty]) {
        this.auxDirty.delete(ci);
        this.refreshAux(ci);
        if (performance.now() - t0 > this.budgetMs) break;
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
    for (let ci = 0; ci < this.info.length; ci++) {
      const f = this.info[ci], m = this.chunks[ci];
      if (!m) continue;
      const cx = ci % n, cz = Math.floor(ci / n);
      let skirt = f.lod > 0;
      if (!skirt) for (let k = 0; k < 8; k += 2) {
        const nx = cx + NEIGH[k], nz = cz + NEIGH[k + 1];
        if (nx >= 0 && nz >= 0 && nx < n && nz < n && this.info[nz * n + nx].lod > 0) { skirt = true; break; }
      }
      const key = f.lod * 2 + (skirt ? 1 : 0);
      if (key === f.range) continue;
      f.range = key;
      const r = skirt ? f.ix.full[f.lod] : f.ix.grid[f.lod];
      m.geometry.setDrawRange(r[0], r[1]);
    }
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
    const x0 = cx * RENDER_CHUNK, z0 = cz * RENDER_CHUNK;
    return { x0, z0, x1: Math.min(s, x0 + RENDER_CHUNK), z1: Math.min(s, z0 + RENDER_CHUNK) };
  }

  buildChunk(ci: number) {
    const w = this.world;
    const { x0, z0, x1, z1 } = this.bounds(ci);
    const vw = x1 - x0 + 1, vh = z1 - z0 + 1;
    const nv = vw * vh, total = nv + 2 * (vw + vh);
    const pos = new Float32Array(total * 3);
    const nrm = new Float32Array(total * 3);
    let k = 0, minY = Infinity, maxY = -Infinity;
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) {
      const y = w.vh(x, z);
      pos[k * 3] = x; pos[k * 3 + 1] = y; pos[k * 3 + 2] = z;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
      const dx = (w.vh(x + 1, z) - w.vh(x - 1, z)) * 0.5;
      const dz = (w.vh(x, z + 1) - w.vh(x, z - 1)) * 0.5;
      const l = Math.hypot(dx, 1, dz);
      nrm[k * 3] = -dx / l; nrm[k * 3 + 1] = 1 / l; nrm[k * 3 + 2] = -dz / l;
      k++;
    }
    // skirt vertices below the border (copy normals so they shade like the surface)
    const skirtOf = (src: number) => {
      pos[k * 3] = pos[src * 3]; pos[k * 3 + 1] = pos[src * 3 + 1] - SKIRT; pos[k * 3 + 2] = pos[src * 3 + 2];
      nrm[k * 3] = nrm[src * 3]; nrm[k * 3 + 1] = nrm[src * 3 + 1]; nrm[k * 3 + 2] = nrm[src * 3 + 2];
      k++;
    };
    for (let i = 0; i < vw; i++) skirtOf(i);
    for (let i = 0; i < vw; i++) skirtOf((vh - 1) * vw + i);
    for (let j = 0; j < vh; j++) skirtOf(j * vw);
    for (let j = 0; j < vh; j++) skirtOf(j * vw + vw - 1);
    const aux = new Float32Array(total * 3);
    this.computeAux(x0, z0, x1, z1, aux);
    const ix = chunkIndex(vw, vh);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    g.setAttribute('aAux', new THREE.BufferAttribute(aux, 3));
    g.setIndex(ix.index);
    g.setDrawRange(ix.grid[0][0], ix.grid[0][1]);
    g.boundingBox = new THREE.Box3(new THREE.Vector3(x0, minY - SKIRT, z0), new THREE.Vector3(x1, maxY, z1));
    g.boundingSphere = g.boundingBox.getBoundingSphere(new THREE.Sphere());
    this.info[ci] = { x0, z0, x1, z1, minY, maxY, lod: 0, range: 0, ix };
    let m = this.chunks[ci];
    if (m) { m.geometry.dispose(); m.geometry = g; }
    else {
      m = new THREE.Mesh(g, this.material);
      m.receiveShadow = true;
      m.castShadow = true;
      m.matrixAutoUpdate = false;
      // shadow casting only needs the silhouette: draw a coarser level (with skirts) in the shadow pass
      const mesh = m, idx = ci;
      mesh.onBeforeShadow = () => {
        const f = this.info[idx];
        const r = f.ix.full[Math.min(LODS - 1, Math.max(f.lod, this.shadowLod))];
        const dr = mesh.geometry.drawRange;
        this.saved.set(dr.start, dr.count);
        mesh.geometry.setDrawRange(r[0], r[1]);
      };
      mesh.onAfterShadow = () => { mesh.geometry.setDrawRange(this.saved.x, this.saved.y); };
      this.chunks[ci] = m;
      this.group.add(m);
    }
  }

  /** Recompute only the vegetation / earthwork / cavity attribute of a chunk. */
  private refreshAux(ci: number) {
    const m = this.chunks[ci];
    if (!m) return;
    const { x0, z0, x1, z1 } = this.bounds(ci);
    const a = m.geometry.getAttribute('aAux') as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    arr.fill(0);
    this.computeAux(x0, z0, x1, z1, arr);
    a.needsUpdate = true;
  }

  /**
   * Per-vertex attributes: x forest density (dark forest floor under tree clusters), y earthworks
   * (cuttings/embankments next to network edges on the ground), z cavity (height above the local mean).
   */
  private computeAux(x0: number, z0: number, x1: number, z1: number, out: Float32Array) {
    const w = this.world, net = w.net;
    const vw = x1 - x0 + 1, vh = z1 - z0 + 1;
    // cavity from a summed-area table over the chunk plus a margin
    const R = 3, aw = vw + 2 * R, ah = vh + 2 * R, sw = aw + 1;
    const sat = new Float64Array(sw * (ah + 1));
    for (let j = 0; j < ah; j++) {
      let row = 0;
      for (let i = 0; i < aw; i++) { row += w.vh(x0 - R + i, z0 - R + j); sat[(j + 1) * sw + i + 1] = sat[j * sw + i + 1] + row; }
    }
    const D = 2 * R + 1, inv = 1 / (D * D);
    for (let j = 0; j < vh; j++) for (let i = 0; i < vw; i++) {
      const sum = sat[(j + D) * sw + i + D] - sat[j * sw + i + D] - sat[(j + D) * sw + i] + sat[j * sw + i];
      const c = w.vh(x0 + i, z0 + j) - sum * inv;
      out[(j * vw + i) * 3 + 2] = Math.max(-1, Math.min(1, c * 0.7));
    }
    // forest floor
    const TR = 1.8;
    for (const id of w.treeGrid.query(x0 - TR, z0 - TR, x1 + TR, z1 + TR)) {
      const t = w.trees[id];
      if (!t) continue;
      for (let z = Math.max(z0, Math.ceil(t.z - TR)); z <= Math.min(z1, Math.floor(t.z + TR)); z++) {
        for (let x = Math.max(x0, Math.ceil(t.x - TR)); x <= Math.min(x1, Math.floor(t.x + TR)); x++) {
          const d = Math.hypot(x - t.x, z - t.z);
          if (d < TR) out[((z - z0) * vw + (x - x0)) * 3] += (1 - d / TR) * 0.4 * t.s;
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
            const k = ((z - z0) * vw + (x - x0)) * 3 + 1;
            if (f > out[k]) out[k] = f;
          }
        }
      }
    }
    // skirts copy their border vertex
    const nv = vw * vh;
    let k = nv;
    const cp = (src: number) => { out[k * 3] = out[src * 3]; out[k * 3 + 1] = out[src * 3 + 1]; out[k * 3 + 2] = out[src * 3 + 2]; k++; };
    for (let i = 0; i < vw; i++) cp(i);
    for (let i = 0; i < vw; i++) cp((vh - 1) * vw + i);
    for (let j = 0; j < vh; j++) cp(j * vw);
    for (let j = 0; j < vh; j++) cp(j * vw + vw - 1);
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
    for (const m of this.chunks) if (m) n += m.geometry.drawRange.count / 3;
    return Math.round(n);
  }

  dispose() {
    for (const m of this.chunks) m?.geometry.dispose();
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

function createTerrainMaterial(U: TerrainUniforms): THREE.MeshStandardMaterial {
  // the sky environment adds a blue cast to steep, sun-averted slopes: keep it modest on the ground
  const mat = new THREE.MeshStandardMaterial({ roughness: 0.95, metalness: 0, envMapIntensity: 0.55 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, U);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec3 aAux;
varying vec3 vWPos;
varying vec3 vWNormal;
varying vec3 vAux;
varying vec2 vMacro;
${NOISE_GLSL}`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vWPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
vWNormal = normalize(mat3(modelMatrix) * objectNormal);
vAux = aAux;
// large-scale variation is smooth over a cell: evaluate per vertex
vMacro = vec2(rf_fbm(vWPos.xz * 0.006 + 3.1), rf_fbm(vWPos.xz * 0.03 + 11.7));`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform float uGrid; uniform vec4 uHiRect; uniform vec3 uHiColor; uniform float uHiOn;
uniform vec4 uCircle; uniform vec3 uCircleColor; uniform float uSnow; uniform float uTime;
varying vec3 vWPos; varying vec3 vWNormal; varying vec3 vAux; varying vec2 vMacro;
${NOISE_GLSL}
// value noise projected on the three axis planes, weighted by the normal
float rf_tri(vec3 q, vec3 w) { return rf_vnoise(q.zy) * w.x + rf_vnoise(q.xz) * w.y + rf_vnoise(q.xy) * w.z; }`)
      .replace('#include <map_fragment>', `
vec3 rfGlow = vec3(0.0);
float rfRough = 0.95;
float rfBump = 0.0;
{
  vec2 p = vWPos.xz;
  float h = vWPos.y;
  float slope = 1.0 - normalize(vWNormal).y;
  float fw = max(length(fwidth(p)), 1e-4);
  float m0 = vMacro.x, m1 = vMacro.y;
  // octaves fade out before they alias (keep >= ~5 px per cycle)
  float n2 = rf_vnoise(p * 0.21 + 5.3);
  float d3 = 1.0 - smoothstep(0.2, 0.5, fw * 1.13);
  float d4 = 1.0 - smoothstep(0.2, 0.5, fw * 4.7);
  float d5 = 1.0 - smoothstep(0.2, 0.5, fw * 19.0);
  float d6 = 1.0 - smoothstep(0.2, 0.5, fw * 67.0);
  float n3 = d3 > 0.0 ? rf_vnoise(p * 1.13 + 1.7) : 0.5;
  float n4 = d4 > 0.0 ? rf_vnoise(p * 4.7 + 9.1) : 0.5;
  float n5 = d5 > 0.0 ? rf_vnoise(p * 19.0 + 3.3) : 0.5;
  float n6 = d6 > 0.0 ? rf_vnoise(p * 67.0) : 0.5;
  n3 = mix(0.5, n3, d3); n4 = mix(0.5, n4, d4); n5 = mix(0.5, n5, d5); n6 = mix(0.5, n6, d6);
  float detail = (n3 - 0.5) * 0.5 + (n4 - 0.5) * 0.35 + (n5 - 0.5) * 0.25 + (n6 - 0.5) * 0.2;

  vec3 lush   = rf_srgb(vec3(0.29, 0.43, 0.16));
  vec3 fresh  = rf_srgb(vec3(0.40, 0.52, 0.20));
  vec3 dryG   = rf_srgb(vec3(0.57, 0.55, 0.31));
  vec3 alpine = rf_srgb(vec3(0.46, 0.48, 0.31));
  vec3 forest = rf_srgb(vec3(0.23, 0.25, 0.13));
  vec3 dirt   = rf_srgb(vec3(0.43, 0.36, 0.26));
  vec3 soil   = rf_srgb(vec3(0.38, 0.35, 0.23));
  vec3 young  = rf_srgb(vec3(0.39, 0.45, 0.21));
  vec3 scree  = rf_srgb(vec3(0.56, 0.51, 0.43));
  vec3 rockA  = rf_srgb(vec3(0.54, 0.50, 0.44));
  vec3 rockB  = rf_srgb(vec3(0.63, 0.58, 0.50));
  vec3 sand   = rf_srgb(vec3(0.79, 0.73, 0.55));
  vec3 wetS   = rf_srgb(vec3(0.50, 0.45, 0.35));
  vec3 mud    = rf_srgb(vec3(0.30, 0.29, 0.22));
  vec3 snow   = rf_srgb(vec3(0.92, 0.94, 0.97));

  // meadows: regional dry/lush variation, greener near water, alpine grass higher up
  float moist = 1.0 - smoothstep(0.3, 2.5, h);
  vec3 col = mix(fresh, lush, smoothstep(0.35, 0.7, m1));
  col = mix(col, dryG, smoothstep(0.5, 0.78, m0 + (n2 - 0.5) * 0.25) * 0.6 * (1.0 - moist * 0.7));
  col = mix(col, lush, moist * 0.3);
  col = mix(col, alpine, smoothstep(uSnow * 0.45, uSnow * 0.85, h + (m1 - 0.5) * 4.0) * 0.8);
  col *= 0.9 + 0.2 * n2;
  col *= 1.0 + detail * 0.2;
  col = mix(col, col * vec3(1.12, 1.06, 0.78), smoothstep(0.55, 0.85, n5) * d5 * 0.45);
  // forest floor under tree clusters
  float fo = smoothstep(0.12, 0.8, vAux.x + (n3 - 0.5) * 0.2);
  col = mix(col, forest * (0.85 + 0.25 * n4 + 0.15 * n2), fo * 0.85);
  // ridges catch light, hollows collect shade (not on earthworks: embankments would glow)
  float works = clamp(vAux.y, 0.0, 1.0);
  col *= 1.0 + clamp(vAux.z, -1.0, 1.0) * 0.05 * (1.0 - works);
  // graded ground beside tracks and roads: young grass and disturbed soil, mostly on the cut/fill slopes
  float sn = (n2 - 0.5) * 0.08 + (m1 - 0.5) * 0.06;
  float wSlope = smoothstep(0.04, 0.15, slope + sn * 0.5);
  float wk = works * works * (0.22 + 0.33 * wSlope);
  vec3 worksCol = mix(young, soil, clamp(0.3 + 0.45 * wSlope + (n3 - 0.5) * 0.4, 0.0, 1.0)) * (0.9 + 0.2 * n4);
  col = mix(col, worksCol, wk);
  // exposed soil on steep grass
  float dirtAmt = smoothstep(0.12, 0.24, slope + sn) * 0.3;
  col = mix(col, dirt * (0.88 + 0.2 * n3 + 0.1 * n2), dirtAmt);
  // scree and rock on steep slopes: warm grey-brown, crisp ledges and cracks (triplanar, so cliff
  // faces are not smeared vertically)
  // soft transition starting around 40 degrees: moderately steep grass stays green
  float rockAmt = smoothstep(0.25, 0.42, slope + sn * 0.8);
  float rockBump = 0.0;
  if (rockAmt > 0.001) {
    vec3 an = abs(normalize(vWNormal));
    an /= an.x + an.y + an.z;
    float f1 = 1.0 - smoothstep(0.2, 0.55, fw * 0.6), f2 = 1.0 - smoothstep(0.2, 0.55, fw * 2.3);
    float r1 = rf_tri(vWPos * 0.6 + 3.7, an);
    float r2 = f2 > 0.0 ? rf_tri(vWPos * 2.3 + 9.1, an) : 0.5;
    // cracks and ledges: a subtle darkening, only for close-ups (camera within ~15 units)
    float closeUp = 1.0 - smoothstep(10.0, 15.0, length(vViewPosition));
    float c1 = pow(1.0 - abs(2.0 * r1 - 1.0), 6.0) * f1 * closeUp, c2 = pow(1.0 - abs(2.0 * r2 - 1.0), 8.0) * f2 * closeUp;
    vec3 rock = mix(rockA, rockB, smoothstep(0.25, 0.75, n2 * 0.45 + mix(0.5, r1, f1) * 0.55));
    rock *= (1.0 - c1 * 0.1 - c2 * 0.06) * (0.95 + 0.1 * mix(0.5, r2, f2));
    vec3 scr = scree * (0.92 + 0.16 * n4) * (1.0 - c2 * 0.05);
    col = mix(col, mix(scr, rock, smoothstep(0.3, 0.48, slope + sn)), rockAmt);
    rockBump = (mix(0.5, r1, f1) * 0.03 + mix(0.5, r2, f2) * 0.012 - (c1 * 0.02 + c2 * 0.008)) * rockAmt;
  }
  // beaches, wet sand, sea bed
  float beach = (1.0 - smoothstep(0.08, 0.3, h + (n2 - 0.5) * 0.15)) * (1.0 - smoothstep(0.12, 0.3, slope));
  col = mix(col, sand * (0.93 + 0.12 * n4), beach);
  float wet = 1.0 - smoothstep(-0.02, 0.05, h);
  col = mix(col, wetS, wet * 0.75);
  col = mix(col, mud, 1.0 - smoothstep(-0.4, -0.05, h));
  // snow above the snow line, not on cliffs
  float snowAmt = smoothstep(uSnow, uSnow + 2.5, h + (m1 - 0.5) * 5.0 + (n2 - 0.5)) * (1.0 - smoothstep(0.3, 0.5, slope));
  col = mix(col, snow * (0.96 + 0.05 * n4), snowAmt);
  rfRough = mix(mix(0.95, 0.6, snowAmt), 0.5, wet);
  // micro relief for close-ups (rock and soil rougher than grass)
  rfBump = (detail * 0.01 * (1.0 + dirtAmt) * (1.0 - rockAmt) + rockBump) * (1.0 - snowAmt * 0.6);

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
{
  // bump from the procedural micro relief (screen-space derivatives)
  vec3 sx = dFdx(-vViewPosition), sy = dFdy(-vViewPosition);
  vec2 dh = vec2(dFdx(rfBump), dFdy(rfBump));
  vec3 r1 = cross(sy, normal), r2 = cross(normal, sx);
  float det = dot(sx, r1) * faceDirection;
  vec3 grad = sign(det) * (dh.x * r1 + dh.y * r2);
  vec3 bn = abs(det) * normal - grad;
  if (dot(bn, bn) > 1e-30) normal = normalize(bn);
}`)
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += rfGlow;');
  };
  mat.customProgramCacheKey = () => 'rf-terrain-v3';
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
        vec3 deep = vec3(0.010, 0.05, 0.085);
        vec3 shallow = vec3(0.06, 0.25, 0.25);
        vec3 col = mix(shallow, deep, smoothstep(0.0, 0.7, depth));
        float lit = 0.25 + 0.75 * max(uSunDir.y, 0.0);
        col *= lit * uLight + 0.03;
        vec3 R = reflect(-V, N);
        vec3 refl = mix(uHorizon, uSkyColor, clamp(R.y * 1.8, 0.0, 1.0)) * uLight;
        col = mix(col, refl, clamp(fres, 0.0, 0.85));
        float spec = pow(max(dot(R, uSunDir), 0.0), 240.0) * 4.0 + pow(max(dot(R, uSunDir), 0.0), 24.0) * 0.12;
        col += uSunColor * spec * step(0.0, uSunDir.y);
        float shore = 1.0 - smoothstep(0.0, 0.02, depth);
        float foamVis = 1.0 - smoothstep(0.15, 0.6, fw * 6.0);
        float foamN = foamVis > 0.0 ? rf_vnoise(p * 6.0 + vec2(uTime * 0.6, -uTime * 0.45)) : 0.0;
        float foam = shore * mix(0.12, smoothstep(0.45, 0.8, foamN + shore * 0.25), foamVis);
        col = mix(col, vec3(0.8, 0.84, 0.86) * max(uLight, 0.15), foam * 0.55);
        float alpha = mix(0.55, 0.95, smoothstep(0.0, 0.4, depth));
        alpha = max(alpha, foam * 0.75);
        gl_FragColor = vec4(col, alpha);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
        #include <fog_fragment>
      }`,
  });
}
