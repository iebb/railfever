// Construction previews (ghost tracks, footprints), snap markers, hover highlights and line routes.
import * as THREE from 'three';
import type { Game } from '../game/game';
import type { Proposal, CrossingPlan } from '../game/construction';
import type { StationPlan } from '../game/stations';
import type { DepotPlan, DepotKind } from '../game/build-ops';
import { depotSize, depotVolume, UNDERGROUND_DEPOT } from '../game/build-ops';
import { arcTable, tAtS, bezPoint } from '../game/geom';
import { profAt } from '../game/network';
import { ROAD_TYPES, TRACK_TYPES, WATER_Y, NetKind } from '../game/constants';
import { FLOOR_H } from '../game/towns';

export type MarkerKind = 'node' | 'edge' | 'free' | 'start' | 'signal' | 'point';
export interface FootRect { x: number; z: number; angle: number; w: number; d: number; color: number; y?: number; lift?: number }
export interface Ring { x: number; z: number; r: number }
/** Line route display (screen space): width in px, lateral offset in px (or per vertex: `lanes`, one array per
 *  curve), opacity, animated direction chevrons, draw order among routes. */
export interface LinePathOpts { width?: number; offset?: number; lanes?: ArrayLike<number>[]; lift?: number; opacity?: number; chevrons?: boolean; order?: number }
/** Default height of line routes above their track or road (the lines map's station numbers and route picking use it). */
export const ROUTE_LIFT = 0.35;
/** Desire line between two points (screen space): width in px, colour, alpha, apex height (world units), dashes (see RibbonPoly). */
export interface Arc { ax: number; az: number; bx: number; bz: number; w: number; color: number; h: number; alpha?: number; dash?: number }
/** Catchment circle: centre, radius, colour (fill and outline). */
export interface CatchCircle { x: number; z: number; r: number; color: number }
/**
 * A polyline for screen-space ribbons: points (xyz), colour, alpha, width (px), lateral lane offset(s) (px), and a
 * dash pattern as the drawn share of each dash period (0 or 1 = solid) — a second cue beside the colour. `dist0`:
 * distance along the line at the first point, so short pieces of one street continue each other's dashes.
 */
export interface RibbonPoly { pts: ArrayLike<number>; color: number | string; alpha?: number; width?: number; lane?: number | ArrayLike<number>; dash?: number; dist0?: number }
/** Dash pattern of a ribbon layer: drawn share of each period (0 = solid) and the period in screen px. */
export interface DashOpts { dash?: number; dashPx?: number }
/** Town ring for the demand view: radius, share (0..1) drawn as a progress arc, colour of the arc. */
export interface ShareRing { x: number; z: number; r: number; frac: number; color: number }

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

/** BufferGeometry whose attributes are reused between updates. Growing swaps in a fresh geometry:
 *  three.js does not re-upload new attributes attached to a geometry that was already disposed. */
