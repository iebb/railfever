// Lines map: which route is under the pointer. The route polylines are put into a grid of world cells once, whenever
// the routes are rebuilt; a hover looks only at the cells around the ground point under the pointer and measures the
// screen distance to the ribbons there, with their side-by-side lanes, as overlay.ts draws them.
import * as THREE from 'three';
import { ROUTE_LIFT } from '../render/overlay';

/** A route under the pointer: its line, the nearest point on it (world) and the distance from the pointer (px). */
export interface RouteHit { line: number; x: number; y: number; z: number; d: number }

/** world units per grid cell */
const CELL = 8;
/** index every 4th sample of the 0.25-unit edge geometry (about one unit; the chords stay on the curve) */
const STRIDE = 4;
/** px from a ribbon's centre line that count as on it (5 px route with its casing, plus a little slack) */
const HIT_PX = 7;
/** an already hovered line wins near-ties by this many px, so the hover doesn't flicker between lanes */
const STICKY_PX = 1.5;

const cellKey = (cx: number, cz: number) => (cz + 2048) * 8192 + (cx + 2048);

export class RouteIndex {
  private grid = new Map<number, number[]>();
  private curves: { line: number; pts: Float32Array; lane: ArrayLike<number> | null }[] = [];
  private maxLane = 0;
  private v = new THREE.Vector3();
  private a = { x: 0, y: 0 };
  private b = { x: 0, y: 0 };

  /** Rebuild from the routes shown: line id, polylines (xyz) and their lane offsets (px per vertex, see laneOffsets). */
  build(routes: { id: number; curves: Float32Array[]; lanes?: ArrayLike<number>[] }[]) {
    this.grid.clear();
    this.curves.length = 0;
    this.maxLane = 0;
    for (const r of routes) r.curves.forEach((pts, ci) => {
      const n = pts.length / 3;
      if (n < 2) return;
      const lane = r.lanes?.[ci] ?? null;
      const k = this.curves.push({ line: r.id, pts, lane }) - 1;
      if (lane) for (let i = 0; i < n; i++) this.maxLane = Math.max(this.maxLane, Math.abs(lane[i]));
      for (let a = 0; a < n - 1;) {
        const b = Math.min(n - 1, a + STRIDE);
        const x0 = Math.floor(Math.min(pts[a * 3], pts[b * 3]) / CELL), x1 = Math.floor(Math.max(pts[a * 3], pts[b * 3]) / CELL);
        const z0 = Math.floor(Math.min(pts[a * 3 + 2], pts[b * 3 + 2]) / CELL), z1 = Math.floor(Math.max(pts[a * 3 + 2], pts[b * 3 + 2]) / CELL);
        for (let cz = z0; cz <= z1; cz++) for (let cx = x0; cx <= x1; cx++) {
          const key = cellKey(cx, cz);
          const arr = this.grid.get(key);
          if (arr) arr.push(k, a, b); else this.grid.set(key, [k, a, b]);
        }
        a = b;
      }
    });
  }

  get empty() { return this.curves.length === 0; }

  /**
   * The route whose ribbon passes within HIT_PX of a screen point (client px), nearest first; `ground` is the terrain
   * point under it, `rect` the 3D view's box, `prefer` the line already hovered.
   */
  pick(camera: THREE.PerspectiveCamera, rect: DOMRect, cx: number, cy: number, ground: THREE.Vector3, prefer: number | null): RouteHit | null {
    if (!this.curves.length) return null;
    const cp = camera.position;
    const dist = Math.max(1, cp.distanceTo(ground));
    const perPx = (2 * dist * Math.tan((camera.fov * Math.PI) / 360)) / Math.max(1, rect.height);
    const sinE = Math.max(0.2, (cp.y - ground.y) / dist);
    // world radius around the ground point that holds every ribbon within reach: lanes, width and foreshortening, and
    // routes a few units above or below the ground (viaducts, tunnels) seen at an angle
    const r = Math.min(80, ((this.maxLane + HIT_PX + 2) * perPx) / sinE + 4 / Math.max(0.35, sinE));
    const gx = ground.x, gz = ground.z;
    const cx0 = Math.floor((gx - r) / CELL), cx1 = Math.floor((gx + r) / CELL), cz0 = Math.floor((gz - r) / CELL), cz1 = Math.floor((gz + r) / CELL);
    let best: RouteHit | null = null, bestD = Infinity;
    const A = this.a, B = this.b;
    for (let cz = cz0; cz <= cz1; cz++) for (let ccx = cx0; ccx <= cx1; ccx++) {
      const arr = this.grid.get(cellKey(ccx, cz));
      if (!arr) continue;
      for (let i = 0; i < arr.length; i += 3) {
        const c = this.curves[arr[i]], P = c.pts, ia = arr[i + 1] * 3, ib = arr[i + 2] * 3;
        // cheap cull in the ground plane before projecting
        const ex = P[ib] - P[ia], ez = P[ib + 2] - P[ia + 2], el = ex * ex + ez * ez;
        const tw = el > 1e-9 ? Math.max(0, Math.min(1, ((gx - P[ia]) * ex + (gz - P[ia + 2]) * ez) / el)) : 0;
        if ((P[ia] + ex * tw - gx) ** 2 + (P[ia + 2] + ez * tw - gz) ** 2 > r * r) continue;
        if (!this.screen(camera, rect, P[ia], P[ia + 1] + ROUTE_LIFT, P[ia + 2], A) || !this.screen(camera, rect, P[ib], P[ib + 1] + ROUTE_LIFT, P[ib + 2], B)) continue;
        // the ribbon runs beside the track by its lane: the screen normal (dy, -dx) of its direction (RIBBON_VS)
        const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy);
        const ux = len > 1e-6 ? dx / len : 0, uy = len > 1e-6 ? dy / len : 0;
        const la = c.lane ? c.lane[arr[i + 1]] : 0, lb = c.lane ? c.lane[arr[i + 2]] : 0;
        const ax = A.x + uy * la, ay = A.y - ux * la, bx = B.x + uy * lb, by = B.y - ux * lb;
        const sx = bx - ax, sy = by - ay, sl = sx * sx + sy * sy;
        const t = sl > 1e-9 ? Math.max(0, Math.min(1, ((cx - ax) * sx + (cy - ay) * sy) / sl)) : 0;
        let d = Math.hypot(cx - (ax + sx * t), cy - (ay + sy * t));
        if (d > HIT_PX) continue;
        if (c.line === prefer) d -= STICKY_PX;
        if (d >= bestD) continue;
        bestD = d;
        best = { line: c.line, x: P[ia] + (P[ib] - P[ia]) * t, y: P[ia + 1] + (P[ib + 1] - P[ia + 1]) * t, z: P[ia + 2] + (P[ib + 2] - P[ia + 2]) * t, d: Math.max(0, d) };
      }
    }
    return best;
  }

  /** Client px of a world point (false behind the camera). */
  private screen(camera: THREE.Camera, rect: DOMRect, x: number, y: number, z: number, out: { x: number; y: number }): boolean {
    const v = this.v.set(x, y, z).project(camera);
    if (v.z > 1 || v.z < -1) return false;
    out.x = rect.left + (v.x * 0.5 + 0.5) * rect.width;
    out.y = rect.top + (-v.y * 0.5 + 0.5) * rect.height;
    return true;
  }
}
