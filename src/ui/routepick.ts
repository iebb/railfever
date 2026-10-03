// Lines map: which route is under the pointer. The route polylines are put into a grid of world cells once, whenever
// the routes are rebuilt, as chunks of a few samples with a bounding sphere (a return leg drawn over its outward leg
// only once). A pick follows the pointer's ray through the height band the routes occupy and looks only at the cells
// inside a thin cone around it (as wide as the widest side-by-side lane plus the hit distance, at any tilt); the
// segments of a candidate chunk (its chord, where its bend is under a pixel) are then measured on screen with their
// lane offsets, as the ribbon shader in overlay.ts draws them.
import * as THREE from 'three';
import { ROUTE_LIFT } from '../render/overlay';

/** A route under the pointer: its line, the nearest point on it (world) and the distance from the pointer (px). */
export interface RouteHit { line: number; x: number; y: number; z: number; d: number }

/** world units per grid cell, and per coarse cell (8 × 8 cells, so empty land is skipped quickly) */
const CELL = 8, COARSE = 64;
/**
 * samples per indexed chunk: a candidate chunk is tested as its chord where its bend projects under CHORD_PX and its
 * lane is constant (far views), else segment by segment (close up, tight curves, lanes changing at junctions)
 */
const STRIDE = 16, CHORD_PX = 0.75;
/** px from a ribbon's centre line that count as on it (5 px route with its casing, plus a little slack) */
const HIT_PX = 7;
/** an already hovered line wins near-ties by this many px, so the hover doesn't flicker between lanes */
const STICKY_PX = 1.5;
/** px of slack in the culls (rounding) */
const SLACK_PX = 2;
/** a sphere's projected radius over its radius × focal length / depth, off the screen centre (conservative) */
const STRETCH = 1.6;
/**
 * per chunk: curve, first and last sample, bounding sphere (centre at route height, radius), widest lane and lane
 * change (px), largest distance of a sample from the chord (world units)
 */
const CH = 10;

const cellKey = (cx: number, cz: number) => (cz + 2048) * 8192 + (cx + 2048);

/** Narrow [r.t0, r.t1] to the ray parameters t with c + m t <= 0. */
function clip(r: { t0: number; t1: number }, c: number, m: number) {
  if (Math.abs(m) < 1e-12) { if (c > 0) r.t1 = -Infinity; return; }
  const t = -c / m;
  if (m > 0) r.t1 = Math.min(r.t1, t); else r.t0 = Math.max(r.t0, t);
}

/** Is curve q the same track as p travelled the other way (the return leg of an out-and-back line, same lane)? */
function isReturnLeg(p: Float32Array, pl: ArrayLike<number> | null, q: Float32Array, ql: ArrayLike<number> | null): boolean {
  const n = p.length / 3;
  if (q.length !== p.length || !pl !== !ql) return false;
  for (let i = 0; i < n; i++) {
    const j = (n - 1 - i) * 3;
    if (p[i * 3] !== q[j] || p[i * 3 + 1] !== q[j + 1] || p[i * 3 + 2] !== q[j + 2]) return false;
    if (pl && ql && Math.abs(pl[i] + ql[n - 1 - i]) > 1e-3) return false;
  }
  return true;
}

export class RouteIndex {
  private grid = new Map<number, number[]>();
  private coarse = new Set<number>();
  private curves: { line: number; pts: Float32Array; lane: ArrayLike<number> | null }[] = [];
  private chunks: number[] = [];
  private maxLane = 0;
  /** box around every route point (at route height) */
  private lo = new THREE.Vector3();
  private hi = new THREE.Vector3();
  /** chunks already looked at in this pick */
  private seen = new Uint32Array(0);
  private stamp = 0;
  private o = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private v = new THREE.Vector3();
  private range = { t0: 0, t1: 0 };
  private a = { x: 0, y: 0 };
  private b = { x: 0, y: 0 };
  private e = { x: 0, y: 0 };
  private focal = 1;
  private best: RouteHit = { line: 0, x: 0, y: 0, z: 0, d: 0 };
  private bestD = Infinity;
  private found = false;

