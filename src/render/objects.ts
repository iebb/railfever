// Static world objects: tracks, roads, structures, stations, depots, buildings and trees.
// Content is built per object chunk (OBJ_CHUNK = 32, the dirty unit) and rendered per 64-unit super-chunk:
// one world-material mesh (ground pieces receive only, structures and facades cast via aCast; buildings in
// a full and a simplified version, switched by draw range), one detail mesh (rails, masts, lamps,
// furniture; hidden at a distance), night glow points, and trees (instanced per variant near the camera,
// impostors far away). Buildings are built per chunk quarter and reused while a quarter's buildings
// don't change (town growth only rebuilds the quarter that changed).
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Network } from '../game/network';
import { OBJ_CHUNK, pointInRect } from '../game/world';
import type { Building, World } from '../game/world';
import { WATER_Y } from '../game/constants';
import { GeoBuilder } from './geo';
import { Materials } from './materials';
import { WB, mergeGeos, farPart, concatFar, FarPart } from './build-mesh';
import { Drape } from './build-drape';
import { ChunkCtx, SignalLamp, Boom, XLight, chunkIndexOf, hexToInt, stationEdgeLevels } from './build-common';
import { buildRailEdge, buildRailNode } from './build-rail';
import { buildRoadEdge, buildRoadNode, buildBusStops, buildCrossing } from './build-road';
import { buildStation, buildDepot } from './build-stations';
import { portalKeepouts, inKeepout, Keepout } from './build-structures';
import { buildBuilding, FacadeBuilder } from './build-buildings';
import { createTreeGeometries, createImpostorGeometries, IMPOSTOR_KINDS, makeTreeMesh, nearTreeData, makeImpostorMesh, impostorData, treeVariant, TreeInstance } from './trees';

/** Object chunks per super-chunk side. */
const SC = 2;
/** Super-chunks per near-tree region side (128 units): near trees are drawn per region and variant. */
const IR = 2;
/** Super-chunks per impostor region side (512 units): all trees of the region, split from the near models in the shader. */
const IRF = 8;
/** Super-chunks per far world region side (256 units): compact baked copy of the region, drawn instead of its super-chunks. */
const RS = 4;
/** Camera distance to a far world region's box beyond which its compact copy is drawn. */
export const REGION_DIST = 280;
/** Camera distance (to the super-chunk box) beyond which detail meshes are hidden. */
export const DETAIL_DIST = 75;
/** Camera distance beyond which trees switch to impostors. */
export const TREE_DIST = 125;
/** Super-chunks this far outside the view frustum still get near trees (shadows into the view, turning). */
const TREE_MARGIN = 10;
/** Camera distance beyond which buildings switch to their simplified version (facade boxes, plain roofs). */
export const BLD_DIST = 105;
/** Camera height above ground beyond which signal/crossing lamps are hidden. */
const LAMP_DIST = 160;

/** Buildings (and parks/plazas) of one chunk quarter. */
interface BQ {
  /** signature of the quarter's buildings and of the terrain under them */
  sig: number;
  /** full buildings (near LOD only), parks/plazas (always), simplified buildings (far LOD only) */
  near: THREE.BufferGeometry | null;
  always: THREE.BufferGeometry | null;
  far: THREE.BufferGeometry | null;
  detail: THREE.BufferGeometry | null;
  lights: number[];
  trees: TreeInstance[];
  /** compact far copy of `always` + `far` */
  farPart: FarPart | null;
  /** detail built (details are only kept for super-chunks near the camera) */
  hasDetail: boolean;
}

/** What a chunk build produces: everything, the world layer only (no details), or details only. */
type BuildMode = 'full' | 'world' | 'detail';

interface ChunkOut {
  world: THREE.BufferGeometry | null;
  /** compact far copy of `world` */
  netFar: FarPart | null;
  bq: BQ[];
  hasDetail: boolean;
  detail: THREE.BufferGeometry | null;
  lights: number[];
  lamps: SignalLamp[];
  booms: Boom[];
  xl: XLight[];
  trees: TreeInstance[];
}

interface Super {
  group: THREE.Group;
  meshes: THREE.Object3D[];
  /** signature of the trees (instance data is kept while they don't change) */
  treeSig: number;
  treeBox: THREE.Box3;
  /** near tree instance data per variant, far impostor instance data */
  nearM: Float32Array[] | null;
  nearC: Float32Array[] | null;
  /** far impostor instances per kind (broadleaf, conifer) */
  farM: Float32Array[] | null;
  farC: Float32Array[] | null;
  detail: THREE.Mesh | null;
  /** details of all its chunks are built (they are built when the camera comes near, dropped when it leaves) */
  detailBuilt: boolean;
  /**
   * World mesh with index ranges [near buildings | static world | far buildings]: near LOD draws the first
   * two, far LOD the last two (one draw call either way, no duplicated geometry).
   */
  world: THREE.Mesh | null;
  nA: number;
  nB: number;
  nC: number;
  bldFar: boolean | null;
  box: THREE.Box3;
  empty: boolean;
  detailOn: boolean;
  nearOn: boolean;
}

const GREEN = new THREE.Color(0.25, 1.9, 0.5), RED = new THREE.Color(2.2, 0.16, 0.1);
const XRED = new THREE.Color(2.4, 0.15, 0.08), XOFF = new THREE.Color(0.18, 0.03, 0.03);
const EMPTY_OUT = (): ChunkOut => ({ world: null, netFar: null, bq: [], hasDetail: false, detail: null, lights: [], lamps: [], booms: [], xl: [], trees: [] });

/** Far world region (RS x RS super-chunks). */
interface FarRegion { mesh: THREE.Mesh | null; glow: THREE.Points | null; dirty: boolean; far: boolean; box: THREE.Box3 }
const okGeo = (g: THREE.BufferGeometry | null): g is THREE.BufferGeometry => !!g && g.getAttribute('position').count > 0;

export interface ObjectStats { calls: number; shadowCalls: number; triangles: number; instances: number; meshes: number }

