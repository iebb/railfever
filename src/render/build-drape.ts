// Draped surfaces: road pieces laid on the rendered terrain. Input triangles / wall strips are given in the
// ground plane (xz) with a height offset above the terrain; they are clipped against the terrain triangles
// (the same cell split as World.heightAt) so every piece lies flat on its terrain triangle, lifted by
// DRAPE_LIFT. Near bridges, tunnels and level crossings a per-vertex blend weight `w` pulls the surface to
// the edge profile height `py`.
//
// Hot paths pass numbers through scratch typed arrays (no number boxing in calls that V8 does not inline),
// and neighbouring pieces share vertices (smooth terrain normals, as the terrain mesh shades).
import type { World } from '../game/world';
import type { WB } from './build-mesh';
import { ROAD_DRAPE } from './terrain';

/** Height of a draped surface above the terrain (plus a polygon offset in the material): the core's road
 *  drape lift, so road vehicles (terrain height + ROAD_DRAPE) sit exactly on the drawn surface. */
export const DRAPE_LIFT = ROAD_DRAPE;

/** A draped vertex: ground position, uv, height offset above the drape, blend weight to the profile height py. */
export interface DV { x: number; z: number; u: number; v: number; h: number; w: number; py: number }

const NV = 7; // floats per clipped vertex: x z u v h w py
/** most vertices of an input polygon */
const MAXP = 32;
const bufIn = new Float64Array(MAXP * NV);
const quadTmp = new Float64Array(NV);
/** vertex scratch for the builder: x y z nx ny nz u v */
const VB = new Float64Array(8);

// Vertex sharing between neighbouring draped pieces (open addressing on quantized x/z). Valid while the builder
// state is unchanged: same builder, same cell / colour (stamp), cast flag and seed, and not reset since.
const CB = 12, CN = 1 << CB, CM = CN - 1;
/** entries of 8 doubles (one cache line): generation, qx, qz, vertex index, y, u, v */
const CT = new Float64Array(CN * 8);
let cCur = 1, cFill = 0;
let lastW: WB | null = null, lastStamp = -1, lastCast = -1, lastSeed = -1, lastN = 0;
function shareCheck(W: WB) {
  if (W !== lastW || W.stamp !== lastStamp || W.cast !== lastCast || W.seed !== lastSeed || W.vertexCount < lastN) {
    lastW = W; lastStamp = W.stamp; lastCast = W.cast; lastSeed = W.seed;
    cCur++; cFill = 0;
  }
}
/** The vertex in VB: an existing one at the same place (same height and uv) or a new one. */
function sharedVertex(W: WB): number {
  const x = VB[0], y = VB[1], z = VB[2], u = VB[6], v = VB[7];
  const qx = Math.round(x * 4096), qz = Math.round(z * 4096);
  let h = (Math.imul(qx, 73856093) ^ Math.imul(qz, 19349663)) & CM;
  for (;;) {
    const o = h << 3;
    if (CT[o] !== cCur) break;
    if (CT[o + 1] === qx && CT[o + 2] === qz && Math.abs(CT[o + 4] - y) < 1e-5 && Math.abs(CT[o + 5] - u) < 1e-5 && Math.abs(CT[o + 6] - v) < 1e-5) return CT[o + 3];
    h = (h + 1) & CM;
  }
  const i = W.vertexArr(VB);
  if (cFill > CN / 2) { cCur++; cFill = 0; h = (Math.imul(qx, 73856093) ^ Math.imul(qz, 19349663)) & CM; }
  const o = h << 3;
  CT[o] = cCur; CT[o + 1] = qx; CT[o + 2] = qz; CT[o + 3] = i; CT[o + 4] = y; CT[o + 5] = u; CT[o + 6] = v;
  cFill++;
  lastN = W.vertexCount;
  return i;
}
const pIdx = new Int32Array(MAXP + 8);