  /** Rebuild from the routes shown: line id, polylines (xyz) and their lane offsets (px per vertex, see laneOffsets). */
  build(routes: { id: number; curves: Float32Array[]; lanes?: ArrayLike<number>[] }[]) {
    this.grid.clear();
    this.coarse.clear();
    this.curves.length = 0;
    this.chunks.length = 0;
    this.maxLane = 0;
    const lo = this.lo.set(Infinity, Infinity, Infinity), hi = this.hi.set(-Infinity, -Infinity, -Infinity);
    for (const r of routes) r.curves.forEach((pts, ci) => {
      const n = pts.length / 3;
      if (n < 2) return;
      const lane = r.lanes?.[ci] ?? null;
      // (a return leg is drawn exactly over its outward leg: indexed once)
      for (let cj = 0; cj < ci; cj++) if (isReturnLeg(r.curves[cj], r.lanes?.[cj] ?? null, pts, lane)) return;
      const k = this.curves.push({ line: r.id, pts, lane }) - 1;
      for (let a = 0; a < n - 1;) {
        const b = Math.min(n - 1, a + STRIDE);
        let x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
        let lw = 0, lmin = Infinity, lmax = -Infinity, dev = 0;
        const ax = pts[a * 3], ay = pts[a * 3 + 1], az = pts[a * 3 + 2];
        const ux = pts[b * 3] - ax, uy = pts[b * 3 + 1] - ay, uz = pts[b * 3 + 2] - az, ul = ux * ux + uy * uy + uz * uz;
        for (let i = a; i <= b; i++) {
          const x = pts[i * 3], y = pts[i * 3 + 1] + ROUTE_LIFT, z = pts[i * 3 + 2];
          if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; if (z < z0) z0 = z; if (z > z1) z1 = z;
          const li = lane ? lane[i] : 0;
          lw = Math.max(lw, Math.abs(li)); lmin = Math.min(lmin, li); lmax = Math.max(lmax, li);
          // distance from the chord
          const px = x - ax, py = y - ROUTE_LIFT - ay, pz = z - az;
          const f = ul > 1e-12 ? Math.max(0, Math.min(1, (px * ux + py * uy + pz * uz) / ul)) : 0;
          dev = Math.max(dev, Math.sqrt((px - ux * f) ** 2 + (py - uy * f) ** 2 + (pz - uz * f) ** 2));
        }
        this.maxLane = Math.max(this.maxLane, lw);
        const id = this.chunks.length / CH;
        this.chunks.push(k, a, b, (x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2, Math.sqrt((x1 - x0) ** 2 + (y1 - y0) ** 2 + (z1 - z0) ** 2) / 2, lw, lmax - lmin, dev);
        lo.x = Math.min(lo.x, x0); lo.y = Math.min(lo.y, y0); lo.z = Math.min(lo.z, z0);
        hi.x = Math.max(hi.x, x1); hi.y = Math.max(hi.y, y1); hi.z = Math.max(hi.z, z1);
        for (let cz = Math.floor(z0 / CELL); cz <= Math.floor(z1 / CELL); cz++) for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
          const key = cellKey(cx, cz);
          const arr = this.grid.get(key);
          if (arr) arr.push(id); else this.grid.set(key, [id]);
          this.coarse.add(cellKey(Math.floor(cx * CELL / COARSE), Math.floor(cz * CELL / COARSE)));
        }
        a = b;
      }
    });
    const n = this.chunks.length / CH;
    if (this.seen.length < n) this.seen = new Uint32Array(Math.max(n, this.seen.length * 2));
    else this.seen.fill(0);
    this.stamp = 0;
  }

  get empty() { return this.curves.length === 0; }