export class ObjectsView {
  group = new THREE.Group();
  private n: number;
  private ns: number;
  private outs: ChunkOut[];
  private supers: Super[];
  private treeGeos: THREE.BufferGeometry[];
  private impGeos: THREE.BufferGeometry[];
  private dynDirty = true;
  private lampMesh: THREE.InstancedMesh | null = null;
  private lampList: SignalLamp[] = [];
  private boomMesh: THREE.InstancedMesh | null = null;
  private boomList: Boom[] = [];
  private boomPos = new Map<number, number>(); // crossing id -> raised fraction (1 up, 0 down)
  private xlMesh: THREE.InstancedMesh | null = null;
  private xlList: XLight[] = [];
  private time = 0;
  private sigTimer = 0;
  private boomGeo: THREE.BufferGeometry;
  private lampGeo: THREE.BufferGeometry;
  private camPos = new THREE.Vector3();
  private hasCam = false;
  /** super-chunks waiting for their details */
  private detailQueue = new Set<number>();
  /** per chunk: hash of the terrain heights under it and a 2-unit margin (draped roads reach over the border) */
  private tsig: Float64Array;
  private hv = -1;
  /** camera frustum: near trees only for super-chunks in (or close to) the view */
  private frustum = new THREE.Frustum();
  private fm = new THREE.Matrix4();
  private vbox = new THREE.Box3();
  /** builders reused for every chunk build (their buffers grow once) */
  private wb = new WB();
  private db = new WB();
  private bn = new WB();
  private bf = new WB();
  private ba = new WB();
  private bd = new WB();
  private bfac = new FacadeBuilder(this.bn);
  private bafac = new FacadeBuilder(this.ba);
  /** near-tree regions (IR x IR super-chunks each): one instanced mesh per variant over the near super-chunks */
  private nr: number;
  private regions: { near: (THREE.InstancedMesh | null)[]; ncap: number[]; dirty: boolean }[];
  /** impostor regions (IRF x IRF super-chunks): every tree of the region (the shader hides the near ones) */
  private nri: number;
  private impRegions: { mesh: (THREE.InstancedMesh | null)[]; cap: number[]; dirty: boolean }[];
  /** far world regions (RS x RS super-chunks) */
  private nl: number;
  private fregions: FarRegion[];

  constructor(public game: Game, public mats: Materials) {
    this.n = Math.ceil(game.world.size / OBJ_CHUNK);
    this.ns = Math.ceil(this.n / SC);
    this.outs = Array.from({ length: this.n * this.n }, EMPTY_OUT);
    this.tsig = new Float64Array(this.n * this.n).fill(-1);
    this.supers = Array.from({ length: this.ns * this.ns }, () => ({
      group: new THREE.Group(), meshes: [], treeSig: -1, treeBox: new THREE.Box3(), nearM: null, nearC: null, farM: null, farC: null, detail: null, detailBuilt: false,
      world: null, nA: 0, nB: 0, nC: 0, bldFar: null, box: new THREE.Box3(), empty: true, detailOn: true, nearOn: true,
    }));
    for (const s of this.supers) { s.group.matrixAutoUpdate = false; this.group.add(s.group); }
    this.nr = Math.ceil(this.ns / IR);
    this.treeGeos = createTreeGeometries();
    this.regions = Array.from({ length: this.nr * this.nr }, () => ({ near: this.treeGeos.map(() => null), ncap: this.treeGeos.map(() => 0), dirty: true }));
    this.nri = Math.ceil(this.ns / IRF);
    this.impRegions = Array.from({ length: this.nri * this.nri }, () => ({ mesh: new Array(IMPOSTOR_KINDS).fill(null), cap: new Array(IMPOSTOR_KINDS).fill(0), dirty: true }));
    this.nl = Math.ceil(this.ns / RS);
    this.fregions = Array.from({ length: this.nl * this.nl }, () => ({ mesh: null, glow: null, dirty: true, far: false, box: new THREE.Box3() }));
    mats.uniforms.uTreeDist.value = TREE_DIST;
    this.impGeos = createImpostorGeometries();
    // barrier boom: red/white bar along +x from the pivot, unit length
    const bg = new GeoBuilder();
    for (let i = 0; i < 6; i++) { bg.color(i % 2 ? 0xffffff : 0xd0302a); bg.box((i + 0.5) / 6, -0.009, 0, 1 / 6, 0.018, 0.016, 1, 0, false); }
    this.boomGeo = bg.build();
    this.lampGeo = new THREE.SphereGeometry(0.018, 8, 6);
    this.group.name = 'objects';
  }

  buildAll() {
    // details follow for the super-chunks near the camera (update())
    for (let i = 0; i < this.outs.length; i++) this.outs[i] = this.buildChunk(i, 'world');
    for (let i = 0; i < this.supers.length; i++) this.buildSuper(i);
    this.updateRegions();
    for (let i = 0; i < this.fregions.length; i++) this.buildFarRegion(i);
    this.dynDirty = true;
    this.game.world.dirtyObj.clear();
    this.hv = this.game.world.heightsVersion;
  }

  /** Hash of the terrain heights of chunk ci and a 2-unit margin around it. */
  private terrainHash(ci: number): number {
    const w = this.game.world, S = w.size, s1 = S + 1, n = this.n;
    const bits = new Uint32Array(w.h.buffer, w.h.byteOffset, w.h.length);
    const cx = ci % n, cz = Math.floor(ci / n);
    const x0 = Math.max(0, cx * OBJ_CHUNK - 2), x1 = Math.min(S, (cx + 1) * OBJ_CHUNK + 2);
    const z0 = Math.max(0, cz * OBJ_CHUNK - 2), z1 = Math.min(S, (cz + 1) * OBJ_CHUNK + 2);
    let h = 2166136261;
    for (let z = z0; z <= z1; z++) for (let i = z * s1 + x0, e = z * s1 + x1; i <= e; i++) h = Math.imul(h ^ bits[i], 16777619);
    return h >>> 0;
  }