/** smooth terrain normals at the 4 corners of a cell (as the terrain mesh shades: central differences) */
const cn = new Float64Array(12);
function cornerNormals(H: Float32Array, S: number, cx: number, cz: number) {
  const s1 = S + 1;
  for (let k = 0; k < 4; k++) {
    const i = cx + (k === 1 || k === 2 ? 1 : 0), j = cz + (k >= 2 ? 1 : 0);
    const ip = i < S ? i + 1 : S, im = i > 0 ? i - 1 : 0, jp = j < S ? j + 1 : S, jm = j > 0 ? j - 1 : 0;
    const dx = (H[j * s1 + ip] - H[j * s1 + im]) * 0.5, dz = (H[jp * s1 + i] - H[jm * s1 + i]) * 0.5;
    const l = Math.sqrt(dx * dx + 1 + dz * dz);
    cn[k * 3] = -dx / l; cn[k * 3 + 1] = 1 / l; cn[k * 3 + 2] = -dz / l;
  }
}

/** World.heightAt (same triangle split) on the raw heightfield. */
function terrainY(H: Float32Array, S: number, x: number, z: number): number {
  if (x < 0) x = 0; if (z < 0) z = 0;
  if (x > S - 1e-4) x = S - 1e-4; if (z > S - 1e-4) z = S - 1e-4;
  const ix = Math.floor(x), iz = Math.floor(z), fx = x - ix, fz = z - iz, s1 = S + 1, i = iz * s1 + ix;
  const h0 = H[i];
  return fx >= fz ? h0 + (H[i + 1] - h0) * fx + (H[i + s1 + 1] - H[i + 1]) * fz : h0 + (H[i + s1 + 1] - H[i + s1]) * fx + (H[i + s1] - h0) * fz;
}

const CAP = (MAXP + 8) * NV;
const rowA = new Float64Array(CAP), rowB = new Float64Array(CAP), cellA = new Float64Array(CAP), cellB = new Float64Array(CAP);
const halfA = new Float64Array(CAP);
/** the current clip plane a*x + b*z + c >= 0 */
const PLN = new Float64Array(3);
/** Clip by PLN: -1 = all inside (use src), 0 = all outside, else the vertex count written to dst. */
function clipP(src: Float64Array, n: number, dst: Float64Array): number {
  const a = PLN[0], b = PLN[1], c = PLN[2];
  let inside = 0;
  for (let i = 0; i < n; i++) if (a * src[i * NV] + b * src[i * NV + 1] + c >= 0) inside++;
  if (inside === n) return -1;
  if (inside === 0) return 0;
  const m = clip(src, n, dst, PLN, 0);
  return m < 3 ? 0 : m;
}

/** Sutherland-Hodgman clip of the polygon in `src` (n vertices) by plane k of P (a*x + b*z + c >= 0) into `dst`. */
function clip(src: Float64Array, n: number, dst: Float64Array, P: Float64Array, k3: number): number {
  const a = P[k3], b = P[k3 + 1], c = P[k3 + 2];
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = i + 1 === n ? 0 : i + 1;
    const pi = i * NV, pj = j * NV;
    const di = a * src[pi] + b * src[pi + 1] + c, dj = a * src[pj] + b * src[pj + 1] + c;
    if (di >= 0) { for (let k = 0; k < NV; k++) dst[m * NV + k] = src[pi + k]; m++; }
    if ((di >= 0) !== (dj >= 0)) {
      const t = di / (di - dj);
      for (let k = 0; k < NV; k++) dst[m * NV + k] = src[pi + k] + (src[pj + k] - src[pi + k]) * t;
      m++;
    }
  }
  return m;
}

// Split parameters of a segment where it crosses terrain triangle edges (x, z and x - z integer lines):
// sorted into TS[0 .. nTS), always ending with 1 (and starting with 0 when asked).
let TS = new Float64Array(256), nTS = 0;
function addCross(p0: number, d: number) {
  if (Math.abs(d) < 1e-9) return;
  const lo = Math.min(p0, p0 + d), hi = Math.max(p0, p0 + d);
  for (let k = Math.ceil(lo); k <= Math.floor(hi); k++) {
    const t = (k - p0) / d;
    if (t <= 1e-6 || t >= 1 - 1e-6) continue;
    if (nTS + 2 > TS.length) { const b = new Float64Array(TS.length * 2); b.set(TS); TS = b; }
    // insertion (each family arrives monotone: short shifts)
    let q = nTS++;
    while (q > 0 && TS[q - 1] > t) { TS[q] = TS[q - 1]; q--; }
    TS[q] = t;
  }
}
function splits(ax: number, az: number, dx: number, dz: number, withStart: boolean) {
  nTS = 0;
  if (withStart) TS[nTS++] = 0;
  addCross(ax, dx); addCross(az, dz); addCross(ax - az, dx - dz);
  TS[nTS++] = 1;
}

