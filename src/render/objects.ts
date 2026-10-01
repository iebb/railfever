// Static world objects: tracks, roads, structures, stations, depots, buildings and trees.
// Content is built per object chunk (OBJ_CHUNK = 32, the dirty unit) and rendered per 64-unit super-chunk:
// one world-material mesh (ground pieces receive only, structures cast via aCast), one facade mesh, one
// detail mesh (rails, masts, lamps, furniture; hidden at a distance), night glow points, and trees
// (instanced per variant near the camera, one impostor mesh far away).
import * as THREE from 'three';
import type { Game } from '../game/game';
import { OBJ_CHUNK } from '../game/world';
import { WATER_Y } from '../game/constants';
import { GeoBuilder } from './geo';
import { Materials } from './materials';
import { WB, mergeGeos } from './build-mesh';
import { ChunkCtx, SignalLamp, Boom, XLight, chunkIndexOf, hexToInt } from './build-common';
import { buildRailEdge, buildRailNode } from './build-rail';
import { buildRoadEdge, buildRoadNode, buildBusStops, buildCrossing } from './build-road';
import { buildStation, buildDepot } from './build-stations';
import { portalKeepouts, inKeepout, Keepout } from './build-structures';
import { buildBuilding, FacadeBuilder } from './build-buildings';
import { createTreeGeometries, createImpostorGeometry, makeTreeMeshes, makeImpostorMesh, impostorData, treeVariant, TreeInstance } from './trees';

/** Object chunks per super-chunk side. */
const SC = 2;
/** Super-chunks per far-tree impostor region side (128 units). */
const IR = 2;
/** Camera distance (to the super-chunk box) beyond which detail meshes are hidden. */
export const DETAIL_DIST = 75;
/** Camera distance beyond which trees switch to impostors. */
export const TREE_DIST = 125;
/** Camera height above ground beyond which signal/crossing lamps are hidden. */
const LAMP_DIST = 160;

interface ChunkOut {
  world: THREE.BufferGeometry | null;
  facade: THREE.BufferGeometry | null;
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
  /** tree meshes are kept across rebuilds while the trees of the super-chunk don't change */
  treeObjs: THREE.Object3D[];
  treeSig: number;
  treeBox: THREE.Box3;
  /** far impostor instance data of this super-chunk's trees */
  farM: Float32Array | null;
  farC: Float32Array | null;
  detail: THREE.Mesh | null;
  near: THREE.Group | null;
  box: THREE.Box3;
  empty: boolean;
  detailOn: boolean;
  nearOn: boolean;
}

const GREEN = new THREE.Color(0.25, 1.9, 0.5), RED = new THREE.Color(2.2, 0.16, 0.1);
const XRED = new THREE.Color(2.4, 0.15, 0.08), XOFF = new THREE.Color(0.18, 0.03, 0.03);
const EMPTY_OUT = (): ChunkOut => ({ world: null, facade: null, detail: null, lights: [], lamps: [], booms: [], xl: [], trees: [] });

export interface ObjectStats { calls: number; shadowCalls: number; triangles: number; instances: number; meshes: number }

export class ObjectsView {
  group = new THREE.Group();
  private n: number;
  private ns: number;
  private outs: ChunkOut[];
  private supers: Super[];
  private treeGeos: THREE.BufferGeometry[];
  private impGeo: THREE.BufferGeometry;
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
  /** far-tree impostor regions (IR x IR super-chunks each) */
  private nr: number;
  private regions: { mesh: THREE.InstancedMesh | null; cap: number; dirty: boolean }[];

  constructor(public game: Game, public mats: Materials) {
    this.n = Math.ceil(game.world.size / OBJ_CHUNK);
    this.ns = Math.ceil(this.n / SC);
    this.outs = Array.from({ length: this.n * this.n }, EMPTY_OUT);
    this.supers = Array.from({ length: this.ns * this.ns }, () => ({
      group: new THREE.Group(), meshes: [], treeObjs: [], treeSig: -1, treeBox: new THREE.Box3(), farM: null, farC: null, detail: null, near: null, box: new THREE.Box3(), empty: true, detailOn: true, nearOn: true,
    }));
    for (const s of this.supers) { s.group.matrixAutoUpdate = false; this.group.add(s.group); }
    this.nr = Math.ceil(this.ns / IR);
    this.regions = Array.from({ length: this.nr * this.nr }, () => ({ mesh: null, cap: 0, dirty: true }));
    this.treeGeos = createTreeGeometries();
    this.impGeo = createImpostorGeometry();
    // barrier boom: red/white bar along +x from the pivot, unit length
    const bg = new GeoBuilder();
    for (let i = 0; i < 6; i++) { bg.color(i % 2 ? 0xffffff : 0xd0302a); bg.box((i + 0.5) / 6, -0.009, 0, 1 / 6, 0.018, 0.016, 1, 0, false); }
    this.boomGeo = bg.build();
    this.lampGeo = new THREE.SphereGeometry(0.018, 8, 6);
    this.group.name = 'objects';
  }

