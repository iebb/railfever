// Static world objects in chunks: tracks, roads, structures, stations, depots, buildings, trees.
import * as THREE from 'three';
import type { Game } from '../game/game';
import { OBJ_CHUNK } from '../game/world';
import { WATER_Y } from '../game/constants';
import { GeoBuilder } from './geo';
import { Materials } from './materials';
import { ChunkCtx, SignalLamp, Boom, XLight, chunkIndexOf, hexToInt } from './build-common';
import { buildRailEdge, buildRailNode } from './build-rail';
import { buildRoadEdge, buildRoadNode, buildBusStops, buildCrossing } from './build-road';
import { buildStation, buildDepot } from './build-stations';
import { buildBuilding, FacadeBuilder } from './build-buildings';
import { createTreeGeometries, makeTreeMeshes, TreeInstance } from './trees';

interface Chunk { group: THREE.Group | null; lamps: SignalLamp[]; booms: Boom[]; xl: XLight[] }

const GREEN = new THREE.Color(0.25, 1.9, 0.5), RED = new THREE.Color(2.2, 0.16, 0.1);
const XRED = new THREE.Color(2.4, 0.15, 0.08), XOFF = new THREE.Color(0.18, 0.03, 0.03);

export class ObjectsView {
  group = new THREE.Group();
  private n: number;
  private chunks: Chunk[];
  private treeGeos: THREE.BufferGeometry[];
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

  constructor(public game: Game, public mats: Materials) {
    this.n = Math.ceil(game.world.size / OBJ_CHUNK);
    this.chunks = Array.from({ length: this.n * this.n }, () => ({ group: null, lamps: [], booms: [], xl: [] }));
    this.treeGeos = createTreeGeometries();
    // barrier boom: red/white bar along +x from the pivot, unit length
    const bg = new GeoBuilder();
    for (let i = 0; i < 6; i++) { bg.color(i % 2 ? 0xffffff : 0xd0302a); bg.box((i + 0.5) / 6, -0.009, 0, 1 / 6, 0.018, 0.016, 1, 0, false); }
    this.boomGeo = bg.build();
    this.lampGeo = new THREE.SphereGeometry(0.018, 8, 6);
    this.group.name = 'objects';
  }

  buildAll() {
    for (let i = 0; i < this.chunks.length; i++) this.rebuildChunk(i);
    this.game.world.dirtyObj.clear();
  }

  /** Rebuild dirty chunks within a time budget (ms). */
  update(budgetMs = 6) {
    const w = this.game.world;
    if (!w.dirtyObj.size) return;
    const start = performance.now();
    for (const c of [...w.dirtyObj]) {
      w.dirtyObj.delete(c);
      if (c >= 0 && c < this.chunks.length) this.rebuildChunk(c);
      if (performance.now() - start > budgetMs) break;
    }
  }