export class Drape {
  readonly H: Float32Array;
  readonly S: number;
  constructor(public world: World, public lift = DRAPE_LIFT) { this.H = world.h; this.S = world.size; }

  /** Draped ground height (terrain + lift) at (x, z). */
  ground(x: number, z: number): number { return terrainY(this.H, this.S, x, z) + this.lift; }

  private nP = 0;
  /** Start a convex polygon (either winding), given vertex by vertex with v() and laid with end(). */
  begin(): this { this.nP = 0; return this; }
  /** Next polygon vertex: ground position, uv, height offset, blend weight / profile height. */
  v(x: number, z: number, u: number, v: number, h = 0, w = 0, py = 0): this {
    if (this.nP >= MAXP) return this;
    const o = this.nP++ * NV, A = bufIn;
    A[o] = x; A[o + 1] = z; A[o + 2] = u; A[o + 3] = v; A[o + 4] = h; A[o + 5] = w; A[o + 6] = py;
    return this;
  }
  end(W: WB) { const n = this.nP; this.nP = 0; if (n === 4) this.quadIn(W); else if (n >= 3) this.poly(W, n); }

  /** A horizontal triangle on the drape (any winding: output faces up). */
  tri(W: WB, a: DV, b: DV, c: DV) {
    const A = bufIn;
    A[0] = a.x; A[1] = a.z; A[2] = a.u; A[3] = a.v; A[4] = a.h; A[5] = a.w; A[6] = a.py;
    A[7] = b.x; A[8] = b.z; A[9] = b.u; A[10] = b.v; A[11] = b.h; A[12] = b.w; A[13] = b.py;
    A[14] = c.x; A[15] = c.z; A[16] = c.u; A[17] = c.v; A[18] = c.h; A[19] = c.w; A[20] = c.py;
    this.poly(W, 3);
  }

  /** Drape the convex polygon in the input buffer (nIn vertices of NV floats): row by row, cell by cell, both halves. */
  poly(W: WB, nIn: number) {
    const H = this.H, S = this.S, s1 = S + 1;
    const T = bufIn;
    let mnz = Infinity, mxz = -Infinity;
    for (let i = 0; i < nIn; i++) { const z = T[i * NV + 1]; if (z < mnz) mnz = z; if (z > mxz) mxz = z; }
    const z0 = Math.max(0, Math.floor(mnz)), z1 = Math.min(S - 1, Math.floor(mxz));
    shareCheck(W);
    for (let cz = z0; cz <= z1; cz++) {
      // the row z in [cz, cz + 1]
      let src: Float64Array = T, n = nIn;
      PLN[0] = 0; PLN[1] = 1; PLN[2] = -cz;
      let r = clipP(src, n, rowA);
      if (r === 0) continue;
      if (r > 0) { src = rowA; n = r; }
      PLN[1] = -1; PLN[2] = cz + 1;
      r = clipP(src, n, src === rowA ? rowB : rowA);
      if (r === 0) continue;
      if (r > 0) { src = src === rowA ? rowB : rowA; n = r; }
      if (n < 3) continue;
      let mnx = Infinity, mxx = -Infinity;
      for (let i = 0; i < n; i++) { const x = src[i * NV]; if (x < mnx) mnx = x; if (x > mxx) mxx = x; }
      const cx0 = Math.max(0, Math.floor(mnx)), cx1 = Math.min(S - 1, Math.floor(mxx));
      for (let cx = cx0; cx <= cx1; cx++) {
        // the cell x in [cx, cx + 1]
        let c: Float64Array = src, m = n;
        PLN[0] = 1; PLN[1] = 0; PLN[2] = -cx;
        r = clipP(c, m, cellA);
        if (r === 0) continue;
        if (r > 0) { c = cellA; m = r; }
        PLN[0] = -1; PLN[2] = cx + 1;
        r = clipP(c, m, c === cellA ? cellB : cellA);
        if (r === 0) continue;
        if (r > 0) { c = c === cellA ? cellB : cellA; m = r; }
        if (m < 3) continue;
        const i0 = cz * s1 + cx;
        const h0 = H[i0], h1 = H[i0 + 1], h2 = H[i0 + s1 + 1], h3 = H[i0 + s1];
        cornerNormals(H, S, cx, cz);
        // lower half (x - cx) - (z - cz) >= 0, upper half <= 0
        PLN[0] = 1; PLN[1] = -1; PLN[2] = cz - cx;
        r = clipP(c, m, halfA);
        if (r !== 0) this.emit(W, r > 0 ? halfA : c, r > 0 ? r : m, cx, cz, 0, h0, h1 - h0, h2 - h1);
        if (r === -1) continue; // all in the lower half
        PLN[0] = -1; PLN[1] = 1; PLN[2] = cx - cz;
        r = clipP(c, m, halfA);
        if (r !== 0) this.emit(W, r > 0 ? halfA : c, r > 0 ? r : m, cx, cz, 1, h0, h2 - h3, h3 - h0);
      }
    }
  }