  buildAll() {
    for (let i = 0; i < this.outs.length; i++) this.outs[i] = this.buildChunk(i);
    for (let i = 0; i < this.supers.length; i++) this.buildSuper(i);
    this.updateRegions();
    this.dynDirty = true;
    this.game.world.dirtyObj.clear();
  }

  /** Rebuild dirty chunks within a time budget (ms); their super-chunks are re-merged right away. */
  update(budgetMs = 6) {
    const w = this.game.world;
    if (!w.dirtyObj.size) return;
    const start = performance.now();
    const supers = new Set<number>();
    for (const c of [...w.dirtyObj]) {
      w.dirtyObj.delete(c);
      if (c < 0 || c >= this.outs.length) continue;
      this.outs[c] = this.buildChunk(c);
      supers.add(this.superOf(c));
      if (performance.now() - start > budgetMs) break;
    }
    for (const s of supers) this.buildSuper(s);
    this.updateRegions();
    this.dynDirty = true;
  }

  /** Rebuild one object chunk and its super-chunk immediately. */
  rebuildChunk(ci: number) {
    this.outs[ci] = this.buildChunk(ci);
    this.buildSuper(this.superOf(ci));
    this.updateRegions();
    this.dynDirty = true;
  }

  private regionOf(si: number) {
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    return Math.floor(sz / IR) * this.nr + Math.floor(sx / IR);
  }

  /** Rewrite the impostor instances of regions whose far set changed. */
  private updateRegions() {
    for (let ri = 0; ri < this.regions.length; ri++) {
      const R = this.regions[ri];
      if (!R.dirty) continue;
      R.dirty = false;
      const rx = ri % this.nr, rz = Math.floor(ri / this.nr);
      const members: Super[] = [];
      let total = 0, far = 0;
      for (let dz = 0; dz < IR; dz++) for (let dx = 0; dx < IR; dx++) {
        const sx = rx * IR + dx, sz = rz * IR + dz;
        if (sx >= this.ns || sz >= this.ns) continue;
        const s = this.supers[sz * this.ns + sx];
        if (!s.farM) continue;
        const k = s.farM.length / 16;
        total += k;
        if (!s.nearOn) { members.push(s); far += k; }
      }
      if (!far) { if (R.mesh) R.mesh.visible = false; continue; }
      if (!R.mesh || R.cap < far) {
        if (R.mesh) { this.group.remove(R.mesh); R.mesh.dispose(); }
        R.cap = Math.ceil(total * 1.1) + 16;
        R.mesh = makeImpostorMesh(this.impGeo, this.mats.tree, R.cap);
        this.group.add(R.mesh);
      }
      const mesh = R.mesh;
      const ma = mesh.instanceMatrix.array as Float32Array, ca = mesh.instanceColor!.array as Float32Array;
      let o = 0;
      const box = new THREE.Box3();
      for (const s of members) {
        ma.set(s.farM!, o * 16);
        ca.set(s.farC!, o * 3);
        o += s.farM!.length / 16;
        box.union(s.treeBox);
      }
      mesh.count = o;
      mesh.visible = true;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.instanceColor!.needsUpdate = true;
      mesh.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    }
  }

  private superOf(ci: number) {
    const cx = ci % this.n, cz = Math.floor(ci / this.n);
    return Math.floor(cz / SC) * this.ns + Math.floor(cx / SC);
  }