class DynGeo {
  geo = new THREE.BufferGeometry();
  /** meshes drawing this geometry (re-pointed when it is replaced) */
  users: THREE.Mesh[] = [];
  private cap = 0;
  constructor() { this.alloc(this.geo, 256); }
  private alloc(geo: THREE.BufferGeometry, n: number) {
    this.cap = n;
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
    geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3), 3).setUsage(THREE.DynamicDrawUsage));
  }
  set(b: Buf) {
    const n = b.pos.length / 3;
    if (n > this.cap) {
      const old = this.geo;
      this.geo = new THREE.BufferGeometry();
      this.alloc(this.geo, Math.max(n, this.cap * 2));
      for (const m of this.users) m.geometry = this.geo;
      old.dispose();
    }
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
function ribbon(b: Buf, pts: ArrayLike<number>, n: number, hw: number, lift: number, color: (i: number) => THREE.Color, off = 0) {
  if (n < 2) return;
  let plx = 0, ply = 0, plz = 0, prx = 0, prz = 0, pc = new THREE.Color();
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
    let tx = pts[c * 3] - pts[a * 3], tz = pts[c * 3 + 2] - pts[a * 3 + 2];
    const l = Math.hypot(tx, tz) || 1;
    tx /= l; tz /= l;
    const rx = -tz * hw, rz = tx * hw;
    const x = pts[i * 3] - tz * off, y = pts[i * 3 + 1] + lift, z = pts[i * 3 + 2] + tx * off;
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

/** Open box (top + 4 sides) over an oriented rectangle from y0 to y1. */
function boxRect(b: Buf, x: number, z: number, a: number, w: number, d: number, y0: number, y1: number, c: THREE.Color) {
  const fx = Math.sin(a) * d / 2, fz = Math.cos(a) * d / 2, rx = Math.cos(a) * w / 2, rz = -Math.sin(a) * w / 2;
  const P = [[x - rx - fx, z - rz - fz], [x + rx - fx, z + rz - fz], [x + rx + fx, z + rz + fz], [x - rx + fx, z - rz + fz]];
  b.quad(P[0][0], y1, P[0][1], P[1][0], y1, P[1][1], P[2][0], y1, P[2][1], P[3][0], y1, P[3][1], c);
  for (let i = 0; i < 4; i++) {
    const p = P[i], q = P[(i + 1) % 4];
    b.quad(p[0], y0, p[1], q[0], y0, q[1], q[0], y1, q[1], p[0], y1, p[1], c);
  }
}

/** Vertical quad from (ax,az) to (bx,bz) between heights y0 and y1. */
function wall(b: Buf, ax: number, az: number, bx: number, bz: number, y0: number, y1: number, c: THREE.Color) {
  b.quad(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az, c);
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
    for (const m of [this.mesh, this.xray]) { m.frustumCulled = false; m.visible = false; group.add(m); this.dyn.users.push(m); }
  }
  set(b: Buf | null) {
    const vis = !!b && this.dyn.set(b);
    this.mesh.visible = this.xray.visible = vis;
  }
  get visible() { return this.mesh.visible; }
  dispose() { this.dyn.dispose(); (this.mesh.material as THREE.Material).dispose(); (this.xray.material as THREE.Material).dispose(); }
}

// ---------------------------------------------------------------- screen-space ribbons
// Constant pixel width with a dark casing, drawn on top of the world (routes, desire lines). Each vertex carries
// its centre point and tangent; the vertex shader offsets it sideways in screen space (lane + half width).
const RIBBON_VS = `
uniform vec2 uRes;
uniform float uWidthMul;
uniform float uCase;
attribute vec3 aDir;
attribute float aSide;
attribute float aLane;
attribute float aWidth;
attribute float aDist;
attribute float aDash;
attribute vec4 aColor;
varying vec4 vColor;
varying float vAcross;
varying float vDist;
varying float vHalf;
varying float vCore;
varying float vDash;
varying float vPerPx;
void main() {
  vec4 p0 = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  vec4 p1 = projectionMatrix * modelViewMatrix * vec4(position + aDir * 0.2, 1.0);
  vec2 d = (p1.xy / p1.w - p0.xy / p0.w) * uRes;
  float L = length(d);
  // world units per screen pixel along the line here (perspective and foreshortening: 0.2 units span L / 2 px),
  // so dashes keep a constant length on screen even where the line runs away from the camera
  vPerPx = p1.w > 0.0 ? 0.4 / max(L, 1e-4) : 1e4;
  d = L > 1e-6 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-d.y, d.x);
  float core = aWidth * uWidthMul * 0.5;
  float hw = core + uCase;
  p0.xy += n * ((aLane + aSide * hw) * 2.0 / uRes) * p0.w;
  gl_Position = p0;
  vColor = aColor; vAcross = aSide; vDist = aDist; vHalf = hw; vCore = core; vDash = aDash;
}`;
const RIBBON_FS = `
uniform vec3 uCaseColor;
uniform float uCaseAlpha;
uniform float uOpacity;
uniform float uChev;
uniform float uTime;
uniform float uPeriod;
uniform float uPeriodPx;
uniform float uDash;
uniform float uDashPx;
varying vec4 vColor;
varying float vAcross;
varying float vDist;
varying float vHalf;
varying float vCore;
varying float vDash;
varying float vPerPx;
float dashGap(float s, float on) { return smoothstep(on - 0.05, on, s) * (1.0 - smoothstep(0.95, 1.0, s)); }
void main() {
  float px = abs(vAcross) * vHalf;
  float outer = 1.0 - smoothstep(vHalf - 1.0, vHalf, px);
  float inner = 1.0 - smoothstep(vCore - 0.5, vCore + 0.5, px);
  // dashes: the gaps show the dark casing, so a dashed line still reads as one line. The period is about uDashPx
  // on screen at any distance: two world-anchored periods a power of two apart, blended by the zoom level.
  float dOn = vDash > 0.001 ? vDash : uDash;
  if (dOn > 0.001 && dOn < 0.999) {
    float lv = log2(max(uDashPx * vPerPx, 1e-4));
    float l0 = floor(lv), per = exp2(l0);
    float gap = mix(dashGap(fract(vDist / per), dOn), dashGap(fract(vDist / (2.0 * per)), dOn), lv - l0);
    inner *= 1.0 - gap;
  }
  vec3 c = mix(uCaseColor, vColor.rgb, inner);
  if (uChev > 0.0) {
    float s = fract(vDist / uPeriod + px / uPeriodPx - uTime * 0.6);
    float ch = smoothstep(0.0, 0.07, s) - smoothstep(0.2, 0.27, s);
    c = mix(c, vec3(1.0), ch * inner * 0.55 * uChev);
  }
  float a = outer * mix(uCaseAlpha, 1.0, inner) * vColor.a * uOpacity;
  if (a < 0.004) discard;
  gl_FragColor = vec4(c, a);
}`;

/** Shared per-frame uniforms of all ribbon materials. */
const RIB = { uRes: { value: new THREE.Vector2(1280, 800) }, uTime: { value: 0 } };
const tmpV2 = new THREE.Vector2();
const tmpV3 = new THREE.Vector3();

class ScreenRibbon {
  mesh: THREE.Mesh;
  mat: THREE.ShaderMaterial;
  /** centre of the drawn polylines (scales the chevron spacing with the camera distance) */
  private center = new THREE.Vector3();
  constructor(group: THREE.Group, order: number) {
    this.mat = new THREE.ShaderMaterial({
      uniforms: {
        uRes: RIB.uRes, uTime: RIB.uTime, uWidthMul: { value: 1 }, uCase: { value: 1.5 },
        uCaseColor: { value: new THREE.Color(0x0b0f14) }, uCaseAlpha: { value: 0.8 }, uOpacity: { value: 0.9 },
        uChev: { value: 0 }, uPeriod: { value: 1 }, uPeriodPx: { value: 30 },
        uDash: { value: 0 }, uDashPx: { value: 14 },
      },
      vertexShader: RIBBON_VS, fragmentShader: RIBBON_FS,
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide, fog: false, toneMapped: false,
    });
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = order;
    this.mesh.visible = false;
    this.mesh.onBeforeRender = (r, _s, cam) => {
      r.getSize(tmpV2);
      if (tmpV2.x > 0 && tmpV2.y > 0) RIB.uRes.value.copy(tmpV2);
      const pc = cam as THREE.PerspectiveCamera;
      const u = this.mat.uniforms;
      if (u.uChev.value > 0 && pc.isPerspectiveCamera) {
        const d = Math.max(1, tmpV3.copy(this.center).distanceTo(pc.position));
        const perPx = (2 * d * Math.tan((pc.fov * Math.PI) / 360)) / Math.max(1, RIB.uRes.value.y);
        u.uPeriod.value = u.uPeriodPx.value * perPx;
      }
    };
    group.add(this.mesh);
  }

  set style(o: { width?: number; opacity?: number; chevrons?: boolean; casing?: number; caseAlpha?: number; order?: number } & DashOpts) {
    const u = this.mat.uniforms;
    if (o.dash !== undefined) u.uDash.value = o.dash;
    if (o.dashPx !== undefined) u.uDashPx.value = o.dashPx;
    if (o.width !== undefined) u.uWidthMul.value = o.width;
    if (o.opacity !== undefined) u.uOpacity.value = o.opacity;
    if (o.chevrons !== undefined) u.uChev.value = o.chevrons ? 1 : 0;
    if (o.casing !== undefined) u.uCase.value = o.casing;
    if (o.caseAlpha !== undefined) u.uCaseAlpha.value = o.caseAlpha;
    if (o.order !== undefined) this.mesh.renderOrder = o.order;
  }

  /** Rebuild from polylines (null or empty hides it). Width per polyline is multiplied by the style width. */
  set(polys: RibbonPoly[] | null) {
    let nv = 0, ni = 0;
    if (polys) for (const p of polys) { const n = p.pts.length / 3; if (n >= 2) { nv += n * 2; ni += (n - 1) * 6; } }
    const old = this.mesh.geometry;
    if (!nv) { this.mesh.visible = false; return; }
    const pos = new Float32Array(nv * 3), dir = new Float32Array(nv * 3), side = new Float32Array(nv), lane = new Float32Array(nv);
    const wid = new Float32Array(nv), dist = new Float32Array(nv), colr = new Float32Array(nv * 4), dash = new Float32Array(nv);
    const idx = nv > 65535 ? new Uint32Array(ni) : new Uint16Array(ni);
    const c = new THREE.Color();
    let v = 0, k = 0, cx = 0, cy = 0, cz = 0, cn = 0;
    for (const p of polys!) {
      const P = p.pts, n = P.length / 3;
      if (n < 2) continue;
      c.set(p.color as THREE.ColorRepresentation);
      const al = p.alpha ?? 1, w = p.width ?? 1, ln = p.lane ?? 0, ds = p.dash ?? 0;
      let acc = p.dist0 ?? 0, tx = 1, ty = 0, tz = 0;
      for (let i = 0; i < n; i++) {
        // tangent from the nearest distinct neighbours (polylines may repeat points where edges meet)
        let a = i, b = i;
        while (a > 0 && Math.abs(P[a * 3] - P[i * 3]) + Math.abs(P[a * 3 + 2] - P[i * 3 + 2]) + Math.abs(P[a * 3 + 1] - P[i * 3 + 1]) < 1e-4) a--;
        while (b < n - 1 && Math.abs(P[b * 3] - P[i * 3]) + Math.abs(P[b * 3 + 2] - P[i * 3 + 2]) + Math.abs(P[b * 3 + 1] - P[i * 3 + 1]) < 1e-4) b++;
        const dx = P[b * 3] - P[a * 3], dy = P[b * 3 + 1] - P[a * 3 + 1], dz = P[b * 3 + 2] - P[a * 3 + 2];
        const l = Math.hypot(dx, dy, dz);
        if (l > 1e-6) { tx = dx / l; ty = dy / l; tz = dz / l; }
        if (i > 0) acc += Math.hypot(P[i * 3] - P[i * 3 - 3], P[i * 3 + 1] - P[i * 3 - 2], P[i * 3 + 2] - P[i * 3 - 1]);
        const li = typeof ln === 'number' ? ln : (ln[i] ?? 0);
        for (let sd = -1; sd <= 1; sd += 2) {
          pos[v * 3] = P[i * 3]; pos[v * 3 + 1] = P[i * 3 + 1]; pos[v * 3 + 2] = P[i * 3 + 2];
          dir[v * 3] = tx; dir[v * 3 + 1] = ty; dir[v * 3 + 2] = tz;
          side[v] = sd; lane[v] = li; wid[v] = w; dist[v] = acc; dash[v] = ds;
          colr[v * 4] = c.r; colr[v * 4 + 1] = c.g; colr[v * 4 + 2] = c.b; colr[v * 4 + 3] = al;
          v++;
        }
        cx += P[i * 3]; cy += P[i * 3 + 1]; cz += P[i * 3 + 2]; cn++;
        if (i > 0) {
          const q = v - 4;
          idx[k++] = q; idx[k++] = q + 1; idx[k++] = q + 2;
          idx[k++] = q + 1; idx[k++] = q + 3; idx[k++] = q + 2;
        }
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aDir', new THREE.BufferAttribute(dir, 3));
    g.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    g.setAttribute('aLane', new THREE.BufferAttribute(lane, 1));
    g.setAttribute('aWidth', new THREE.BufferAttribute(wid, 1));
    g.setAttribute('aDist', new THREE.BufferAttribute(dist, 1));
    g.setAttribute('aDash', new THREE.BufferAttribute(dash, 1));
    g.setAttribute('aColor', new THREE.BufferAttribute(colr, 4));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    this.mesh.geometry = g;
    old.dispose();
    this.center.set(cx / cn, cy / cn, cz / cn);
    this.mesh.visible = true;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); this.mat.dispose(); }
}

/** Full-screen translucent layer (dims the world under map views); drawn after the world, before ribbons. */
function dimLayer(): THREE.Mesh {
  const m = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { uDim: { value: new THREE.Vector4(0.05, 0.07, 0.1, 0) } },
    vertexShader: 'void main() { gl_Position = vec4(position.xy, 0.0, 1.0); }',
    fragmentShader: 'uniform vec4 uDim; void main() { gl_FragColor = uDim; }',
    transparent: true, depthTest: false, depthWrite: false, fog: false, toneMapped: false,
  }));
  m.frustumCulled = false;
  m.renderOrder = 45;
  m.visible = false;
  return m;
}