  /** Emit a clipped piece lying in one terrain triangle (plane y = h0 + gx*(x-cx) + gz*(z-cz)); normals from cn. */
  private emit(W: WB, src: Float64Array, n: number, cx: number, cz: number, half: number, h0: number, gx: number, gz: number) {
    if (n > MAXP + 8) n = MAXP + 8;
    const lift = this.lift;
    for (let k = 0; k < n; k++) {
      const o = k * NV;
      const px = src[o], pz = src[o + 1], bw = src[o + 5];
      const fx = px - cx, fz = pz - cz;
      const yt = h0 + gx * fx + gz * fz + lift + src[o + 4];
      // barycentric weights of the corners (0, 1, 2) lower / (0, 2, 3) upper
      let b0: number, b1: number, b2: number, b3: number;
      if (half === 0) { b0 = 1 - fx; b1 = fx - fz; b2 = fz; b3 = 0; } else { b0 = 1 - fz; b1 = 0; b2 = fx; b3 = fz - fx; }
      let nx = cn[0] * b0 + cn[3] * b1 + cn[6] * b2 + cn[9] * b3;
      let ny = cn[1] * b0 + cn[4] * b1 + cn[7] * b2 + cn[10] * b3;
      let nz = cn[2] * b0 + cn[5] * b1 + cn[8] * b2 + cn[11] * b3;
      if (bw > 0) { nx *= 1 - bw; ny = ny * (1 - bw) + bw; nz *= 1 - bw; }
      const ln = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      VB[0] = px; VB[1] = bw > 0 ? yt + (src[o + 6] + src[o + 4] - yt) * bw : yt; VB[2] = pz;
      VB[3] = nx / ln; VB[4] = ny / ln; VB[5] = nz / ln; VB[6] = src[o + 2]; VB[7] = src[o + 3];
      pIdx[k] = sharedVertex(W);
    }
    // fan; skip slivers thinner than a few float32 ulps (they would flip) and collapsed (shared) corners
    for (let k = 1; k < n - 1; k++) {
      const a = pIdx[0], b = pIdx[k], c = pIdx[k + 1];
      if (a === b || b === c || a === c) continue;
      const o1 = k * NV, o2 = (k + 1) * NV;
      const e1x = src[o1] - src[0], e1z = src[o1 + 1] - src[1], e2x = src[o2] - src[0], e2z = src[o2 + 1] - src[1];
      const cr = e1x * e2z - e2x * e1z;
      const e3x = src[o2] - src[o1], e3z = src[o2 + 1] - src[o1 + 1];
      const L2 = Math.max(e1x * e1x + e1z * e1z, e2x * e2x + e2z * e2z, e3x * e3x + e3z * e3z);
      if (cr * cr < 9e-8 * L2) continue;
      // cr > 0: counter-clockwise in (x, z) = clockwise seen from above -> flip to face up
      if (cr > 0) W.idx.push(a, c, b);
      else W.idx.push(a, b, c);
    }
  }