  /**
   * The route whose ribbon passes within HIT_PX of a screen point (client px, `rect`: the 3D view's box), nearest
   * first; `prefer` (the line already hovered) wins near-ties.
   */
  pick(camera: THREE.PerspectiveCamera, rect: DOMRect, cx: number, cy: number, prefer: number | null): RouteHit | null {
    if (!this.chunks.length) return null;
    const o = this.o.setFromMatrixPosition(camera.matrixWorld);
    const d = this.dir.set(((cx - rect.left) / rect.width) * 2 - 1, -((cy - rect.top) / rect.height) * 2 + 1, 0.5).unproject(camera).sub(o).normalize();
    // a ribbon within reach of the pointer has its track within `reach` px of it (lanes beside it, its width): those
    // points lie inside a cone around the ray of half angle atan(reach / focal length) — px per radian only grow
    // away from the screen centre, so the cone is conservative everywhere on screen
    const focal = (this.focal = rect.height / (2 * Math.tan((camera.fov * Math.PI) / 360)));
    const ta = (this.maxLane + HIT_PX + SLACK_PX) / focal;
    // the stretch of the ray whose cone meets the routes' box: their height band (at the ray's real slope: at a low
    // tilt this runs far over the ground), then their ground extent; nothing is drawn beyond the far plane
    const r = this.range, lo = this.lo, hi = this.hi;
    r.t0 = Math.max(0, camera.near); r.t1 = camera.far * 1.5;
    clip(r, o.y - hi.y, d.y - ta);
    clip(r, lo.y - o.y, -(d.y + ta));
    if (!(r.t0 <= r.t1)) return null;
    const R = ta * r.t1 + 1;
    clip(r, lo.x - R - o.x, -d.x); clip(r, o.x - hi.x - R, d.x);
    clip(r, lo.z - R - o.z, -d.z); clip(r, o.z - hi.z - R, d.z);
    if (!(r.t0 <= r.t1)) return null;
    if (++this.stamp > 0xfffffff0) { this.seen.fill(0); this.stamp = 1; }
    this.found = false; this.bestD = Infinity;
    // march along it from the camera: every step covers the cells within the cone's radius around that piece of the
    // ray (near hits found first let farther candidates be dismissed quickly)
    const dxz = Math.sqrt(d.x * d.x + d.z * d.z);
    for (let t = r.t0, n = 0; t < r.t1 && n < 4096; n++) {
      const step = Math.min(r.t1 - t, Math.max(CELL / 2, ta * t) / Math.max(dxz, 0.05));
      if (!(step > 1e-6)) break;
      const te = t + step, tm = t + step / 2;
      const q = ta * te + (dxz * step) / 2 + 0.5;
      this.visit(o.x + d.x * tm - q, o.z + d.z * tm - q, o.x + d.x * tm + q, o.z + d.z * tm + q, camera, rect, cx, cy, prefer);
      t = te;
    }
    return this.found ? { ...this.best } : null;
  }

  /** Test the chunks in the cells of a ground rectangle (coarse cells without routes are skipped). */
  private visit(x0: number, z0: number, x1: number, z1: number, camera: THREE.PerspectiveCamera, rect: DOMRect, cx: number, cy: number, prefer: number | null) {
    const fx0 = Math.floor(x0 / CELL), fx1 = Math.floor(x1 / CELL), fz0 = Math.floor(z0 / CELL), fz1 = Math.floor(z1 / CELL);
    const per = COARSE / CELL;
    for (let gz = Math.floor(fz0 / per); gz <= Math.floor(fz1 / per); gz++) for (let gx = Math.floor(fx0 / per); gx <= Math.floor(fx1 / per); gx++) {
      if (!this.coarse.has(cellKey(gx, gz))) continue;
      for (let z = Math.max(fz0, gz * per); z <= Math.min(fz1, gz * per + per - 1); z++) for (let x = Math.max(fx0, gx * per); x <= Math.min(fx1, gx * per + per - 1); x++) {
        const ids = this.grid.get(cellKey(x, z));
        if (ids) for (const id of ids) {
          if (this.seen[id] === this.stamp) continue;
          this.seen[id] = this.stamp;
          this.testChunk(id, camera, rect, cx, cy, prefer);
        }
      }
    }
  }