export class Overlay {
  group = new THREE.Group();
  private ghost: GhostMesh;
  private foot: GhostMesh;
  private hover: GhostMesh;
  private rings: GhostMesh;
  private demo: GhostMesh;
  private disc: GhostMesh;
  private arcs: ScreenRibbon;
  private shareRings: GhostMesh;
  private sigs: GhostMesh;
  /** underground view: tunnels, underground station boxes and depots seen through the ground (by depth) */
  private under: GhostMesh;
  private underKey = '';
  private dim = dimLayer();
  private demoKey = '';
  private markers = new Map<string, THREE.Mesh>();
  private markerGeo: Record<MarkerKind, THREE.BufferGeometry>;
  private crossPool: THREE.Mesh[] = [];
  private crossGeo = new THREE.RingGeometry(0.55, 1, 20).rotateX(-Math.PI / 2);
  private crossMats = new Map<string, THREE.MeshBasicMaterial>();
  private linePaths = new Map<number, ScreenRibbon>();
  private catch = new Map<string, { fill: GhostMesh; edge: ScreenRibbon }>();
  private trackLayers: ScreenRibbon[] = [];
  private segLayers = new Map<string, ScreenRibbon>();
  private hoverKey = '';
  private time = 0;
  private buf = new Buf();

  constructor(public game: Game) {
    this.ghost = new GhostMesh(this.group, 0.62, 0.2, 31);
    this.foot = new GhostMesh(this.group, 0.5, 0.16, 29);
    this.hover = new GhostMesh(this.group, 0.55, 0.14, 27);
    this.rings = new GhostMesh(this.group, 0.75, 0.12, 25);
    this.demo = new GhostMesh(this.group, 0.34, 0.1, 33);
    this.disc = new GhostMesh(this.group, 0.3, 0.08, 24);
    this.arcs = new ScreenRibbon(this.group, 52);
    this.arcs.style = { casing: 1, caseAlpha: 0.55, opacity: 1 };
    this.shareRings = new GhostMesh(this.group, 0.9, 0.3, 48);
    this.sigs = new GhostMesh(this.group, 0.95, 0.45, 42);
    this.under = new GhostMesh(this.group, 0.5, 0.42, 22);
    this.group.add(this.dim);
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
    RIB.uTime.value = this.time;
    const cp = camera.position;
    const scale = (m: THREE.Object3D, k: number) => m.scale.setScalar(Math.max(0.12, Math.min(9, cp.distanceTo(m.position) * k)));
    for (const [slot, m] of this.markers) {
      if (!m.visible) continue;
      scale(m, (m.userData.size as number) ?? 0.013);
      if (slot === 'start' || m.userData.pulse) (m.material as THREE.MeshBasicMaterial).opacity = 0.7 + 0.25 * Math.sin(this.time * 6);
    }
    for (const m of this.crossPool) if (m.visible) scale(m, 0.011);
  }

