// Construction previews (ghost tracks, footprints), snap markers, hover highlights and line routes.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Proposal, CrossingPlan } from '../game/construction';
import type { StationPlan } from '../game/stations';
import type { DepotPlan } from '../game/build-ops';
import { depotSize } from '../game/build-ops';
import { arcTable, tAtS, bezPoint } from '../game/geom';
import { profAt } from '../game/network';
import { ROAD_TYPES, WATER_Y, NetKind } from '../game/constants';

export type MarkerKind = 'node' | 'edge' | 'free' | 'start' | 'signal' | 'point';
export interface FootRect { x: number; z: number; angle: number; w: number; d: number; color: number; y?: number; lift?: number }
export interface Ring { x: number; z: number; r: number }

const C = {
  ok: 0x46e07a, okBridge: 0x4fc3ff, okTunnel: 0xb38cff,
  bad: 0xff4a4a, badBridge: 0xff9a4a, badTunnel: 0xff5ab8,
};
/** Marker colours of planned crossings by mode. */
export const CROSS_COLORS: Record<CrossingPlan['mode'], number> = { level: 0xffd84a, diamond: 0xff9c3a, junction: 0xffffff, over: 0x4fc3ff, under: 0xb38cff };
export const CROSS_LABEL: Record<CrossingPlan['mode'], string> = { level: 'level crossing', diamond: 'diamond crossing', junction: 'junction', over: 'overpass', under: 'underpass' };

const tmpC = new THREE.Color();
const col = (hex: number) => tmpC.setHex(hex);

/** Growable vertex lists (non-indexed triangles with colours). */
class Buf {
  pos: number[] = [];
  col: number[] = [];
  clear() { this.pos.length = 0; this.col.length = 0; return this; }
  v(x: number, y: number, z: number, c: THREE.Color) { this.pos.push(x, y, z); this.col.push(c.r, c.g, c.b); }
  /** Quad a-b-c-d (each xyz) with one colour per side (ab / cd). */
  quad(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, dx: number, dy: number, dz: number, c0: THREE.Color, c1 = c0) {
    this.v(ax, ay, az, c0); this.v(bx, by, bz, c0); this.v(cx, cy, cz, c1);
    this.v(ax, ay, az, c0); this.v(cx, cy, cz, c1); this.v(dx, dy, dz, c1);
  }
}

/** BufferGeometry whose attributes grow on demand and are reused between updates. */
class DynGeo {
  readonly geo = new THREE.BufferGeometry();
  private cap = 0;
  constructor() { this.alloc(256); }
  private alloc(n: number) {
    this.cap = n;
    this.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  }
  set(b: Buf) {
    const n = b.pos.length / 3;
    if (n > this.cap) { this.geo.dispose(); this.alloc(Math.max(n, this.cap * 2)); }
    const pa = this.geo.getAttribute('position') as THREE.BufferAttribute, ca = this.geo.getAttribute('color') as THREE.BufferAttribute;
    (pa.array as Float32Array).set(b.pos);
    (ca.array as Float32Array).set(b.col);
    pa.needsUpdate = true; ca.needsUpdate = true;
    this.geo.setDrawRange(0, n);
    return n > 0;
  }
  dispose() { this.geo.dispose(); }
}

/** Append a ribbon along a sampled 3D polyline (xyz triples). */
function ribbon(b: Buf, pts: ArrayLike<number>, n: number, hw: number, lift: number, color: (i: number) => THREE.Color) {
  if (n < 2) return;
  let plx = 0, ply = 0, plz = 0, prx = 0, prz = 0, pc = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
    let tx = pts[c * 3] - pts[a * 3], tz = pts[c * 3 + 2] - pts[a * 3 + 2];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const rx = -tz * hw, rz = tx * hw;
    const x = pts[i * 3], y = pts[i * 3 + 1] + lift, z = pts[i * 3 + 2];
    const ci = color(i).clone();
    if (i > 0) b.quad(plx - prx, ply, plz - prz, plx + prx, ply, plz + prz, x + rx, y, z + rz, x - rx, y, z - rz, pc, ci);
    plx = x; ply = y; plz = z; prx = rx; prz = rz; pc = ci;
  }
}

