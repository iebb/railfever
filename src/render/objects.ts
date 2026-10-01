// Static world objects in chunks: roads, rails, buildings, structures, trees.
import * as THREE from 'three';
import { World, OBJ_CHUNK } from '../game/world';
import { GeoBuilder } from './geo';
import { Materials } from './materials';
import { buildRoadTile } from './build-road';
import { buildRailTile, buildDepot, buildSpan, buildPortal, SignalLamp } from './build-rail';
import { buildBuilding, FacadeBuilder } from './build-buildings';
import { createTreeGeometries, makeTreeMeshes, TreeInstance } from './trees';
import { hash2 } from '../game/rng';
import type { Vehicles } from '../game/vehicles';

interface Chunk { group: THREE.Group | null }

export class ObjectsView {
  group = new THREE.Group();
  chunks: Chunk[];
  treeGeos: THREE.BufferGeometry[];
  lamps = new Map<number, SignalLamp[]>();
  lampMesh: THREE.InstancedMesh | null = null;
  private lampList: SignalLamp[] = [];
  private lampsDirty = true;
  private n: number;

  constructor(public world: World, public mats: Materials) {
    this.n = Math.ceil(world.size / OBJ_CHUNK);
    this.chunks = Array.from({ length: this.n * this.n }, () => ({ group: null }));
    this.treeGeos = createTreeGeometries();
  }

  buildAll() {
    for (let i = 0; i < this.chunks.length; i++) this.rebuildChunk(i);
    this.world.dirtyObj.clear();
  }

  /** Rebuild dirty chunks within a time budget. */
  update(budgetMs = 8) {
    const w = this.world;
    if (!w.dirtyObj.size) return;
    const start = performance.now();
    for (const c of [...w.dirtyObj]) {
      w.dirtyObj.delete(c);
      this.rebuildChunk(c);
      if (performance.now() - start > budgetMs) break;
    }
  }

  rebuildChunk(ci: number) {
    const w = this.world;
    const cx = ci % this.n, cz = Math.floor(ci / this.n);
    const x0 = cx * OBJ_CHUNK, z0 = cz * OBJ_CHUNK;
    const x1 = Math.min(w.size, x0 + OBJ_CHUNK), z1 = Math.min(w.size, z0 + OBJ_CHUNK);
    const matte = new GeoBuilder();
    const metal = new GeoBuilder();
    const fac = new FacadeBuilder();
    const lamps: SignalLamp[] = [];
    const trees: TreeInstance[] = [];
    const lights: number[] = [];
    for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
      const t = w.idx(x, z);
      if (w.road[t]) buildRoadTile(w, x, z, matte, metal, lights);
      if (w.rail[t]) buildRailTile(w, x, z, matte, metal, fac, lamps);
      if (w.depot[t] >= 0) buildDepot(w, x, z, matte, metal, fac);
      const b = w.building[t];
      if (b >= 0) {
        const bb = w.buildings[b];
        if (bb && bb.x === x && bb.z === z) buildBuilding(w, bb, matte, metal, fac);
      }
      if (w.span[t] >= 0) {
        const s = w.structures.get(w.span[t]);
        if (s) buildSpan(w, x, z, s, matte, metal);
      }
      for (let e = 0; e < 4; e++) {
        const sid = w.headAt(t, e);
        if (sid < 0) continue;
        const s = w.structures.get(sid);
        if (s && s.kind === 'tunnel') buildPortal(w, x, z, e, s, matte);
      }
      const tr = w.trees[t];
      const cnt = tr & 15;
      if (cnt) {
        const type = tr >> 4;
        for (let k = 0; k < cnt; k++) {
          const h1 = hash2(x, z, k * 3 + 1), h2 = hash2(x, z, k * 3 + 2), h3 = hash2(x, z, k * 3 + 3);
          // spread trees over the tile in a jittered pattern
          const gx = cnt === 1 ? 0.5 : k % 2 === 0 ? 0.28 : 0.72;
          const gz = cnt <= 2 ? (cnt === 1 ? 0.5 : k === 0 ? 0.3 : 0.7) : k < 2 ? 0.28 : 0.72;
          const px = x + gx + (h1 - 0.5) * 0.3, pz = z + gz + (h2 - 0.5) * 0.3;
          const mixed = h3 < 0.18 ? 1 - type : type;
          trees.push({ type: mixed, x: px, y: w.heightAt(px, pz) - 0.01, z: pz, s: 0.75 + h3 * 0.7, rot: h1 * 6.28, tint: h2 });
        }
      }
    }
    const chunk = this.chunks[ci];
    if (chunk.group) {
      this.group.remove(chunk.group);
      chunk.group.traverse((o) => { if ((o as THREE.Mesh).geometry && !(o instanceof THREE.InstancedMesh)) (o as THREE.Mesh).geometry.dispose(); if (o instanceof THREE.InstancedMesh) o.dispose(); });
    }
    const g = new THREE.Group();
    const add = (gb: GeoBuilder, mat: THREE.Material) => {
      if (gb.empty) return;
      const m = new THREE.Mesh(gb.build(), mat);
      m.castShadow = true;
      m.receiveShadow = true;
      g.add(m);
    };
    add(matte, this.mats.matte);
    add(metal, this.mats.metal);
    add(fac.gb, this.mats.facade);
    for (const im of makeTreeMeshes(trees, this.treeGeos, this.mats.tree)) g.add(im);
    if (lights.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(lights, 3));
      const pts = new THREE.Points(lg, this.mats.glow);
      pts.renderOrder = 6;
      g.add(pts);
    }
    chunk.group = g;
    this.group.add(g);
    const prev = this.lamps.get(ci);
    if (lamps.length || (prev && prev.length)) { this.lamps.set(ci, lamps); this.lampsDirty = true; }
  }

  /** Update signal lamp colours from reservations. */
  updateSignals(vehicles: Vehicles) {
    if (this.lampsDirty) {
      this.lampsDirty = false;
      this.lampList = [...this.lamps.values()].flat();
      if (this.lampMesh) { this.group.remove(this.lampMesh); this.lampMesh.dispose(); this.lampMesh = null; }
      if (this.lampList.length) {
        const geo = new THREE.SphereGeometry(0.014, 8, 6);
        this.lampMesh = new THREE.InstancedMesh(geo, this.mats.lamp, this.lampList.length);
        const m = new THREE.Matrix4();
        this.lampList.forEach((l, i) => { m.makeTranslation(l.x, l.y, l.z); this.lampMesh!.setMatrixAt(i, m); });
        this.lampMesh.instanceMatrix.needsUpdate = true;
        this.group.add(this.lampMesh);
      }
    }
    if (!this.lampMesh) return;
    const green = new THREE.Color(0.2, 1.6, 0.4), red = new THREE.Color(1.8, 0.15, 0.1);
    this.lampList.forEach((l, i) => this.lampMesh!.setColorAt(i, vehicles.getRes(l.t) ? green : red));
    if (this.lampMesh.instanceColor) this.lampMesh.instanceColor.needsUpdate = true;
  }
}