  /** Hide all tool previews (line paths, catchment rings and map layers stay). */
  clear() {
    this.setProposal(null);
    this.foot.set(null);
    this.setHoverEdge(null);
    this.setDemolish(null);
    this.disc.set(null);
    this.sigs.set(null);
    this.setCatchments('hover', null);
    this.setSegments('throat', null);
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
    const cPier = new THREE.Color().setHex(ok ? 0x2f8fd0 : 0xd0603a);
    const cPortal = new THREE.Color().setHex(ok ? 0xd2b8ff : 0xff9ad0);
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
      // centre line (rail) / lane divider (road) for readability; embedded rails for tram roads
      if (road && p.opts.tram) { ribbon(b, pts, n, 0.014, 0.05, () => cLine, 0.072); ribbon(b, pts, n, 0.014, 0.05, () => cLine, -0.072); }
      else ribbon(b, pts, n, road ? 0.025 : 0.04, 0.05, () => cLine);
      if (!road && TRACK_TYPES[p.opts.type]?.electrified) ribbon(b, pts, n, 0.012, 0.58, () => cLine);
      this.structures(b, pts, types, n, step, hw, cPier, cPortal);
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

  /** Bridge piers (every ~3 units down to the ground / water) and tunnel portal frames. */
  private structures(b: Buf, pts: Float32Array, types: Uint8Array, n: number, step: number, hw: number, cPier: THREE.Color, cPortal: THREE.Color) {
    const w = this.game.world;
    const every = Math.max(1, Math.round(3 / step));
    const tan = (i: number) => {
      const a = Math.max(0, i - 1), c = Math.min(n - 1, i + 1);
      const tx = pts[c * 3] - pts[a * 3], tz = pts[c * 3 + 2] - pts[a * 3 + 2];
      const l = Math.hypot(tx, tz) || 1;
      return [tx / l, tz / l];
    };
    let run = 0;
    for (let i = 0; i < n; i++) {
      const x = pts[i * 3], y = pts[i * 3 + 1], z = pts[i * 3 + 2];
      if (types[i] === 1) {
        if (run++ % every !== Math.floor(every / 2)) continue;
        const gy = Math.max(w.heightAt(x, z), WATER_Y - 0.3);
        if (y - gy < 0.35) continue;
        const [tx, tz] = tan(i);
        const r = 0.09;
        wall(b, x - tz * r, z + tx * r, x + tz * r, z - tx * r, gy, y - 0.02, cPier);
        wall(b, x - tx * r, z - tz * r, x + tx * r, z + tz * r, gy, y - 0.02, cPier);
      } else run = 0;
      // portal frame where a tunnel section starts or ends
      const prev = i > 0 ? types[i - 1] : types[i], next = i < n - 1 ? types[i + 1] : types[i];
      if (types[i] === 2 && (prev !== 2 || next !== 2)) {
        const [tx, tz] = tan(i);
        const rx = -tz * (hw + 0.12), rz = tx * (hw + 0.12);
        const top = y + 0.62, t = 0.07;
        wall(b, x - rx, z - rz, x - rx * 0.82, z - rz * 0.82, y, top, cPortal);
        wall(b, x + rx * 0.82, z + rz * 0.82, x + rx, z + rz, y, top, cPortal);
        wall(b, x - rx, z - rz, x + rx, z + rz, top - t, top, cPortal);
      }
    }
  }

  /** Buildings that would be demolished: translucent red boxes. */
  setDemolish(ids: number[] | null) {
    const key = ids && ids.length ? ids.join(',') : '';
    if (key === this.demoKey) return;
    this.demoKey = key;
    if (!key) { this.demo.set(null); return; }
    const b = this.buf.clear();
    const c = col(0xff3b30).clone();
    for (const id of ids!) {
      const bd = this.game.world.buildings.get(id);
      if (!bd) continue;
      boxRect(b, bd.x, bd.z, bd.angle, bd.w + 0.06, bd.d + 0.06, bd.y - 0.05, bd.y + bd.floors * FLOOR_H + 0.25, c);
    }
    this.demo.set(b);
  }

  /** Flat translucent disc at height y (e.g. the target level of the terraform brush); null hides it. */
  setDisc(d: { x: number; z: number; r: number; y: number; color?: number } | null) {
    if (!d || d.r <= 0) { this.disc.set(null); return; }
    const b = this.buf.clear();
    const c = col(d.color ?? 0xffe066).clone();
    const n = Math.max(24, Math.min(96, Math.ceil(d.r * 6)));
    for (let i = 0; i < n; i++) {
      const a0 = (i / n) * Math.PI * 2, a1 = ((i + 1) / n) * Math.PI * 2;
      b.v(d.x, d.y, d.z, c);
      b.v(d.x + Math.cos(a0) * d.r, d.y, d.z + Math.sin(a0) * d.r, c);
      b.v(d.x + Math.cos(a1) * d.r, d.y, d.z + Math.sin(a1) * d.r, c);
    }
    this.disc.set(b);
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
    const level = pl.level ?? 'ground';
    const rx = Math.cos(pl.angle), rz = -Math.sin(pl.angle);
    const w = this.game.world;
    const gy = (x: number, z: number) => Math.max(w.heightAt(x, z), WATER_Y);
    const base = col(pl.ok ? C.ok : C.bad).clone();
    if (level === 'underground') boxRect(b, fr.x, fr.z, fr.angle, fr.w, fr.d, y - 0.6, y + 0.9, col(pl.ok ? C.okTunnel : C.badTunnel).clone());
    else flatRect(b, fr.x, fr.z, fr.angle, fr.w, fr.d, y + 0.02, base);
    const cp = col(pl.ok ? 0xd9f7e2 : 0xffd2cc).clone();
    for (const p of pl.layout.platforms) flatRect(b, pl.x + rx * p.off, pl.z + rz * p.off, pl.angle, p.w, pl.length * 0.96, y + 0.1, cp);
    const ct = col(pl.ok ? 0x1d4f30 : 0x6e1d1d).clone();
    for (const o of pl.layout.trackOffsets) flatRect(b, pl.x + rx * o, pl.z + rz * o, pl.angle, 0.16, pl.length, y + 0.05, ct);
    // through tracks (no platform) run the full length and a little beyond
    const cth = col(pl.ok ? 0x4fc3ff : 0xff9a8a).clone();
    for (const o of pl.layout.throughOffsets ?? []) flatRect(b, pl.x + rx * o, pl.z + rz * o, pl.angle, 0.2, pl.length + 1.2, y + 0.06, cth);
    // street-level access: the station building, or entrance pavilions / stair towers (red: no road beside it)
    const ce = col(pl.ok ? 0xf3e7c4 : 0xffb3a8).clone(), cno = col(0xff8a7a).clone();
    if (level === 'ground') { const bd = pl.building; flatRect(b, bd.x, bd.z, bd.angle, bd.w, bd.d, y + 0.3, ce); }
    for (const e of pl.entrances ?? []) { const g0 = gy(e.x, e.z); boxRect(b, e.x, e.z, e.angle, 0.8, 1.0, g0, level === 'elevated' ? y + 0.7 : g0 + 0.6, e.access ? ce : cno); }
    if (level === 'elevated') {
      // viaduct piers under the deck
      const cpier = col(pl.ok ? C.okBridge : C.badBridge).clone();
      for (const q of pl.piers ?? []) boxRect(b, q.x, q.z, pl.angle, Math.max(0.6, fr.w * 0.5), 0.5, gy(q.x, q.z) - 0.2, y - 0.05, cpier);
    }
    this.foot.set(b);
  }

  /** Ghost of a planned depot with an arrow showing the door / track direction (underground: its cavern at depth). */
  setDepotGhost(pl: DepotPlan | null, kind: DepotKind = 'rail') {
    if (!pl) { this.foot.set(null); return; }
    const b = this.buf.clear();
    const sz = depotSize(kind);
    const y = pl.y;
    if (pl.level === 'underground') boxRect(b, pl.x, pl.z, pl.angle, sz.w, sz.d, y + UNDERGROUND_DEPOT.y0, y + UNDERGROUND_DEPOT.y1, col(pl.ok ? C.okTunnel : C.badTunnel).clone());
    else flatRect(b, pl.x, pl.z, pl.angle, sz.w, sz.d, y + 0.04, col(pl.ok ? C.ok : C.bad).clone());
    // door arrow
    const fx = Math.sin(pl.angle), fz = Math.cos(pl.angle), rx = fz, rz = -fx;
    const tipx = pl.x + fx * (sz.d / 2 + 0.55), tipz = pl.z + fz * (sz.d / 2 + 0.55);
    const bx = pl.x + fx * (sz.d / 2 - 0.1), bz = pl.z + fz * (sz.d / 2 - 0.1);
    const c = col(0xffe066).clone();
    b.v(tipx, y + 0.08, tipz, c); b.v(bx + rx * 0.45, y + 0.08, bz + rz * 0.45, c); b.v(bx - rx * 0.45, y + 0.08, bz - rz * 0.45, c);
    if (kind === 'rail') flatRect(b, pl.x, pl.z, pl.angle, 0.14, sz.d, y + 0.06, col(0x203828).clone());
    this.foot.set(b);
  }

  /**
   * Underground view (while building below ground): every tunnel section, underground station box and underground
   * depot, drawn through the ground and shaded by depth (shallow: pale violet, deep: dark blue), so new tunnels can
   * pass them at another depth. Rebuilt when the network changes; false hides it.
   */
  setUnderground(on: boolean) {
    const g = this.game, net = g.world.net, w = g.world;
    const key = on ? `${g.networkVersion}:${net.version}:${g.stations.map.size}:${g.depots.map.size}` : '';
    if (key === this.underKey) return;
    this.underKey = key;
    if (!on) { this.under.set(null); return; }
    const b = this.buf.clear();
    const shallow = new THREE.Color(0xd8c4ff), deep = new THREE.Color(0x2c4bd6), tmp = new THREE.Color();
    const shade = (depth: number) => tmp.copy(shallow).lerp(deep, Math.max(0, Math.min(1, (depth - 0.8) / 3))).clone();
    for (const e of net.edges.values()) {
      if (!e.sections.some((q) => q.type === 'tunnel')) continue;
      const geo = net.geo(e), hw = net.halfWidth(e) + 0.08;
      const pts: number[] = [], cols: THREE.Color[] = [];
      const flush = () => { if (pts.length >= 6) { const n = pts.length / 3, cc = cols.slice(); ribbon(b, pts, n, hw, 0.06, (i) => cc[i]); } pts.length = 0; cols.length = 0; };
      for (let i = 0; i < geo.n; i++) {
        if (net.sectionAt(e, geo.cum[i]) !== 'tunnel') { flush(); continue; }
        const x = geo.pts[i * 3], y = geo.pts[i * 3 + 1], z = geo.pts[i * 3 + 2];
        pts.push(x, y, z);
        cols.push(shade(w.heightAt(x, z) - y));
      }
      flush();
    }
    for (const st of g.stations.map.values()) {
      const r = st.rail;
      if (!r || (r.level ?? 'ground') !== 'underground') continue;
      const q = g.stations.undergroundBox(st)!;
      boxRect(b, q.x, q.z, q.angle, q.w, q.d, q.y0, q.y1, shade(r.depth ?? 2));
    }
    for (const d of g.depots.map.values()) {
      if (d.level !== 'underground') continue;
      const q = depotVolume(d);
      boxRect(b, q.x, q.z, q.angle, q.w, q.d, q.y0, q.y1, shade(d.depth ?? 2));
    }
    this.under.set(b);
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

  // ---------------------------------------------------------------- demand view
  /** Desire lines: raised arcs (height = h at the middle) with a constant screen width; drawn in the given order. */
  setArcs(arcs: Arc[] | null) {
    if (!arcs || !arcs.length) { this.arcs.set(null); return; }
    const w = this.game.world;
    const polys: RibbonPoly[] = [];
    for (const a of arcs) {
      const ya = Math.max(w.heightAt(a.ax, a.az), WATER_Y) + 1.2, yb = Math.max(w.heightAt(a.bx, a.bz), WATER_Y) + 1.2;
      const d = Math.hypot(a.bx - a.ax, a.bz - a.az);
      const n = Math.max(12, Math.min(48, Math.ceil(d / 5)));
      const pts = new Float32Array((n + 1) * 3);
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        pts[i * 3] = a.ax + (a.bx - a.ax) * t;
        pts[i * 3 + 1] = ya + (yb - ya) * t + 4 * a.h * t * (1 - t);
        pts[i * 3 + 2] = a.az + (a.bz - a.az) * t;
      }
      polys.push({ pts, color: a.color, alpha: a.alpha ?? 0.9, width: a.w, dash: a.dash });
    }
    this.arcs.set(polys);
  }

  /**
   * Planned signals: a post with an arrow head pointing the way trains may pass (two-way: a diamond); signals
   * already there are drawn grey.
   */
  setSignalGhosts(spots: { x: number; y: number; z: number; dx: number; dz: number; existing: boolean; twoWay: boolean; color?: number; size?: number }[] | null) {
    if (!spots || !spots.length) { this.sigs.set(null); return; }
    const b = this.buf.clear();
    for (const s of spots) {
      const l = Math.hypot(s.dx, s.dz) || 1, fx = s.dx / l, fz = s.dz / l, rx = fz, rz = -fx;
      const c = col(s.color ?? (s.existing ? 0x9aa5b4 : 0xffb020)).clone();
      const y = s.y + 0.35, k = 0.5 * (s.size ?? 1);
      // post beside the track
      boxRect(b, s.x + rx * 0.55, s.z + rz * 0.55, Math.atan2(fx, fz), 0.12, 0.12, s.y, s.y + 0.9, c);
      if (s.twoWay) {
        b.v(s.x + fx * k, y, s.z + fz * k, c); b.v(s.x + rx * k * 0.6, y, s.z + rz * k * 0.6, c); b.v(s.x - fx * k, y, s.z - fz * k, c);
        b.v(s.x + fx * k, y, s.z + fz * k, c); b.v(s.x - fx * k, y, s.z - fz * k, c); b.v(s.x - rx * k * 0.6, y, s.z - rz * k * 0.6, c);
      } else {
        b.v(s.x + fx * k, y, s.z + fz * k, c); b.v(s.x - fx * k * 0.5 + rx * k * 0.7, y, s.z - fz * k * 0.5 + rz * k * 0.7, c); b.v(s.x - fx * k * 0.5 - rx * k * 0.7, y, s.z - fz * k * 0.5 - rz * k * 0.7, c);
      }
    }
    this.sigs.set(b);
  }

  /**
   * Coloured track layers in screen space (e.g. signal blocks by occupancy): each layer is a set of polylines
   * (xyz) drawn with its colour and width (px), optionally dashed, later layers on top. Null clears them.
   */
  setTrackLayers(layers: ({ pts: Float32Array[]; color: number; width: number } & DashOpts)[] | null) {
    const n = layers?.length ?? 0;
    while (this.trackLayers.length < n) this.trackLayers.push(new ScreenRibbon(this.group, 46 + this.trackLayers.length));
    this.trackLayers.forEach((r, i) => {
      const L = layers?.[i];
      if (!L || !L.pts.length) { r.set(null); return; }
      r.style = { width: L.width, opacity: 0.95, casing: 1, caseAlpha: 0.6, chevrons: false, dash: L.dash ?? 0, dashPx: L.dashPx ?? 14 };
      r.set(L.pts.map((pts) => ({ pts, color: L.color })));
    });
  }

  /**
   * Straight guide segments (e.g. the throat connections of a station inserted into a line, walking catchments),
   * keyed layers, optionally dashed; `s0` = distance along the street at the segment's start keeps dashes running on.
   */
  setSegments(key: string, segs: { x0: number; z0: number; x1: number; z1: number; s0?: number }[] | null, color = 0xffd84a, o: DashOpts = {}) {
    let r = this.segLayers.get(key);
    if (!segs || !segs.length) { r?.set(null); return; }
    if (!r) { r = new ScreenRibbon(this.group, 53); r.style = { width: 3, opacity: 0.95, casing: 1, caseAlpha: 0.6, chevrons: false }; this.segLayers.set(key, r); }
    r.style = { dash: o.dash ?? 0, dashPx: o.dashPx ?? 14 };
    const w = this.game.world;
    const y = (x: number, z: number) => Math.max(w.heightAt(x, z), WATER_Y) + 0.4;
    r.set(segs.map((q) => {
      const n = Math.max(2, Math.ceil(Math.hypot(q.x1 - q.x0, q.z1 - q.z0) / 2) + 1);
      const pts = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) { const t = i / (n - 1), x = q.x0 + (q.x1 - q.x0) * t, z = q.z0 + (q.z1 - q.z0) * t; pts[i * 3] = x; pts[i * 3 + 1] = y(x, z); pts[i * 3 + 2] = z; }
      return { pts, color, dist0: q.s0 ?? 0 };
    }));
  }