/** Flat oriented rectangle at height y (forward = (sin a, cos a), right = (cos a, -sin a)). */
function flatRect(b: Buf, x: number, z: number, a: number, w: number, d: number, y: number, c: THREE.Color) {
  const fx = Math.sin(a) * d / 2, fz = Math.cos(a) * d / 2, rx = Math.cos(a) * w / 2, rz = -Math.sin(a) * w / 2;
  b.quad(x - rx - fx, y, z - rz - fz, x + rx - fx, y, z + rz - fz, x + rx + fx, y, z + rz + fz, x - rx + fx, y, z - rz + fz, c);
}

function basic(opts: THREE.MeshBasicMaterialParameters) {
  return new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false, ...opts });
}

/** Mesh drawn twice: normally and as a faint x-ray (visible through terrain, tunnels). */
class GhostMesh {
  dyn = new DynGeo();
  mesh: THREE.Mesh;
  xray: THREE.Mesh;
  constructor(group: THREE.Group, opacity: number, xrayOpacity: number, order: number) {
    this.mesh = new THREE.Mesh(this.dyn.geo, basic({ vertexColors: true, opacity, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
    this.xray = new THREE.Mesh(this.dyn.geo, basic({ vertexColors: true, opacity: xrayOpacity, depthTest: false }));
    this.mesh.renderOrder = order; this.xray.renderOrder = order - 1;
    for (const m of [this.mesh, this.xray]) { m.frustumCulled = false; m.visible = false; group.add(m); }
  }
  set(b: Buf | null) {
    const vis = !!b && this.dyn.set(b);
    this.mesh.visible = this.xray.visible = vis;
  }
  get visible() { return this.mesh.visible; }
  dispose() { this.dyn.dispose(); (this.mesh.material as THREE.Material).dispose(); (this.xray.material as THREE.Material).dispose(); }
}

export class Overlay {
  group = new THREE.Group();
  private ghost: GhostMesh;
  private foot: GhostMesh;
  private hover: GhostMesh;
  private rings: GhostMesh;
  private markers = new Map<string, THREE.Mesh>();
  private markerGeo: Record<MarkerKind, THREE.BufferGeometry>;
  private crossPool: THREE.Mesh[] = [];
  private crossGeo = new THREE.RingGeometry(0.55, 1, 20).rotateX(-Math.PI / 2);
  private crossMats = new Map<string, THREE.MeshBasicMaterial>();
  private linePaths = new Map<number, GhostMesh>();
  private hoverKey = '';
  private time = 0;
  private buf = new Buf();

  constructor(public game: Game) {
    this.ghost = new GhostMesh(this.group, 0.62, 0.2, 31);
    this.foot = new GhostMesh(this.group, 0.5, 0.16, 29);
    this.hover = new GhostMesh(this.group, 0.55, 0.14, 27);
    this.rings = new GhostMesh(this.group, 0.75, 0.12, 25);
    const flat = (g: THREE.BufferGeometry) => g.rotateX(-Math.PI / 2);
    this.markerGeo = {
      node: flat(new THREE.RingGeometry(0.62, 1, 28)),
      edge: flat(new THREE.RingGeometry(0.6, 1, 4)),
      free: flat(new THREE.CircleGeometry(0.42, 20)),
      start: flat(new THREE.RingGeometry(0.78, 1.08, 32)),
      signal: flat(new THREE.RingGeometry(0.4, 0.75, 6)),
      point: flat(new THREE.CircleGeometry(0.55, 16)),
    };
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number, camera: THREE.Camera) {
    this.time += dt;
    const cp = camera.position;
    const scale = (m: THREE.Object3D, k: number) => m.scale.setScalar(Math.max(0.12, Math.min(9, cp.distanceTo(m.position) * k)));
    for (const [slot, m] of this.markers) {
      if (!m.visible) continue;
      scale(m, (m.userData.size as number) ?? 0.013);
      if (slot === 'start' || m.userData.pulse) (m.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.25 * Math.sin(this.time * 6);
    }
    for (const m of this.crossPool) if (m.visible) scale(m, 0.011);
  }

  /** Hide all tool previews (line paths and catchment rings stay). */
  clear() {
    this.setProposal(null);
    this.foot.set(null);
    this.setHoverEdge(null);
    for (const m of this.markers.values()) m.visible = false;
  }

  // ---------------------------------------------------------------- markers
  /** Show a marker in a named slot ('start', 'hover', ...) or hide it with null. */
  setMarker(slot: string, p: { x: number; y: number; z: number } | null, kind: MarkerKind = 'node', color = 0xffffff, size = 0.013) {
    let m = this.markers.get(slot);
    if (!p) { if (m) m.visible = false; return; }
    if (!m) {
      m = new THREE.Mesh(this.markerGeo[kind], basic({ color, opacity: 0.92, depthTest: false }));
      m.renderOrder = 40;
      m.frustumCulled = false;
      this.group.add(m);
      this.markers.set(slot, m);
    }
    if (m.geometry !== this.markerGeo[kind]) m.geometry = this.markerGeo[kind];
    (m.material as THREE.MeshBasicMaterial).color.setHex(color);
    m.userData.size = size;
    m.position.set(p.x, p.y + 0.06, p.z);
    m.visible = true;
  }

  // ---------------------------------------------------------------- proposals
  /** Ghost of a planned track/road: ribbons per track, coloured by validity and structure type. */
  setProposal(p: Proposal | null) {
    for (const m of this.crossPool) m.visible = false;
    if (!p || !p.tracks.length) { this.ghost.set(null); return; }
    const b = this.buf.clear();
    const ok = p.ok;
    const road = p.opts.kind === 'road';
    const rt = ROAD_TYPES[p.opts.type] ?? ROAD_TYPES.road;
    const hw = road ? rt.half + rt.sidewalk * 0.6 : 0.22;
    const cGround = new THREE.Color().setHex(ok ? C.ok : C.bad);
    const cBridge = new THREE.Color().setHex(ok ? C.okBridge : C.badBridge);
    const cTunnel = new THREE.Color().setHex(ok ? C.okTunnel : C.badTunnel);
    const cLine = new THREE.Color().setHex(ok ? 0x1d6b38 : 0x8a1f1f);
    const pt = { x: 0, z: 0 };
    for (const tp of p.tracks) {
      const tab = arcTable(tp.bez);
      const L = tab.len;
      const step = Math.max(0.35, L / 600);
      const n = Math.max(2, Math.ceil(L / step) + 1);
      const pts = new Float32Array(n * 3);
      const types = new Uint8Array(n);
      for (let i = 0; i < n; i++) {
        const s = Math.min(i * step, L);
        bezPoint(tp.bez, tAtS(tab, s), pt);
        pts[i * 3] = pt.x; pts[i * 3 + 1] = profAt(tp.prof, tp.len, s); pts[i * 3 + 2] = pt.z;
        for (const sec of tp.sections) if (s >= sec.s0 && s <= sec.s1) types[i] = sec.type === 'bridge' ? 1 : 2;
      }
      ribbon(b, pts, n, hw, 0.04, (i) => (types[i] === 1 ? cBridge : types[i] === 2 ? cTunnel : cGround));
      // centre line (rail) / lane divider (road) for readability
      ribbon(b, pts, n, road ? 0.025 : 0.04, 0.05, () => cLine);
    }
    this.ghost.set(b);
    // crossing markers
    p.crossings.forEach((c, i) => {
      let m = this.crossPool[i];
      if (!m) { m = new THREE.Mesh(this.crossGeo, this.crossMat(c.mode)); m.renderOrder = 41; m.frustumCulled = false; this.group.add(m); this.crossPool.push(m); }
      m.material = this.crossMat(c.mode);
      const tp = p.tracks[c.track] ?? p.tracks[0];
      m.position.set(c.x, profAt(tp.prof, tp.len, c.sNew) + 0.08, c.z);
      m.visible = true;
    });
  }

  private crossMat(mode: CrossingPlan['mode']) {
    let m = this.crossMats.get(mode);
    if (!m) { m = basic({ color: CROSS_COLORS[mode], opacity: 0.95, depthTest: false }); this.crossMats.set(mode, m); }
    return m;
  }

  // ---------------------------------------------------------------- footprints
  /** Flat (y given) or terrain-draped oriented rectangles. */
  setFootprints(rects: FootRect[] | null) {
    if (!rects || !rects.length) { this.foot.set(null); return; }
    const b = this.buf.clear();
    for (const r of rects) this.addRect(b, r);
    this.foot.set(b);
  }

  private addRect(b: Buf, r: FootRect) {
    const c = col(r.color).clone();
    const lift = r.lift ?? 0.04;
    if (r.y !== undefined) { flatRect(b, r.x, r.z, r.angle, r.w, r.d, r.y + lift, c); return; }
    // drape on the terrain
    const w = this.game.world;
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
    const nx = Math.max(1, Math.ceil(r.w / 0.5)), nz = Math.max(1, Math.ceil(r.d / 0.5));
    const P = (i: number, j: number): [number, number, number] => {
      const u = (i / nx - 0.5) * r.w, v = (j / nz - 0.5) * r.d;
      const x = r.x + rx * u + fx * v, z = r.z + rz * u + fz * v;
      return [x, Math.max(w.heightAt(x, z), WATER_Y) + lift, z];
    };
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const a = P(i, j), bb = P(i + 1, j), cc = P(i + 1, j + 1), d = P(i, j + 1);
      b.quad(a[0], a[1], a[2], bb[0], bb[1], bb[2], cc[0], cc[1], cc[2], d[0], d[1], d[2], c);
    }
  }

  /** Ghost of a planned rail station: plate, platforms, tracks and the station building. */
  setStationGhost(pl: StationPlan | null) {
    if (!pl) { this.foot.set(null); return; }
    const b = this.buf.clear();
    const y = pl.y;
    const fr = pl.footprint;
    const rx = Math.cos(pl.angle), rz = -Math.sin(pl.angle);
    flatRect(b, fr.x, fr.z, fr.angle, fr.w, fr.d, y + 0.02, col(pl.ok ? C.ok : C.bad).clone());
    const cp = col(pl.ok ? 0xd9f7e2 : 0xffd2cc).clone();
    for (const p of pl.layout.platforms) flatRect(b, pl.x + rx * p.off, pl.z + rz * p.off, pl.angle, p.w, pl.length * 0.96, y + 0.1, cp);
    const ct = col(pl.ok ? 0x1d4f30 : 0x6e1d1d).clone();
    for (const o of pl.layout.trackOffsets) flatRect(b, pl.x + rx * o, pl.z + rz * o, pl.angle, 0.16, pl.length, y + 0.05, ct);
    const bd = pl.building;
    flatRect(b, bd.x, bd.z, bd.angle, bd.w, bd.d, y + 0.3, col(pl.ok ? 0xf3e7c4 : 0xffb3a8).clone());
    this.foot.set(b);
  }

  /** Ghost of a planned depot with an arrow showing the door / track direction. */
  setDepotGhost(pl: DepotPlan | null, kind: NetKind = 'rail') {
    if (!pl) { this.foot.set(null); return; }
    const b = this.buf.clear();
    const sz = depotSize(kind);
    const y = pl.y;
    flatRect(b, pl.x, pl.z, pl.angle, sz.w, sz.d, y + 0.04, col(pl.ok ? C.ok : C.bad).clone());
    // door arrow
    const fx = Math.sin(pl.angle), fz = Math.cos(pl.angle), rx = fz, rz = -fx;
    const tipx = pl.x + fx * (sz.d / 2 + 0.55), tipz = pl.z + fz * (sz.d / 2 + 0.55);
    const bx = pl.x + fx * (sz.d / 2 - 0.1), bz = pl.z + fz * (sz.d / 2 - 0.1);
    const c = col(0xffe066).clone();
    b.v(tipx, y + 0.08, tipz, c); b.v(bx + rx * 0.45, y + 0.08, bz + rz * 0.45, c); b.v(bx - rx * 0.45, y + 0.08, bz - rz * 0.45, c);
    if (kind === 'rail') flatRect(b, pl.x, pl.z, pl.angle, 0.14, sz.d, y + 0.06, col(0x203828).clone());
    this.foot.set(b);
  }

  // ---------------------------------------------------------------- edge highlight
  /** Highlight network edges (hover in query / bulldoze / signal tools). */
  setHoverEdge(ids: number | number[] | null, color = 0xffffff) {
    const list = ids == null ? [] : Array.isArray(ids) ? ids : [ids];
    const net = this.game.world.net;
    const key = list.map((id) => id + ':' + (net.edges.get(id)?.version ?? -1)).join(',') + '|' + color;
    if (key === this.hoverKey) return;
    this.hoverKey = key;
    if (!list.length) { this.hover.set(null); return; }
    const b = this.buf.clear();
    const c = col(color).clone();
    for (const id of list) {
      const e = net.edges.get(id);
      if (!e) continue;
      const g = net.geo(e);
      ribbon(b, g.pts, g.n, net.halfWidth(e) + 0.06, 0.05, () => c);
    }
    this.hover.set(b);
  }

  // ---------------------------------------------------------------- catchment rings
  /** Terrain-draped circle outlines (catchment areas). */
  setRings(rings: Ring[] | null, color = 0x5ac8fa) {
    if (!rings || !rings.length) { this.rings.set(null); return; }
    const w = this.game.world;
    const b = this.buf.clear();
    const c = col(color).clone();
    for (const r of rings) {
      const n = Math.max(24, Math.min(256, Math.ceil(r.r * 2)));
      const pts = new Float32Array((n + 1) * 3);
      for (let i = 0; i <= n; i++) {
        const a = (i / n) * Math.PI * 2;
        const x = r.x + Math.cos(a) * r.r, z = r.z + Math.sin(a) * r.r;
        pts[i * 3] = x; pts[i * 3 + 1] = Math.max(w.heightAt(x, z), WATER_Y); pts[i * 3 + 2] = z;
      }
      ribbon(b, pts, n + 1, 0.12, 0.12, () => c);
    }
    this.rings.set(b);
  }

  // ---------------------------------------------------------------- line paths
  /** Show a line's route as coloured polylines (xyz triples) lifted above the network; null removes it. */
  setLinePath(id: number, curves: Float32Array[] | null, color = '#ffffff') {
    let m = this.linePaths.get(id);
    if (!curves || !curves.length) {
      if (m) { this.group.remove(m.mesh, m.xray); m.dispose(); this.linePaths.delete(id); }
      return;
    }
    if (!m) { m = new GhostMesh(this.group, 0.85, 0.22, 22); this.linePaths.set(id, m); }
    const b = this.buf.clear();
    const c = new THREE.Color(color);
    const dark = c.clone().multiplyScalar(0.45);
    for (const pts of curves) {
      const n = pts.length / 3;
      ribbon(b, pts, n, 0.075, 0.32, () => c);
      // direction chevrons every ~5 units
      let acc = 0;
      for (let i = 1; i < n; i++) {
        const dx = pts[i * 3] - pts[i * 3 - 3], dz = pts[i * 3 + 2] - pts[i * 3 - 1];
        const l = Math.hypot(dx, dz);
        acc += l;
        if (acc < 5 || l < 1e-4) continue;
        acc = 0;
        const ux = dx / l, uz = dz / l, x = pts[i * 3], y = pts[i * 3 + 1] + 0.335, z = pts[i * 3 + 2];
        b.v(x + ux * 0.16, y, z + uz * 0.16, dark); b.v(x - uz * 0.07 - ux * 0.06, y, z + ux * 0.07 - uz * 0.06, dark); b.v(x + uz * 0.07 - ux * 0.06, y, z - ux * 0.07 - uz * 0.06, dark);
      }
    }
    m.set(b);
  }
  linePathIds() { return [...this.linePaths.keys()]; }

  dispose() {
    for (const g of [this.ghost, this.foot, this.hover, this.rings, ...this.linePaths.values()]) g.dispose();
    for (const g of Object.values(this.markerGeo)) g.dispose();
    for (const m of this.markers.values()) (m.material as THREE.Material).dispose();
    for (const m of this.crossMats.values()) m.dispose();
    this.crossGeo.dispose();
    this.group.clear();
  }
}