  /** Drape the quad in the input buffer (a, b, c, d around, either winding): one polygon when convex. */
  quadIn(W: WB) {
    const A = bufIn;
    const ax = A[0], az = A[1], bx = A[7], bz = A[8], cx = A[14], cz = A[15], dx = A[21], dz = A[22];
    const c0 = (bx - ax) * (cz - az) - (cx - ax) * (bz - az), c1 = (cx - ax) * (dz - az) - (dx - ax) * (cz - az);
    const c2 = (cx - bx) * (dz - bz) - (dx - bx) * (cz - bz), c3 = (dx - ax) * (bz - az) - (bx - ax) * (dz - az);
    if ((c0 > 0 && c1 > 0 && c2 > 0 && c3 < 0) || (c0 < 0 && c1 < 0 && c2 < 0 && c3 > 0)) { this.poly(W, 4); return; }
    // not convex: (a, b, c) and (a, c, d)
    for (let k = 0; k < NV; k++) quadTmp[k] = A[21 + k];
    this.poly(W, 3);
    for (let k = 0; k < NV; k++) { A[7 + k] = A[14 + k]; A[14 + k] = quadTmp[k]; }
    this.poly(W, 3);
  }

  /** Raw triangle on the drape (no objects): positions, uvs and height offsets per vertex, blend (w, py). */
  triRaw(W: WB, ax: number, az: number, au: number, av: number, ah: number, aw: number, apy: number,
    bx: number, bz: number, bu: number, bv: number, bh: number, bw: number, bpy: number,
    cx: number, cz: number, cu: number, cv: number, ch: number, cw: number, cpy: number) {
    const A = bufIn;
    A[0] = ax; A[1] = az; A[2] = au; A[3] = av; A[4] = ah; A[5] = aw; A[6] = apy;
    A[7] = bx; A[8] = bz; A[9] = bu; A[10] = bv; A[11] = bh; A[12] = bw; A[13] = bpy;
    A[14] = cx; A[15] = cz; A[16] = cu; A[17] = cv; A[18] = ch; A[19] = cw; A[20] = cpy;
    this.poly(W, 3);
  }

  /** A quad (a, b, c, d around) on the drape. */
  quad(W: WB, a: DV, b: DV, c: DV, d: DV) {
    const A = bufIn;
    A[0] = a.x; A[1] = a.z; A[2] = a.u; A[3] = a.v; A[4] = a.h; A[5] = a.w; A[6] = a.py;
    A[7] = b.x; A[8] = b.z; A[9] = b.u; A[10] = b.v; A[11] = b.h; A[12] = b.w; A[13] = b.py;
    A[14] = c.x; A[15] = c.z; A[16] = c.u; A[17] = c.v; A[18] = c.h; A[19] = c.w; A[20] = c.py;
    A[21] = d.x; A[22] = d.z; A[23] = d.u; A[24] = d.v; A[25] = d.h; A[26] = d.w; A[27] = d.py;
    this.quadIn(W);
  }