  /** Dim the world under map views (0 = off). */
  setDim(alpha: number) {
    const u = (this.dim.material as THREE.ShaderMaterial).uniforms.uDim.value as THREE.Vector4;
    u.w = alpha;
    this.dim.visible = alpha > 0.001;
  }

  /** Terrain-draped town rings: a dim base ring with a progress arc (share transported). */
  setShareRings(rings: ShareRing[] | null) {
    if (!rings || !rings.length) { this.shareRings.set(null); return; }
    const w = this.game.world;
    const b = this.buf.clear();
    const base = col(0x3a4452).clone();
    for (const r of rings) {
      const c = col(r.color).clone();
      const n = Math.max(32, Math.min(200, Math.ceil(r.r * 3)));
      const pts = new Float32Array((n + 1) * 3);
      for (let i = 0; i <= n; i++) {
        const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
        const x = r.x + Math.cos(a) * r.r, z = r.z + Math.sin(a) * r.r;
        pts[i * 3] = x; pts[i * 3 + 1] = Math.max(w.heightAt(x, z), WATER_Y); pts[i * 3 + 2] = z;
      }
      const cut = Math.round(Math.max(0, Math.min(1, r.frac)) * n);
      const hw = Math.max(0.18, r.r * 0.035);
      ribbon(b, pts, n + 1, hw * 0.6, 0.18, () => base);
      if (cut > 0) ribbon(b, pts.subarray(0, (cut + 1) * 3), cut + 1, hw, 0.22, () => c);
    }
    this.shareRings.set(b);
  }