  rebuildChunk(ci: number) {
    const g = this.game;
    const w = g.world;
    const net = w.net;
    const n = this.n;
    const cx = ci % n, cz = Math.floor(ci / n);
    const x0 = cx * OBJ_CHUNK, z0 = cz * OBJ_CHUNK;
    const x1 = Math.min(w.size, x0 + OBJ_CHUNK), z1 = Math.min(w.size, z0 + OBJ_CHUNK);
    const ctx: ChunkCtx = {
      game: g, ci, n, x0, z0, x1, z1,
      matte: new GeoBuilder(), metal: new GeoBuilder(), ballast: new GeoBuilder(true), road: new GeoBuilder(true),
      lights: [], sigLamps: [], booms: [], xLights: [],
    };
    const fac = new FacadeBuilder();
    const mine = (x: number, z: number) => chunkIndexOf(x, z, n) === ci;
    const pad = 1;
    // network edges (pieces are assigned to chunks by segment midpoint)
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
    for (const c of net.crossings.values()) buildCrossing(ctx, c);
    // stations, bus stops, depots
    for (const st of g.stations.map.values()) {
      const color = hexToInt(g.company(st.owner).color);
      if (st.rail && mine(st.rail.x, st.rail.z)) buildStation(ctx, fac, st, color);
      if (st.stops.length) buildBusStops(ctx, st, color);
    }
    for (const d of g.depots.map.values()) if (mine(d.x, d.z)) buildDepot(ctx, fac, d, hexToInt(g.company(d.owner).color));
    // buildings
    for (const id of w.bgrid.query(x0 - 0.5, z0 - 0.5, x1 + 0.5, z1 + 0.5)) {
      const b = w.buildings.get(id);
      if (b && mine(b.x, b.z)) buildBuilding(w, b, ctx.matte, ctx.metal, fac);
    }
    // trees
    const trees: TreeInstance[] = [];
    for (const id of w.treeGrid.query(x0, z0, x1, z1)) {
      const t = w.trees[id];
      if (!t || !mine(t.x, t.z)) continue;
      const y = w.heightAt(t.x, t.z);
      if (y < WATER_Y + 0.05) continue;
      const h = (Math.floor(t.x * 97) * 31 + Math.floor(t.z * 89)) & 1023;
      trees.push({ type: t.type, x: t.x, y: y - 0.03, z: t.z, s: t.s, rot: (h / 1024) * Math.PI * 2, tint: t.tint });
    }
    // swap in the new chunk group
    const chunk = this.chunks[ci];
    if (chunk.group) { this.group.remove(chunk.group); disposeGroup(chunk.group); }
    const grp = new THREE.Group();
    const add = (gb: GeoBuilder, mat: THREE.Material, cast = true) => {
      if (gb.empty) return;
      const m = new THREE.Mesh(gb.build(), mat);
      m.castShadow = cast;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      grp.add(m);
    };
    add(ctx.matte, this.mats.matte);
    add(ctx.metal, this.mats.metal);
    add(fac.gb, this.mats.facade);
    add(ctx.ballast, this.mats.ballast, false);
    add(ctx.road, this.mats.road, false);
    for (const im of makeTreeMeshes(trees, this.treeGeos, this.mats.tree)) { im.matrixAutoUpdate = false; grp.add(im); }
    if (ctx.lights.length) {
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(ctx.lights, 3));
      const pts = new THREE.Points(lg, this.mats.glow);
      pts.renderOrder = 6;
      pts.matrixAutoUpdate = false;
      grp.add(pts);
    }
    grp.matrixAutoUpdate = false;
    chunk.group = grp;
    this.group.add(grp);
    if (ctx.sigLamps.length || chunk.lamps.length || ctx.booms.length || chunk.booms.length || ctx.xLights.length || chunk.xl.length) this.dynDirty = true;
    chunk.lamps = ctx.sigLamps;
    chunk.booms = ctx.booms;
    chunk.xl = ctx.xLights;
  }

  private rebuildDynamic() {
    this.dynDirty = false;
    for (const m of [this.lampMesh, this.boomMesh, this.xlMesh]) if (m) { this.group.remove(m); m.dispose(); }
    this.lampMesh = this.boomMesh = this.xlMesh = null;
    this.lampList = []; this.boomList = []; this.xlList = [];
    for (const c of this.chunks) { this.lampList.push(...c.lamps); this.boomList.push(...c.booms); this.xlList.push(...c.xl); }
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
      this.boomMesh = new THREE.InstancedMesh(this.boomGeo, this.mats.matte, this.boomList.length);
      this.boomMesh.castShadow = true;
      this.group.add(this.boomMesh);
      this.placeBooms(true);
    }
  }

  private placeBooms(force: boolean) {
    const mesh = this.boomMesh;
    if (!mesh) return;
    const m4 = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), p = new THREE.Vector3(), s = new THREE.Vector3();
    let changed = force;
    this.boomList.forEach((b, i) => {
      const f = this.boomPos.get(b.crossing) ?? 1;
      const yaw = Math.atan2(-b.dz, b.dx);
      e.set(0, yaw, f * Math.PI * 0.47, 'YXZ');
      q.setFromEuler(e);
      p.set(b.x, b.y, b.z);
      s.set(b.len, 1, 1);
      m4.compose(p, q, s);
      mesh.setMatrixAt(i, m4);
      changed = true;
    });
    if (changed) { mesh.instanceMatrix.needsUpdate = true; mesh.computeBoundingSphere(); }
  }

  /** Signals, level crossing barriers and warning lights. */
  animate(dt: number, night: number) {
    void night;
    if (this.dynDirty) this.rebuildDynamic();
    this.time += dt;
    const V = this.game.vehicles;
    // signal lamps: red when the block ahead is reserved/occupied
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
        const nv = target > cur ? Math.min(target, cur + dt * 0.6) : Math.max(target, cur - dt * 0.6);
        this.boomPos.set(b.crossing, nv);
        moved = true;
      }
      if (moved) this.placeBooms(false);
    }
    if (this.xlMesh) {
      const blink = Math.floor(this.time * 2) & 1;
      this.xlList.forEach((l, i) => {
        const on = V.crossingClosed.has(l.crossing) && blink === l.phase;
        this.xlMesh!.setColorAt(i, on ? XRED : XOFF);
      });
      if (this.xlMesh.instanceColor) this.xlMesh.instanceColor.needsUpdate = true;
    }
  }

  /** v1 compatibility: signal colours are now updated in animate(). */
  updateSignals(_v?: unknown) { /* no-op */ }

  dispose() {
    for (const c of this.chunks) if (c.group) { this.group.remove(c.group); disposeGroup(c.group); c.group = null; }
    for (const m of [this.lampMesh, this.boomMesh, this.xlMesh]) if (m) { this.group.remove(m); m.dispose(); }
    this.lampMesh = this.boomMesh = this.xlMesh = null;
    for (const geo of this.treeGeos) geo.dispose();
    this.boomGeo.dispose();
    this.lampGeo.dispose();
  }
}

function disposeGroup(g: THREE.Group) {
  g.traverse((o) => {
    if (o instanceof THREE.InstancedMesh) { o.dispose(); return; } // shared tree geometry stays
    const m = o as THREE.Mesh;
    if (m.geometry) m.geometry.dispose();
  });
}