  /**
   * A vertical strip along the ground line a -> b between h0 and h1 above the drape, facing (nx, nz),
   * split where it crosses terrain triangle edges so its foot follows the ground exactly.
   */
  wall(W: WB, ax: number, az: number, bx: number, bz: number, h0: number, h1: number, nx: number, nz: number, sc = 1, u0 = 0,
    wa = 0, pya = 0, wb = 0, pyb = 0) {
    const dx = bx - ax, dz = bz - az;
    const len = Math.hypot(dx, dz);
    if (len < 1e-6 || h1 - h0 < 1e-6) return;
    splits(ax, az, dx, dz, true);
    const H = this.H, S = this.S, lift = this.lift;
    const l = Math.hypot(nx, nz) || 1, ux = nx / l, uz = nz / l;
    // the cycle (a bottom, b bottom, b top) faces (-dz, dx): keep it when that agrees with (nx, nz)
    const flip = (-dz * ux + dx * uz) < 0;
    let prev = -1, last = -1;
    for (let i = 0; i < nTS; i++) {
      const t = TS[i];
      if (t - last < 1e-6) continue;
      last = t;
      const x = ax + dx * t, z = az + dz * t;
      const g = terrainY(H, S, x, z) + lift;
      const bw = wa + (wb - wa) * t, py = pya + (pyb - pya) * t;
      const y0 = bw > 0 ? g + h0 + (py - g) * bw : g + h0, y1 = bw > 0 ? g + h1 + (py - g) * bw : g + h1;
      const u = (u0 + len * t) / sc;
      VB[0] = x; VB[1] = y0; VB[2] = z; VB[3] = ux; VB[4] = 0; VB[5] = uz; VB[6] = u; VB[7] = y0 / sc;
      const v0 = W.vertexArr(VB);
      VB[1] = y1; VB[7] = y1 / sc;
      const v1 = W.vertexArr(VB);
      if (prev >= 0) {
        if (flip) W.idx.push(prev, prev + 1, v1, prev, v1, v0);
        else W.idx.push(prev, v0, v1, prev, v1, prev + 1);
      }
      prev = v0;
    }
  }
}

/** A sample of a draped run: position, lateral vector, arc length, profile height, blend weight to the profile. */
export interface DSmp { x: number; z: number; lx: number; lz: number; s: number; py: number; w: number }

/**
 * A vertical wall along a draped run at lateral offset la, between h0 and h1 above the drape, facing sg * the
 * run's lateral vector: one strip over the whole run (vertices shared at the samples and at the terrain-edge
 * splits, so its foot and top follow the draped surfaces exactly).
 */
export function drapeWallRun(W: WB, D: Drape, run: DSmp[], la: number, h0: number, h1: number, sg: number, sc = 1) {
  const n = run.length;
  if (n < 2 || h1 - h0 < 1e-6) return;
  const H = D.H, S = D.S, lift = D.lift;
  let prev = -1;
  for (let i = 0; i < n - 1; i++) {
    const A = run[i], B = run[i + 1];
    const ax = A.x + A.lx * la, az = A.z + A.lz * la, bx = B.x + B.lx * la, bz = B.z + B.lz * la;
    const dx = bx - ax, dz = bz - az;
    if (Math.abs(dx) + Math.abs(dz) < 1e-6) continue;
    splits(ax, az, dx, dz, prev < 0);
    let snx = (A.lx + B.lx) * sg, snz = (A.lz + B.lz) * sg;
    const sl = Math.hypot(snx, snz) || 1; snx /= sl; snz /= sl;
    const flip = (-dz * snx + dx * snz) < 0;
    let last = -1;
    for (let k = 0; k < nTS; k++) {
      const t = TS[k];
      if (t - last < 1e-6) continue;
      last = t;
      const x = ax + dx * t, z = az + dz * t;
      const bw = A.w + (B.w - A.w) * t, py = A.py + (B.py - A.py) * t;
      const g = terrainY(H, S, x, z) + lift;
      const y0 = bw > 0 ? g + h0 + (py - g) * bw : g + h0, y1 = bw > 0 ? g + h1 + (py - g) * bw : g + h1;
      let nx = snx, nz = snz;
      if (t === 0 || t === 1) {
        // at the samples: the sample's lateral (mitred ends are longer than 1: normalise)
        const P = t === 0 ? A : B, pl = Math.hypot(P.lx, P.lz) || 1;
        nx = P.lx * sg / pl; nz = P.lz * sg / pl;
      }
      const u = (A.s + (B.s - A.s) * t) / sc;
      VB[0] = x; VB[1] = y0; VB[2] = z; VB[3] = nx; VB[4] = 0; VB[5] = nz; VB[6] = u; VB[7] = y0 / sc;
      const v0 = W.vertexArr(VB);
      VB[1] = y1; VB[7] = y1 / sc;
      const v1 = W.vertexArr(VB);
      if (prev >= 0) {
        if (flip) W.idx.push(prev, prev + 1, v1, prev, v1, v0);
        else W.idx.push(prev, v0, v1, prev, v1, prev + 1);
      }
      prev = v0;
    }
  }
}