  // ---------------------------------------------------------------- catchment areas
  /**
   * Catchment circles as soft terrain-draped fills with crisp outlines, in independent layers (`key`: e.g. the
   * placement preview, the selected station, the map layer of all stations). Null or empty clears the layer.
   */
  setCatchments(key: string, circles: CatchCircle[] | null) {
    let L = this.catch.get(key);
    if (!circles || !circles.length) { if (L) { L.fill.set(null); L.edge.set(null); } return; }
    if (!L) {
      L = { fill: new GhostMesh(this.group, 0.15, 0.05, 23), edge: new ScreenRibbon(this.group, 49) };
      L.edge.style = { width: 2, opacity: 0.9, casing: 1, caseAlpha: 0.45, chevrons: false };
      this.catch.set(key, L);
    }
    const w = this.game.world;
    const b = this.buf.clear();
    const rings: RibbonPoly[] = [];
    const RF = [0, 0.34, 0.62, 0.84, 1];
    // circles of one colour form one area: fill and outline only what no other circle of that colour covers
    const cell = Math.max(8, ...circles.map((c) => c.r));
    const grid = new Map<string, number[]>();
    circles.forEach((c, i) => { const k = `${Math.floor(c.x / cell)},${Math.floor(c.z / cell)}`; const a = grid.get(k); if (a) a.push(i); else grid.set(k, [i]); });
    const covered = (x: number, z: number, i: number, before: boolean) => {
      const cx = Math.floor(x / cell), cz = Math.floor(z / cell), col0 = circles[i].color;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) for (const j of grid.get(`${cx + dx},${cz + dz}`) ?? []) {
        if (j === i || (before && j > i)) continue;
        const o = circles[j];
        if (o.color === col0 && (o.x - x) ** 2 + (o.z - z) ** 2 < o.r * o.r * 0.999) return true;
      }
      return false;
    };
    const yAt = (x: number, z: number) => Math.max(w.heightAt(x, z), WATER_Y) + 0.1;
    circles.forEach((c, ci) => {
      const color = col(c.color).clone();
      const n = Math.max(24, Math.min(96, Math.ceil(c.r * 1.6)));
      const P = (ri: number, k: number): [number, number, number] => {
        const a = (k / n) * Math.PI * 2, rr = RF[ri] * c.r;
        const x = c.x + Math.cos(a) * rr, z = c.z + Math.sin(a) * rr;
        return [x, yAt(x, z), z];
      };
      for (let ri = 0; ri < RF.length - 1; ri++) for (let k = 0; k < n; k++) {
        const a0 = P(ri, k), a1 = P(ri, k + 1), b0 = P(ri + 1, k), b1 = P(ri + 1, k + 1);
        const mx = (a0[0] + a1[0] + b0[0] + b1[0]) / 4, mz = (a0[2] + a1[2] + b0[2] + b1[2]) / 4;
        if (covered(mx, mz, ci, true)) continue;
        b.quad(a0[0], a0[1], a0[2], a1[0], a1[1], a1[2], b1[0], b1[1], b1[2], b0[0], b0[1], b0[2], color);
      }
      // outline pieces outside the other circles
      let run: number[] = [];
      const flush = () => { if (run.length >= 6) rings.push({ pts: Float32Array.from(run), color: c.color }); run = []; };
      for (let k = 0; k <= n; k++) {
        const q = P(RF.length - 1, k);
        if (covered(q[0], q[2], ci, false)) { flush(); continue; }
        run.push(q[0], q[1] + 0.05, q[2]);
      }
      flush();
    });
    L.fill.set(b);
    L.edge.set(rings);
  }

  // ---------------------------------------------------------------- line paths
  /** Show a line's route (polylines, xyz) as a screen-space ribbon in its colour; null removes it. */
  setLinePath(id: number, curves: Float32Array[] | null, color = '#ffffff', o: LinePathOpts = {}) {
    let m = this.linePaths.get(id);
    if (!curves || !curves.length) {
      if (m) { m.dispose(); this.linePaths.delete(id); }
      return;
    }
    if (!m) { m = new ScreenRibbon(this.group, 50); this.linePaths.set(id, m); }
    const lift = o.lift ?? ROUTE_LIFT;
    m.set(curves.map((pts, i) => {
      const q = new Float32Array(pts);
      for (let k = 1; k < q.length; k += 3) q[k] += lift;
      return { pts: q, color, lane: o.lanes?.[i] ?? o.offset ?? 0 };
    }));
    this.setLinePathStyle(id, o);
  }
  /** Change the width (px), opacity, chevrons or draw order of a shown route without rebuilding it. */
  setLinePathStyle(id: number, o: LinePathOpts) {
    const m = this.linePaths.get(id);
    if (m) m.style = { width: o.width ?? 5, opacity: o.opacity ?? 0.9, chevrons: o.chevrons ?? true, order: 50 + (o.order ?? 0) };
  }
  linePathIds() { return [...this.linePaths.keys()]; }

  dispose() {
    for (const g of [this.ghost, this.foot, this.hover, this.rings, this.demo, this.disc, this.arcs, this.shareRings, this.sigs, this.under, ...this.linePaths.values()]) g.dispose();
    for (const L of this.catch.values()) { L.fill.dispose(); L.edge.dispose(); }
    for (const r of [...this.trackLayers, ...this.segLayers.values()]) r.dispose();
    for (const g of Object.values(this.markerGeo)) g.dispose();
    for (const m of this.markers.values()) (m.material as THREE.Material).dispose();
    for (const m of this.crossMats.values()) m.dispose();
    this.crossGeo.dispose();
    this.dim.geometry.dispose(); (this.dim.material as THREE.Material).dispose();
    this.group.clear();
  }
}