  /** A candidate chunk: culled by its cone and a screen bound, then every segment on screen with its lanes. */
  private testChunk(id: number, camera: THREE.PerspectiveCamera, rect: DOMRect, cx: number, cy: number, prefer: number | null) {
    const ch = this.chunks, j = id * CH, o = this.o, d = this.dir;
    // the bounding sphere must reach into the cone of this chunk's own lanes
    const vx = ch[j + 3] - o.x, vy = ch[j + 4] - o.y, vz = ch[j + 5] - o.z, rad = ch[j + 6], lw = ch[j + 7];
    const tc = vx * d.x + vy * d.y + vz * d.z;
    if (tc + rad < 0) return;
    const perp = Math.sqrt(Math.max(0, vx * vx + vy * vy + vz * vz - tc * tc));
    if (perp - rad > ((tc + rad) * (lw + HIT_PX + SLACK_PX)) / this.focal + 1e-3) return;
    // ... and on screen get nearer than the best hit so far: its centre's distance less its projected radius and its
    // widest lane
    const C = this.a;
    const depth = this.screenDepth(camera, rect, ch[j + 3], ch[j + 4], ch[j + 5], C);
    const near = Math.max(depth - rad, camera.near);
    if (depth > 0) {
      const dc = Math.sqrt((cx - C.x) ** 2 + (cy - C.y) ** 2);
      if (dc - (STRETCH * rad * this.focal) / near - lw > Math.min(HIT_PX, this.bestD + STICKY_PX)) return;
    }
    // far away its bend is under a pixel: its chord stands for it where the lane holds; else every segment
    const c = this.curves[ch[j]], P = c.pts, i0 = ch[j + 1], i1 = ch[j + 2];
    const step = depth > 0 && ch[j + 8] <= 1 && (STRETCH * ch[j + 9] * this.focal) / near <= CHORD_PX ? i1 - i0 : 1;
    const A = this.a, B = this.b;
    let okA = this.laneScreen(P, c.lane, i0, camera, rect, A);
    for (let i = i0; i < i1; i += step) {
      const k = Math.min(i1, i + step);
      const okB = this.laneScreen(P, c.lane, k, camera, rect, B);
      if (okA && okB) {
        const sx = B.x - A.x, sy = B.y - A.y, sl = sx * sx + sy * sy;
        const t = sl > 1e-9 ? Math.max(0, Math.min(1, ((cx - A.x) * sx + (cy - A.y) * sy) / sl)) : 0;
        const ex = cx - (A.x + sx * t), ey = cy - (A.y + sy * t);
        let dist = Math.sqrt(ex * ex + ey * ey);
        if (dist <= HIT_PX) {
          if (c.line === prefer) dist -= STICKY_PX;
          if (dist < this.bestD) {
            this.bestD = dist; this.found = true;
            const p = i * 3, q = k * 3, h = this.best;
            h.line = c.line; h.d = Math.max(0, dist);
            h.x = P[p] + (P[q] - P[p]) * t; h.y = P[p + 1] + (P[q + 1] - P[p + 1]) * t; h.z = P[p + 2] + (P[q + 2] - P[p + 2]) * t;
          }
        }
      }
      A.x = B.x; A.y = B.y; okA = okB;
    }
  }

  /**
   * Client px of sample i of a route moved sideways by its lane as the ribbon shader does it: along the screen normal
   * of the tangent between its nearest distinct neighbours (false behind the camera).
   */
  private laneScreen(P: Float32Array, lane: ArrayLike<number> | null, i: number, camera: THREE.Camera, rect: DOMRect, out: { x: number; y: number }): boolean {
    const x = P[i * 3], y = P[i * 3 + 1] + ROUTE_LIFT, z = P[i * 3 + 2];
    if (!this.screen(camera, rect, x, y, z, out)) return false;
    const off = lane ? lane[i] : 0;
    if (!off) return true;
    const n = P.length / 3;
    let a = i, b = i;
    while (a > 0 && Math.abs(P[a * 3] - x) + Math.abs(P[a * 3 + 1] + ROUTE_LIFT - y) + Math.abs(P[a * 3 + 2] - z) < 1e-4) a--;
    while (b < n - 1 && Math.abs(P[b * 3] - x) + Math.abs(P[b * 3 + 1] + ROUTE_LIFT - y) + Math.abs(P[b * 3 + 2] - z) < 1e-4) b++;
    let tx = P[b * 3] - P[a * 3], ty = P[b * 3 + 1] - P[a * 3 + 1], tz = P[b * 3 + 2] - P[a * 3 + 2];
    const tl = Math.sqrt(tx * tx + ty * ty + tz * tz);
    if (tl < 1e-6) return true;
    tx /= tl; ty /= tl; tz /= tl;
    const e = this.e;
    if (!this.screen(camera, rect, x + tx * 0.2, y + ty * 0.2, z + tz * 0.2, e)) return true;
    const dx = e.x - out.x, dy = e.y - out.y, dl = Math.sqrt(dx * dx + dy * dy);
    if (dl < 1e-9) return true;
    // (overlay.ts RIBBON_VS: the normal (-d.y, d.x) of the direction with y up is (dy, -dx) in y-down px)
    out.x += (dy / dl) * off;
    out.y -= (dx / dl) * off;
    return true;
  }

  /** Client px of a world point (false behind the camera). */
  private screen(camera: THREE.Camera, rect: DOMRect, x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const v = this.v.set(x, y, z).project(camera);
    if (v.z > 1 || v.z < -1) return false;
    out.x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
    out.y = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
    return true;
  }

  /** Client px of a world point and its depth in front of the camera (<= 0: behind it, `out` unset). */
  private screenDepth(camera: THREE.Camera, rect: DOMRect, x: number, y: number, z: number, out: { x: number; y: number }): number {
    const v = this.v.set(x, y, z).applyMatrix4(camera.matrixWorldInverse);
    const depth = -v.z;
    if (depth <= 0) return depth;
    v.applyMatrix4(camera.projectionMatrix);
    out.x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
    out.y = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
    return depth;
  }
}