  private buildChunk(ci: number): ChunkOut {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    const n = this.n;
    const cx = ci % n, cz = Math.floor(ci / n);
    const x0 = cx * OBJ_CHUNK, z0 = cz * OBJ_CHUNK;
    const x1 = Math.min(w.size, x0 + OBJ_CHUNK), z1 = Math.min(w.size, z0 + OBJ_CHUNK);
    const W = new WB();
    const ctx: ChunkCtx = {
      game: g, ci, n, x0, z0, x1, z1, w: W, d: new WB(), fac: new FacadeBuilder(W),
      lights: [], sigLamps: [], booms: [], xLights: [], trees: [],
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
        if (st.rail && mine(st.rail.x, st.rail.z)) buildStation(ctx, st, color);
        if (st.stops.length) buildBusStops(ctx, st, color);
      }
      for (const d of g.depots.map.values()) if (mine(d.x, d.z)) buildDepot(ctx, d, hexToInt(g.company(d.owner).color));
    } catch (err) { console.warn('objects: structure build failed', err); }
    for (const id of w.bgrid.query(x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5)) {
      const b = w.buildings.get(id);
      if (!b || !mine(b.x, b.z)) continue;
      try { buildBuilding(w, b, ctx.w, ctx.d, ctx.fac); } catch (err) { console.warn('objects: building failed', b.id, err); }
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
      const y = w.heightAt(t.x, t.z);
      if (y < WATER_Y + 0.05) continue;
      const h = ((Math.floor(t.x * 97) * 31 + Math.floor(t.z * 89)) & 1023) / 1024;
      ctx.trees.push({ type: treeVariant(t.type, (h * 7.13) % 1), x: t.x, y: y - 0.03, z: t.z, s: t.s, rot: h * Math.PI * 2, tint: t.tint });
    }
    return {
      world: ctx.w.empty ? null : ctx.w.build(),
      facade: null,
      detail: ctx.d.empty ? null : ctx.d.build(),
      lights: ctx.lights, lamps: ctx.sigLamps, booms: ctx.booms, xl: ctx.xLights, trees: ctx.trees,
    };
  }

  private buildSuper(si: number) {
    const s = this.supers[si];
    // dispose the old content
    for (const o of s.meshes) { s.group.remove(o); disposeObj(o); }
    s.meshes = [];
    s.detail = null;
    const sx = si % this.ns, sz = Math.floor(si / this.ns);
    const outs: ChunkOut[] = [];
    for (let dz = 0; dz < SC; dz++) for (let dx = 0; dx < SC; dx++) {
      const cx = sx * SC + dx, cz = sz * SC + dz;
      if (cx < this.n && cz < this.n) outs.push(this.outs[cz * this.n + cx]);
    }
    const box = s.box.makeEmpty();
    const add = (o: THREE.Object3D) => { o.matrixAutoUpdate = false; s.group.add(o); s.meshes.push(o); };
    const world = mergeGeos(outs.map((o) => o.world!).filter(Boolean));
    if (world) {
      const m = new THREE.Mesh(world, this.mats.world);
      const cast = (world.getAttribute('aCast').array as Float32Array).some((v) => v > 0.5);
      m.castShadow = cast;
      m.receiveShadow = true;
      m.customDepthMaterial = this.mats.worldDepth;
      add(m);
      box.union(world.boundingBox!);
    }
    const det = mergeGeos(outs.map((o) => o.detail!).filter(Boolean));
    if (det) {
      const m = new THREE.Mesh(det, this.mats.world);
      m.castShadow = false; m.receiveShadow = true;
      add(m);
      s.detail = m;
      box.union(det.boundingBox!);
    }
    const lights: number[] = [];
    for (const o of outs) for (const v of o.lights) lights.push(v);
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
    for (const o of outs) for (const t of o.trees) { sig = (sig * 31 + Math.round(t.x * 64) * 7 + Math.round(t.z * 64) + t.type) | 0; cnt++; }
    sig = (sig ^ (cnt * 2654435761)) | 0;
    if (sig !== s.treeSig || !cnt) {
      for (const o of s.treeObjs) { s.group.remove(o); disposeObj(o); }
      s.treeObjs = []; s.near = null; s.farM = null; s.farC = null;
      s.treeBox.makeEmpty();
      s.treeSig = sig;
      this.regions[this.regionOf(si)].dirty = true;
      if (cnt) {
        const trees: TreeInstance[] = [];
        for (const o of outs) for (const t of o.trees) trees.push(t);
        const near = new THREE.Group();
        near.matrixAutoUpdate = false;
        for (const im of makeTreeMeshes(trees, this.treeGeos, this.mats.tree)) { im.matrixAutoUpdate = false; near.add(im); }
        s.group.add(near); s.treeObjs.push(near); s.near = near;
        const fd = impostorData(trees);
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
    this.applyLod(s, si);
  }

  private applyLod(s: Super, si = -1) {
    if (s.empty) return;
    void si;
    let d = 0;
    if (this.hasCam) d = s.box.distanceToPoint(this.camPos);
    const detailOn = !this.hasCam || d < DETAIL_DIST;
    const nearOn = !this.hasCam || d < TREE_DIST;
    if (nearOn !== s.nearOn && s.farM) this.regions[this.regionOf(si >= 0 ? si : this.supers.indexOf(s))].dirty = true;
    s.detailOn = detailOn; s.nearOn = nearOn;
    if (s.detail) s.detail.visible = detailOn;
    if (s.near) s.near.visible = nearOn;
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
      camera.getWorldPosition(this.camPos);
      this.hasCam = true;
      this.supers.forEach((s, i) => this.applyLod(s, i));
      this.updateRegions();
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
          const tri = (geo.index ? geo.index.count : geo.getAttribute('position').count) / 3;
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
      for (const o of [...s.meshes, ...s.treeObjs]) { s.group.remove(o); disposeObj(o); }
      s.meshes = []; s.treeObjs = []; s.treeSig = -1;
    }
    for (const m of [this.lampMesh, this.boomMesh, this.xlMesh]) if (m) { this.group.remove(m); m.dispose(); }
    this.lampMesh = this.boomMesh = this.xlMesh = null;
    for (const R of this.regions) if (R.mesh) { this.group.remove(R.mesh); R.mesh.dispose(); R.mesh = null; }
    for (const geo of this.treeGeos) geo.dispose();
    this.impGeo.dispose();
    this.boomGeo.dispose();
    this.lampGeo.dispose();
  }
}

function disposeObj(o: THREE.Object3D) {
  o.traverse((c) => {
    if (c instanceof THREE.InstancedMesh) { c.dispose(); return; } // shared tree geometry stays
    const m = c as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}