/**
 * Side face under a blended stretch (where the surface leaves the ground for a structure / crossing): from
 * just below the terrain up to the blended surface height (+h), along a -> b (blend weights / profile
 * heights at both ends), facing (nx, nz). Nothing is drawn where the surface stays on the ground.
 */
export function drapeSkirt(W: WB, D: Drape, ax: number, az: number, bx: number, bz: number, wa: number, pya: number, wb: number, pyb: number,
  h: number, nx: number, nz: number, sc = 0.5) {
  if (wa <= 0 && wb <= 0) return;
  const dx = bx - ax, dz = bz - az;
  const len = Math.hypot(dx, dz);
  if (len < 1e-6) return;
  splits(ax, az, dx, dz, true);
  const H = D.H, S = D.S, lift = D.lift;
  let pb = 0, pu = 0, pt = -1;
  for (let i = 0; i < nTS; i++) {
    const t = TS[i];
    if (t - pt < 1e-6) continue;
    const x = ax + dx * t, z = az + dz * t;
    const g = terrainY(H, S, x, z);
    const bw = wa + (wb - wa) * t, py = pya + (pyb - pya) * t;
    const b = g - 0.05, u = g + lift + h + (py + h - (g + lift + h)) * bw;
    if (pt >= 0 && (pu - pb >= 0.07 || u - b >= 0.07))
      W.twall(ax + dx * pt, az + dz * pt, x, z, pb, Math.max(pb, pu), b, Math.max(b, u), nx, nz, sc, len * pt);
    pb = b; pu = u; pt = t;
  }
}

/**
 * Lay a profile across a draped run: horizontal profile segments become draped strips (height offset h),
 * vertical ones draped walls; sloped ones are skipped (no skirts on the drape). `prof` points are
 * [lateral, h, u] as in sweep(); v = s / vScale.
 */
export function drapeSweep(W: WB, D: Drape, run: DSmp[], prof: [number, number, number?][], vScale = 1) {
  const n = run.length;
  if (n < 2 || prof.length < 2) return;
  const T = bufIn;
  for (let k = 0; k < prof.length - 1; k++) {
    const pa = prof[k], pb = prof[k + 1];
    const la = pa[0], ha = pa[1], ua = pa[2] ?? 0;
    const lb = pb[0], hb = pb[1], ub = pb[2] ?? 1;
    if (Math.abs(ha - hb) < 1e-6) {
      for (let i = 0; i < n - 1; i++) {
        const A = run[i], B = run[i + 1];
        const va = A.s / vScale, vb = B.s / vScale;
        T[0] = A.x + A.lx * la; T[1] = A.z + A.lz * la; T[2] = ua; T[3] = va; T[4] = ha; T[5] = A.w; T[6] = A.py;
        T[7] = A.x + A.lx * lb; T[8] = A.z + A.lz * lb; T[9] = ub; T[10] = va; T[11] = ha; T[12] = A.w; T[13] = A.py;
        T[14] = B.x + B.lx * lb; T[15] = B.z + B.lz * lb; T[16] = ub; T[17] = vb; T[18] = ha; T[19] = B.w; T[20] = B.py;
        T[21] = B.x + B.lx * la; T[22] = B.z + B.lz * la; T[23] = ua; T[24] = vb; T[25] = ha; T[26] = B.w; T[27] = B.py;
        D.quadIn(W);
      }
    } else if (Math.abs(la - lb) < 1e-6) {
      // the sweep's face normal is dl*up - dh*right: a vertical face points -sign(dh) * right
      drapeWallRun(W, D, run, la, Math.min(ha, hb), Math.max(ha, hb), hb > ha ? -1 : 1);
    }
  }
}