  /** Terrain changed: neighbours of dirty chunks whose margin heights changed rebuild too (draped roads). */
  private markTerrainNeighbours() {
    const w = this.game.world, n = this.n;
    if (w.heightsVersion === this.hv) return;
    this.hv = w.heightsVersion;
    for (const c of [...w.dirtyObj]) {
      if (c < 0 || c >= this.outs.length) continue;
      const cx = c % n, cz = Math.floor(c / n);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const x = cx + dx, z = cz + dz;
        if ((dx === 0 && dz === 0) || x < 0 || z < 0 || x >= n || z >= n) continue;
        const nj = z * n + x;
        if (w.dirtyObj.has(nj) || this.tsig[nj] < 0) continue;
        if (this.terrainHash(nj) !== this.tsig[nj]) w.dirtyObj.add(nj);
      }
    }
  }

  /** Rebuild dirty chunks within a time budget (ms); their super-chunks are re-merged right away. */
  update(budgetMs = 6) {
    const w = this.game.world;
    const start = performance.now();
    if (w.dirtyObj.size) this.markTerrainNeighbours();
    if (w.dirtyObj.size) {
      const supers = new Set<number>();
      for (const c of [...w.dirtyObj]) {
        w.dirtyObj.delete(c);
        if (c < 0 || c >= this.outs.length) continue;
        this.outs[c] = this.buildChunk(c, this.supers[this.superOf(c)].detailBuilt ? 'full' : 'world');
        supers.add(this.superOf(c));
        if (performance.now() - start > budgetMs) break;
      }
      for (const s of supers) this.buildSuper(s);
      this.updateRegions();
      this.dynDirty = true;
    }
    // details for the super-chunks the camera came near (nearest first)
    if (this.detailQueue.size) {
      const order = [...this.detailQueue].sort((a, b) => this.supers[a].box.distanceToPoint(this.camPos) - this.supers[b].box.distanceToPoint(this.camPos));
      for (const si of order) {
        if (performance.now() - start > budgetMs) return;
        this.detailQueue.delete(si);
        this.buildDetail(si);
      }
    }
    // far region copies: shown ones first, within what is left of the budget (stale copies stay meanwhile)
    for (const pass of [true, false]) {
      for (let i = 0; i < this.fregions.length; i++) {
        const R = this.fregions[i];
        if (!R.dirty || R.far !== pass) continue;
        if (performance.now() - start > budgetMs) return;
        this.buildFarRegion(i);
      }
    }
  }

  /** Rebuild one object chunk and its super-chunk immediately (its far region copy follows in update()). */
  rebuildChunk(ci: number) {
    this.outs[ci] = this.buildChunk(ci, this.supers[this.superOf(ci)].detailBuilt ? 'full' : 'world');
    this.buildSuper(this.superOf(ci));
    this.updateRegions();
    this.dynDirty = true;
  }

  /** Build the details of a super-chunk's chunks and merge its detail mesh. */
  private buildDetail(si: number) {
    const s = this.supers[si];
    if (s.detailBuilt) return;
    for (const ci of this.chunksOf(si)) if (!this.outs[ci].hasDetail) this.outs[ci] = this.buildChunk(ci, 'detail');
    s.detailBuilt = true;
    this.mergeDetail(si);
  }

  /** Drop the details of a super-chunk the camera has left (memory). */
  private dropDetail(si: number) {
    const s = this.supers[si];
    s.detailBuilt = false;
    for (const ci of this.chunksOf(si)) {
      const o = this.outs[ci];
      o.detail = null; o.hasDetail = false;
      for (const q of o.bq) { q.detail = null; q.hasDetail = false; }
    }
    this.mergeDetail(si);
  }

  private chunksOf(si: number): number[] {
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    const out: number[] = [];
    for (let dz = 0; dz < SC; dz++) for (let dx = 0; dx < SC; dx++) {
      const cx = sx * SC + dx, cz = sz * SC + dz;
      if (cx < this.n && cz < this.n) out.push(cz * this.n + cx);
    }
    return out;
  }

  /** (Re)merge a super-chunk's detail mesh from its chunks. */
  private mergeDetail(si: number) {
    const s = this.supers[si];
    if (s.detail) { s.group.remove(s.detail); disposeObj(s.detail); s.meshes = s.meshes.filter((m) => m !== s.detail); s.detail = null; }
    const DL: THREE.BufferGeometry[] = [];
    for (const ci of this.chunksOf(si)) {
      const o = this.outs[ci];
      if (okGeo(o.detail)) DL.push(o.detail);
      for (const q of o.bq) if (okGeo(q.detail)) DL.push(q.detail);
    }
    const det = mergeGeos(DL);
    if (det) {
      freeAfterUpload(det);
      const m = new THREE.Mesh(det, this.mats.world);
      m.castShadow = false; m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.visible = s.detailOn;
      s.group.add(m); s.meshes.push(m);
      s.detail = m;
      s.box.union(det.boundingBox!);
      s.empty = false;
    }
  }

  private farRegionOf(si: number) {
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    return Math.floor(sz / RS) * this.nl + Math.floor(sx / RS);
  }

  /** (Re)build the compact copy of a far world region from its chunks' far parts, plus its night glow. */
  private buildFarRegion(li: number) {
    const R = this.fregions[li];
    R.dirty = false;
    if (R.mesh) { this.group.remove(R.mesh); R.mesh.geometry.dispose(); R.mesh = null; }
    if (R.glow) { this.group.remove(R.glow); R.glow.geometry.dispose(); R.glow = null; }
    R.box.makeEmpty();
    const lx = li % this.nl, lz = Math.floor(li / this.nl);
    const parts: (FarPart | null)[] = [];
    const lights: number[] = [];
    const n = this.n, c0x = lx * RS * SC, c0z = lz * RS * SC;
    for (let cz = c0z; cz < Math.min(n, c0z + RS * SC); cz++) for (let cx = c0x; cx < Math.min(n, c0x + RS * SC); cx++) {
      const o = this.outs[cz * n + cx];
      parts.push(o.netFar);
      for (const v of o.lights) lights.push(v);
      for (const q of o.bq) { parts.push(q.farPart); for (const v of q.lights) lights.push(v); }
    }
    const geo = concatFar(parts);
    if (geo) {
      freeAfterUpload(geo);
      const m = new THREE.Mesh(geo, this.mats.worldFar);
      m.castShadow = false; m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      m.visible = R.far;
      this.group.add(m);
      R.mesh = m;
      R.box.copy(geo.boundingBox!);
    }
    if (lights.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
      lg.computeBoundingSphere();
      const pts = new THREE.Points(lg, this.mats.glow);
      pts.renderOrder = 6;
      pts.matrixAutoUpdate = false;
      pts.visible = R.far;
      this.group.add(pts);
      R.glow = pts;
    }
    if (!R.mesh) this.setRegionFar(li, false);
  }

  /** Show a far region's compact copy instead of its super-chunks (or back). */
  private setRegionFar(li: number, far: boolean) {
    const R = this.fregions[li];
    R.far = far;
    if (R.mesh) R.mesh.visible = far;
    if (R.glow) R.glow.visible = far;
    const lx = li % this.nl, lz = Math.floor(li / this.nl);
    for (let sz = lz * RS; sz < Math.min(this.ns, lz * RS + RS); sz++) for (let sx = lx * RS; sx < Math.min(this.ns, lx * RS + RS); sx++) this.supers[sz * this.ns + sx].group.visible = !far;
  }

  private regionOf(si: number) {
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    return Math.floor(sz / IR) * this.nr + Math.floor(sx / IR);
  }

  private impRegionOf(si: number) {
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    return Math.floor(sz / IRF) * this.nri + Math.floor(sx / IRF);
  }

  /** Rewrite the tree instances (near per variant, far impostors) of regions whose near/far sets changed. */
  private updateRegions() {
    for (let ri = 0; ri < this.regions.length; ri++) {
      const R = this.regions[ri];
      if (!R.dirty) continue;
      R.dirty = false;
      const rx = ri % this.nr, rz = Math.floor(ri / this.nr);
      const all: Super[] = [];
      for (let dz = 0; dz < IR; dz++) for (let dx = 0; dx < IR; dx++) {
        const sx = rx * IR + dx, sz = rz * IR + dz;
        if (sx < this.ns && sz < this.ns) all.push(this.supers[sz * this.ns + sx]);
      }
      // near trees: one instanced mesh per variant over the near super-chunks of the region
      for (let v = 0; v < this.treeGeos.length; v++) {
        let total = 0, cnt = 0;
        for (const s of all) { if (!s.nearM) continue; const k = s.nearM[v].length / 16; total += k; if (s.nearOn) cnt += k; }
        let mesh = R.near[v];
        if (!cnt) { if (mesh) mesh.visible = false; continue; }
        if (!mesh || R.ncap[v] < cnt) {
          if (mesh) { this.group.remove(mesh); mesh.dispose(); }
          R.ncap[v] = Math.ceil(total * 1.1) + 16;
          mesh = R.near[v] = makeTreeMesh(this.treeGeos[v], this.mats.tree, R.ncap[v]);
          this.group.add(mesh);
        }
        const ma = mesh.instanceMatrix.array as Float32Array, ca = mesh.instanceColor!.array as Float32Array;
        let o = 0;
        const box = new THREE.Box3();
        for (const s of all) {
          if (!s.nearM || !s.nearOn || !s.nearM[v].length) continue;
          ma.set(s.nearM[v], o * 16);
          ca.set(s.nearC![v], o * 3);
          o += s.nearM[v].length / 16;
          box.union(s.treeBox);
        }
        mesh.count = o;
        mesh.visible = true;
        uploadInstances(mesh, o);
        mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      }
    }
    // impostors: every tree of the region (static until the region's trees change), one mesh per kind
    for (let ri = 0; ri < this.impRegions.length; ri++) {
      const R = this.impRegions[ri];
      if (!R.dirty) continue;
      R.dirty = false;
      const rx = ri % this.nri, rz = Math.floor(ri / this.nri);
      const members: Super[] = [];
      for (let sz = rz * IRF; sz < Math.min(this.ns, rz * IRF + IRF); sz++) for (let sx = rx * IRF; sx < Math.min(this.ns, rx * IRF + IRF); sx++) {
        const s = this.supers[sz * this.ns + sx];
        if (s.farM) members.push(s);
      }
      for (let kd = 0; kd < IMPOSTOR_KINDS; kd++) {
        let total = 0;
        for (const s of members) total += s.farM![kd].length / 16;
        if (!total) { if (R.mesh[kd]) R.mesh[kd]!.visible = false; continue; }
        if (!R.mesh[kd] || R.cap[kd] < total) {
          if (R.mesh[kd]) { this.group.remove(R.mesh[kd]!); R.mesh[kd]!.dispose(); }
          R.cap[kd] = Math.ceil(total * 1.05) + 64;
          R.mesh[kd] = makeImpostorMesh(this.impGeos[kd], this.mats.treeFar, R.cap[kd]);
          this.group.add(R.mesh[kd]!);
        }
        const mesh = R.mesh[kd]!;
        const ma = mesh.instanceMatrix.array as Float32Array, ca = mesh.instanceColor!.array as Float32Array;
        let o = 0;
        const box = new THREE.Box3();
        for (const s of members) {
          if (!s.farM![kd].length) continue;
          ma.set(s.farM![kd], o * 16);
          ca.set(s.farC![kd], o * 3);
          o += s.farM![kd].length / 16;
          box.union(s.treeBox);
        }
        mesh.count = o;
        mesh.visible = true;
        uploadInstances(mesh, o);
        mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
      }
    }
  }

  private superOf(ci: number) {
    const cx = ci % this.n, cz = Math.floor(ci / this.n);
    return Math.floor(cz / SC) * this.ns + Math.floor(cx / SC);
  }

  private buildChunk(ci: number, mode: BuildMode): ChunkOut {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    const n = this.n;
    const cx = ci % n, cz = Math.floor(ci / n);
    const x0 = cx * OBJ_CHUNK, z0 = cz * OBJ_CHUNK;
    const x1 = Math.min(w.size, x0 + OBJ_CHUNK), z1 = Math.min(w.size, z0 + OBJ_CHUNK);
    const W = this.wb.reset(mode === 'detail'), Dt = this.db.reset(mode === 'world');
    const ctx: ChunkCtx = {
      game: g, ci, n, x0, z0, x1, z1, w: W, d: Dt, fac: new FacadeBuilder(W),
      lights: [], sigLamps: [], booms: [], xLights: [], trees: [], stationEdges: stationEdgeLevels(g), drape: new Drape(w),
    };
    const mine = (x: number, z: number) => chunkIndexOf(x, z, n) === ci;
    const pad = 1;
    for (const id of net.grid.query(x0 - pad, z0 - pad, x1 + pad, z1 + pad)) {
      const e = net.edges.get(id);
      if (!e) continue;
      try {
        if (e.kind === 'rail') buildRailEdge(ctx, e); else buildRoadEdge(ctx, e);
      } catch (err) { console.warn('objects: edge build failed', e.id, err); }
    }
    for (const id of net.nodeGrid.query(x0 - pad, z0 - pad, x1 + pad, z1 + pad)) {
      const node = net.nodes.get(id);
      if (!node || !mine(node.x, node.z)) continue;
      try {
        if (node.kind === 'rail') buildRailNode(ctx, node); else buildRoadNode(ctx, node);
      } catch (err) { console.warn('objects: node build failed', node.id, err); }
    }
    try {
      for (const c of net.crossings.values()) buildCrossing(ctx, c);
      for (const st of g.stations.map.values()) {
        const color = hexToInt(g.company(st.owner).color);
        if (st.rail) buildStation(ctx, st, color);
        if (st.stops.length) buildBusStops(ctx, st, color);
      }
      for (const d of g.depots.map.values()) if (mine(d.x, d.z)) buildDepot(ctx, d, hexToInt(g.company(d.owner).color));
    } catch (err) { console.warn('objects: structure build failed', err); }
    // buildings by quarter; a quarter whose buildings (and the terrain) didn't change is reused
    const prev = this.outs[ci];
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    const quarters: Building[][] = [[], [], [], []];
    for (const id of w.bgrid.query(x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5)) {
      const b = w.buildings.get(id);
      if (!b || !mine(b.x, b.z)) continue;
      quarters[(b.x >= mx ? 1 : 0) + (b.z >= mz ? 2 : 0)].push(b);
    }
    const bq: BQ[] = [];
    for (let q = 0; q < 4; q++) {
      const sig = buildingsSig(quarters[q], terrainSig(w, quarters[q]), net);
      const old = prev && prev.bq[q];
      if (old && old.sig === sig) {
        if (mode === 'world' || old.hasDetail) bq.push(old);
        else bq.push(this.buildQuarter(ctx, quarters[q], sig, 'detail', old));
      } else {
        // changed buildings in a details-only pass: rebuild the chunk properly later
        if (mode === 'detail') w.dirtyObj.add(ci);
        bq.push(this.buildQuarter(ctx, quarters[q], sig, mode === 'world' ? 'world' : 'full'));
      }
    }
    // no world trees inside parks/plazas (they plant their own)
    const lots: { x: number; z: number; a: number; hw: number; hd: number }[] = [];
    for (const id of w.bgrid.query(x0 - 4, z0 - 4, x1 + 4, z1 + 4)) {
      const b = w.buildings.get(id);
      if (b && (b.type === 8 || b.type === 9)) lots.push({ x: b.x, z: b.z, a: b.angle, hw: b.w / 2 + 0.05, hd: b.d / 2 + 0.05 });
    }
    // no trees on tunnel portals, their wing walls or galleries
    const keep: Keepout[] = [];
    for (const id of net.grid.query(x0 - 8, z0 - 8, x1 + 8, z1 + 8)) {
      const e = net.edges.get(id);
      if (e && e.sections.some((q) => q.type === 'tunnel')) portalKeepouts(ctx, e, keep);
    }
    for (const id of w.treeGrid.query(x0, z0, x1, z1)) {
      const t = w.trees[id];
      if (!t || !mine(t.x, t.z)) continue;
      if (keep.length && keep.some((k) => inKeepout(k, t.x, t.z))) continue;
      if (lots.length && lots.some((l) => pointInRect(t.x, t.z, l.x, l.z, l.a, l.hw, l.hd))) continue;
      const y = w.heightAt(t.x, t.z);
      if (y < WATER_Y + 0.05) continue;
      const h = ((Math.floor(t.x * 97) * 31 + Math.floor(t.z * 89)) & 1023) / 1024;
      ctx.trees.push({ type: treeVariant(t.type, (h * 7.13) % 1), x: t.x, y: y - 0.03, z: t.z, s: t.s, rot: h * Math.PI * 2, tint: t.tint });
    }
    const kept = mode === 'detail' && prev;
    if (!kept) this.tsig[ci] = this.terrainHash(ci);
    const world = kept ? prev.world : ctx.w.empty ? null : ctx.w.build();
    return {
      world, netFar: kept ? prev.netFar : farPart([world]),
      bq, hasDetail: mode !== 'world',
      detail: ctx.d.empty ? null : ctx.d.build(),
      lights: ctx.lights, lamps: ctx.sigLamps, booms: ctx.booms, xl: ctx.xLights, trees: ctx.trees,
    };
  }

  /** Buildings of one chunk quarter: full and simplified versions, details, parks and plazas. */
  private buildQuarter(ctx: ChunkCtx, list: Building[], sig: number, mode: BuildMode, old?: BQ): BQ {
    const w = this.game.world;
    const wo = mode === 'detail' && !!old;
    const Bn = this.bn.reset(wo), Bf = this.bf.reset(wo), Ba = this.ba.reset(wo), Bd = this.bd.reset(mode === 'world');
    const qc: ChunkCtx = { ...ctx, w: Ba, d: Bd, fac: this.bafac, lights: [], trees: [], sigLamps: [], booms: [], xLights: [] };
    for (const b of list) {
      try { buildBuilding(w, b, Bn, Bd, this.bfac, qc, Bf); } catch (err) { console.warn('objects: building failed', b.id, err); }
    }
    const detail = Bd.empty ? null : Bd.build();
    if (wo) return { ...old!, detail, hasDetail: true };
    const always = Ba.empty ? null : Ba.build(), far = Bf.empty ? null : Bf.build();
    return {
      sig,
      near: Bn.empty ? null : Bn.build(), always, far, detail,
      lights: qc.lights, trees: qc.trees, farPart: farPart([always, far]), hasDetail: mode !== 'world',
    };
  }

  private buildSuper(si: number) {
    const s = this.supers[si];
    // dispose the old content
    for (const o of s.meshes) { s.group.remove(o); disposeObj(o); }
    s.meshes = [];
    s.detail = null;
    s.world = null; s.nA = s.nB = s.nC = 0; s.bldFar = null;
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    const outs: ChunkOut[] = [];
    for (let dz = 0; dz < SC; dz++) for (let dx = 0; dx < SC; dx++) {
      const cx = sx * SC + dx, cz = sz * SC + dz;
      if (cx < this.n && cz < this.n) outs.push(this.outs[cz * this.n + cx]);
    }
    const box = s.box.makeEmpty();
    const add = (o: THREE.Object3D) => { o.matrixAutoUpdate = false; s.group.add(o); s.meshes.push(o); };
    const A: THREE.BufferGeometry[] = [], B: THREE.BufferGeometry[] = [], C: THREE.BufferGeometry[] = [], DL: THREE.BufferGeometry[] = [];
    const lights: number[] = [];
    const allTrees: TreeInstance[] = [];
    for (const o of outs) {
      if (okGeo(o.world)) B.push(o.world);
      if (okGeo(o.detail)) DL.push(o.detail);
      for (const v of o.lights) lights.push(v);
      for (const t of o.trees) allTrees.push(t);
      for (const q of o.bq) {
        if (okGeo(q.near)) A.push(q.near);
        if (okGeo(q.always)) B.push(q.always);
        if (okGeo(q.far)) C.push(q.far);
        if (okGeo(q.detail)) DL.push(q.detail);
        for (const v of q.lights) lights.push(v);
        for (const t of q.trees) allTrees.push(t);
      }
    }
    const world = mergeGeos([...A, ...B, ...C]);
    if (world) {
      const m = new THREE.Mesh(world, this.mats.world);
      const cast = (world.getAttribute('aCast').array as Uint8Array).some((v) => v > 0.5);
      freeAfterUpload(world);
      m.castShadow = cast;
      m.receiveShadow = true;
      m.customDepthMaterial = this.mats.worldDepth;
      add(m);
      box.union(world.boundingBox!);
      const ic = (l: THREE.BufferGeometry[]) => l.reduce((n, g) => n + g.index!.count, 0);
      s.world = m; s.nA = ic(A); s.nB = ic(B); s.nC = ic(C);
    }
    const det = mergeGeos(DL);
    if (det) {
      freeAfterUpload(det);
      const m = new THREE.Mesh(det, this.mats.world);
      m.castShadow = false; m.receiveShadow = true;
      add(m);
      s.detail = m;
      box.union(det.boundingBox!);
    }
    if (lights.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
      lg.computeBoundingSphere();
      const pts = new THREE.Points(lg, this.mats.glow);
      pts.renderOrder = 6;
      add(pts);
    }
    // trees: rebuild the instanced meshes only when the trees of this super-chunk changed
    let sig = 0, cnt = 0;
    for (const t of allTrees) { sig = (sig * 31 + Math.round(t.x * 64) * 7 + Math.round(t.z * 64) + t.type) | 0; cnt++; }
    sig = (sig ^ (cnt * 2654435761)) | 0;
    if (sig !== s.treeSig || !cnt) {
      s.nearM = s.nearC = s.farM = s.farC = null;
      s.treeBox.makeEmpty();
      s.treeSig = sig;
      this.regions[this.regionOf(si)].dirty = true;
      this.impRegions[this.impRegionOf(si)].dirty = true;
      if (cnt) {
        const trees = allTrees;
        const nd = nearTreeData(trees, this.treeGeos.length);
        s.nearM = nd.m; s.nearC = nd.c;
        const fd = impostorData(trees, this.treeGeos, this.impGeos);
        s.farM = fd.m; s.farC = fd.c;
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        for (const t of trees) {
          if (t.x < x0) x0 = t.x; if (t.x > x1) x1 = t.x; if (t.z < z0) z0 = t.z; if (t.z > z1) z1 = t.z;
          if (t.y < y0) y0 = t.y; if (t.y + 2.5 * t.s > y1) y1 = t.y + 2.5 * t.s;
        }
        s.treeBox.set(new THREE.Vector3(x0, y0, z0), new THREE.Vector3(x1, y1, z1));
      }
    }
    if (!s.treeBox.isEmpty()) box.union(s.treeBox);
    s.empty = box.isEmpty();
    this.fregions[this.farRegionOf(si)].dirty = true;
    this.applyLod(s, si);
  }

  private applyLod(s: Super, si = -1) {
    if (s.empty) return;
    void si;
    let d = 0;
    if (this.hasCam) d = s.box.distanceToPoint(this.camPos);
    const detailOn = !this.hasCam || d < DETAIL_DIST;
    // near trees: close and in view (with a margin for shadows cast into the view and for turning)
    let nearOn = !this.hasCam || d < TREE_DIST;
    if (nearOn && this.hasCam) nearOn = this.frustum.intersectsBox(this.vbox.copy(s.box).expandByScalar(TREE_MARGIN));
    if (nearOn !== s.nearOn && s.farM) this.regions[this.regionOf(si >= 0 ? si : this.supers.indexOf(s))].dirty = true;
    s.detailOn = detailOn; s.nearOn = nearOn;
    if (s.detail) s.detail.visible = detailOn;
    // details are built when the camera comes near and dropped well after it has left
    if (si >= 0) {
      if (!s.detailBuilt && (!this.hasCam || d < DETAIL_DIST + 15)) this.detailQueue.add(si);
      else if (s.detailBuilt && this.hasCam && d > DETAIL_DIST + 90) { this.detailQueue.delete(si); this.dropDetail(si); }
      else if (s.detailBuilt) this.detailQueue.delete(si);
    }
    if (s.world && (s.nA || s.nC)) {
      // hysteresis so a camera hovering at the threshold doesn't flip every frame
      const far = this.hasCam && (s.bldFar ? d > BLD_DIST - 5 : d > BLD_DIST + 5);
      if (far !== s.bldFar) {
        s.bldFar = far;
        if (far) s.world.geometry.setDrawRange(s.nA, s.nB + s.nC);
        else s.world.geometry.setDrawRange(0, s.nA + s.nB);
      }
    }
  }

  private rebuildDynamic() {
    this.dynDirty = false;
    for (const m of [this.lampMesh, this.boomMesh, this.xlMesh]) if (m) { this.group.remove(m); m.dispose(); }
    this.lampMesh = this.boomMesh = this.xlMesh = null;
    this.lampList = []; this.boomList = []; this.xlList = [];
    for (const c of this.outs) {
      for (const l of c.lamps) this.lampList.push(l);
      for (const b of c.booms) this.boomList.push(b);
      for (const x of c.xl) this.xlList.push(x);
    }
    const m4 = new THREE.Matrix4();
    if (this.lampList.length) {
      this.lampMesh = new THREE.InstancedMesh(this.lampGeo, this.mats.lamp, this.lampList.length);
      this.lampList.forEach((l, i) => { m4.makeTranslation(l.x, l.y, l.z); this.lampMesh!.setMatrixAt(i, m4); this.lampMesh!.setColorAt(i, RED); });
      this.lampMesh.instanceMatrix.needsUpdate = true;
      this.lampMesh.computeBoundingSphere();
      this.group.add(this.lampMesh);
    }
    if (this.xlList.length) {
      this.xlMesh = new THREE.InstancedMesh(this.lampGeo, this.mats.lamp, this.xlList.length);
      this.xlList.forEach((l, i) => { m4.makeTranslation(l.x, l.y, l.z); this.xlMesh!.setMatrixAt(i, m4); this.xlMesh!.setColorAt(i, XOFF); });
      this.xlMesh.instanceMatrix.needsUpdate = true;
      this.xlMesh.computeBoundingSphere();
      this.group.add(this.xlMesh);
    }
    if (this.boomList.length) {
      this.boomMesh = new THREE.InstancedMesh(this.boomGeo, this.mats.body, this.boomList.length);
      this.boomMesh.castShadow = false;
      this.group.add(this.boomMesh);
      this.placeBooms();
    }
    this.sigTimer = 0;
  }

  private placeBooms() {
    const mesh = this.boomMesh;
    if (!mesh) return;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    this.boomList.forEach((b, i) => {
      const f = this.boomPos.get(b.crossing) ?? 1;
      e.set(0, Math.atan2(-b.dz, b.dx), f * Math.PI * 0.47, 'YXZ');
      q.setFromEuler(e);
      p.set(b.x, b.y, b.z);
      s.set(b.len, 1, 1);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
    });
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }

  /** LOD by camera distance, signals, level crossing barriers and warning lights. */
  animate(dt: number, night: number, camera?: THREE.Camera) {
    void night;
    if (this.dynDirty) this.rebuildDynamic();
    this.time += dt;
    if (camera) {
      camera.updateMatrixWorld();
      camera.getWorldPosition(this.camPos);
      this.frustum.setFromProjectionMatrix(this.fm.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
      this.hasCam = true;
      this.supers.forEach((s, i) => this.applyLod(s, i));
      this.updateRegions();
      for (let i = 0; i < this.fregions.length; i++) {
        const R = this.fregions[i];
        let far = false;
        if (R.mesh) {
          const d = R.box.distanceToPoint(this.camPos);
          far = R.far ? d > REGION_DIST - 15 : d > REGION_DIST + 15;
        }
        if (far !== R.far) this.setRegionFar(i, far);
      }
      const gy = Math.max(0, this.game.world.heightAt(this.camPos.x, this.camPos.z));
      const lampsOn = this.camPos.y - gy < LAMP_DIST;
      for (const m of [this.lampMesh, this.xlMesh, this.boomMesh]) if (m) m.visible = lampsOn;
    }
    const V = this.game.vehicles;
    this.sigTimer -= dt;
    if (this.lampMesh && this.sigTimer <= 0) {
      this.sigTimer = 0.1;
      this.lampList.forEach((l, i) => this.lampMesh!.setColorAt(i, V.getRes(l.edge) !== 0 ? RED : GREEN));
      if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
    }
    if (this.boomMesh) {
      let moved = false;
      const seen = new Set<number>();
      for (const b of this.boomList) {
        if (seen.has(b.crossing)) continue;
        seen.add(b.crossing);
        const target = V.crossingClosed.has(b.crossing) ? 0 : 1;
        const cur = this.boomPos.get(b.crossing) ?? 1;
        if (cur === target) continue;
        this.boomPos.set(b.crossing, target > cur ? Math.min(target, cur + dt * 0.6) : Math.max(target, cur - dt * 0.6));
        moved = true;
      }
      if (moved) this.placeBooms();
    }
    if (this.xlMesh) {
      const blink = Math.floor(this.time * 2) & 1;
      this.xlList.forEach((l, i) => this.xlMesh!.setColorAt(i, V.crossingClosed.has(l.crossing) && blink === l.phase ? XRED : XOFF));
      if (this.xlMesh.instanceColor) this.xlMesh.instanceColor.needsUpdate = true;
    }
  }

  /** v1 compatibility: signal colours are updated in animate(). */
  updateSignals(_v?: unknown) { /* no-op */ }

  /**
   * Draw calls / triangles this view would submit for a camera (frustum culled like three.js, LOD applied
   * as in animate). Shadow calls: shadow-casting meshes (the shadow camera frustum is not modelled).
   */
  stats(camera: THREE.Camera): ObjectStats {
    this.animate(0, 0, camera);
    const fr = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse));
    const st: ObjectStats = { calls: 0, shadowCalls: 0, triangles: 0, instances: 0, meshes: 0 };
    this.group.updateMatrixWorld(true);
    const visit = (o: THREE.Object3D) => {
      if (!o.visible) return;
      if ((o as THREE.Mesh).isMesh || (o as THREE.Points).isPoints) {
        const m = o as THREE.Mesh;
        const mat = m.material as THREE.Material;
        if (mat.visible !== false && (!m.frustumCulled || fr.intersectsObject(m))) {
          const geo = m.geometry;
          const count = (o as THREE.InstancedMesh).isInstancedMesh ? (o as THREE.InstancedMesh).count : 1;
          const full = geo.index ? geo.index.count : geo.getAttribute('position').count;
          const tri = Math.max(0, Math.min(full - geo.drawRange.start, geo.drawRange.count)) / 3;
          st.calls++;
          st.meshes++;
          if (!(o as THREE.Points).isPoints) st.triangles += tri * count;
          if (count > 1 || (o as THREE.InstancedMesh).isInstancedMesh) st.instances += count;
          if (m.castShadow) st.shadowCalls++;
        }
      }
      for (const c of o.children) visit(c);
    };
    visit(this.group);
    return st;
  }

  dispose() {
    for (const s of this.supers) {
      for (const o of s.meshes) { s.group.remove(o); disposeObj(o); }
      s.meshes = []; s.treeSig = -1; s.nearM = s.nearC = s.farM = s.farC = null;
    }
    for (const m of [this.lampMesh, this.boomMesh, this.xlMesh]) if (m) { this.group.remove(m); m.dispose(); }
    this.lampMesh = this.boomMesh = this.xlMesh = null;
    for (const R of this.regions) R.near.forEach((m, v) => { if (m) { this.group.remove(m); m.dispose(); R.near[v] = null; } });
    for (const R of this.impRegions) for (let kd = 0; kd < R.mesh.length; kd++) { const m = R.mesh[kd]; if (m) { this.group.remove(m); m.dispose(); R.mesh[kd] = null; } }
    for (const R of this.fregions) {
      if (R.mesh) { this.group.remove(R.mesh); R.mesh.geometry.dispose(); R.mesh = null; }
      if (R.glow) { this.group.remove(R.glow); R.glow.geometry.dispose(); R.glow = null; }
    }
    for (const geo of this.treeGeos) geo.dispose();
    for (const g of this.impGeos) g.dispose();
    this.boomGeo.dispose();
    this.lampGeo.dispose();
  }
}

/** Once a merged geometry is on the GPU its CPU copy is not needed (it is re-merged from chunk parts). */
function releaseArray(this: THREE.BufferAttribute) { (this as unknown as { array: unknown }).array = null; }
function freeAfterUpload(geo: THREE.BufferGeometry) {
  if (typeof document === 'undefined') return; // headless: nothing is uploaded
  for (const k in geo.attributes) (geo.attributes[k] as THREE.BufferAttribute).onUpload(releaseArray);
  if (geo.index) geo.index.onUpload(releaseArray);
}

/** Upload only the instances in use (region meshes are rewritten as super-chunks switch near / far). */
function uploadInstances(mesh: THREE.InstancedMesh, count: number) {
  const m = mesh.instanceMatrix, c = mesh.instanceColor!;
  m.clearUpdateRanges(); m.addUpdateRange(0, count * 16); m.needsUpdate = true;
  c.clearUpdateRanges(); c.addUpdateRange(0, count * 3); c.needsUpdate = true;
}

function disposeObj(o: THREE.Object3D) {
  o.traverse((c) => {
    if (c instanceof THREE.InstancedMesh) { c.dispose(); return; } // shared tree geometry stays
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}

/** Signature of the terrain heights under a set of buildings (their lots plus a margin). */
function terrainSig(w: World, list: Building[]): number {
  if (!list.length) return 0;
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const b of list) {
    const r = Math.max(b.w, b.d) / 2 + 0.8;
    if (b.x - r < x0) x0 = b.x - r; if (b.x + r > x1) x1 = b.x + r;
    if (b.z - r < z0) z0 = b.z - r; if (b.z + r > z1) z1 = b.z + r;
  }
  const S = w.size, H = w.h;
  const ix0 = Math.max(0, Math.floor(x0)), ix1 = Math.min(S, Math.ceil(x1)), iz0 = Math.max(0, Math.floor(z0)), iz1 = Math.min(S, Math.ceil(z1));
  let h = 0x811c9dc5 | 0;
  for (let z = iz0; z <= iz1; z++) {
    const row = z * (S + 1);
    for (let x = ix0; x <= ix1; x++) h = Math.imul(h ^ Math.round(H[row + x] * 4096), 16777619);
  }
  return h;
}

/**
 * Signature of a set of buildings (everything their geometry depends on) and of the terrain under them;
 * parks and plazas also depend on the roads around them (their lawns / paving keep clear of them).
 */
function buildingsSig(list: Building[], terrain: number, net: Network): number {
  let h = terrain | 0;
  const mix = (v: number) => { h = Math.imul(h ^ (v | 0), 16777619); };
  mix(list.length);
  for (const b of list) {
    mix(b.id); mix(b.type); mix(b.floors); mix(b.seed);
    mix(Math.round(b.x * 1024)); mix(Math.round(b.z * 1024)); mix(Math.round(b.angle * 65536));
    mix(Math.round(b.w * 1024)); mix(Math.round(b.d * 1024)); mix(Math.round(b.y * 1024));
    if (b.type === 8 || b.type === 9) {
      const R = Math.hypot(b.w, b.d) / 2 + 1.2;
      for (const e of net.edgesNear(b.x - R, b.z - R, b.x + R, b.z + R)) { mix(e.id); mix(e.version); }
    }
  }
  return h;
}
