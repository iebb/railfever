// Town land use without buildings: parks (lawn, paths, trees, pond or playground, benches) and plazas
// (paved square, fountain or monument, trees in planters, benches, lamps). Both fill a building rect.
import type { World, Building } from '../game/world';
import { RNG } from '../game/rng';
import { ChunkCtx, wallQuad } from './build-common';
import { WB } from './build-mesh';
import { WC, WSCALE } from './textures';
import { lampPost } from './build-road';

export const BT_PARK = 8, BT_PLAZA = 9;

/** Rect frame: local a across (right), b along the facing direction (front edge at +d/2). */
export class Frame {
  fx: number; fz: number; rx: number; rz: number; hw: number; hd: number;
  constructor(public cx: number, public cz: number, angle: number, w: number, d: number) {
    this.fx = Math.sin(angle); this.fz = Math.cos(angle); this.rx = this.fz; this.rz = -this.fx;
    this.hw = w / 2; this.hd = d / 2;
  }
  x(a: number, b: number) { return this.cx + this.rx * a + this.fx * b; }
  z(a: number, b: number) { return this.cz + this.rz * a + this.fz * b; }
}

/**
 * The lot rect shrunk to keep clear of the paved width (plus a margin) of every nearby road or track:
 * blocks of bent streets are not rectangles, so a road may cut into the lot rect. Each intruding sample
 * moves the side that costs the least area.
 */
export function fitLot(ctx: ChunkCtx, b: Building): Frame {
  const net = ctx.game.world.net;
  const fx = Math.sin(b.angle), fz = Math.cos(b.angle), rx = fz, rz = -fx;
  let l = -b.w / 2, r = b.w / 2, k = -b.d / 2, f = b.d / 2;
  const R = Math.hypot(b.w, b.d) / 2 + 1.2;
  for (const e of net.edgesNear(b.x - R, b.z - R, b.x + R, b.z + R)) {
    const clear = net.halfWidth(e) + 0.06;
    const g = net.geo(e);
    for (let i = 0; i < g.n; i++) {
      const dx = g.pts[i * 3] - b.x, dz = g.pts[i * 3 + 2] - b.z;
      const a = dx * rx + dz * rz, c = dx * fx + dz * fz;
      if (a < l - clear || a > r + clear || c < k - clear || c > f + clear) continue;
      const W = r - l, D = f - k;
      if (W < 0.8 || D < 0.8) break;
      // area lost by moving each side just clear of this sample
      const opts: [number, number][] = [
        [(r - (a - clear)) * D, 0], [((a + clear) - l) * D, 1], [(f - (c - clear)) * W, 2], [((c + clear) - k) * W, 3],
      ];
      opts.sort((p, q) => p[0] - q[0]);
      const side = opts.find(([loss]) => loss >= 0)?.[1];
      if (side === 0) r = Math.max(l + 0.6, a - clear);
      else if (side === 1) l = Math.min(r - 0.6, a + clear);
      else if (side === 2) f = Math.max(k + 0.6, c - clear);
      else if (side === 3) k = Math.min(f - 0.6, c + clear);
    }
  }
  const ca = (l + r) / 2, cb = (k + f) / 2;
  return new Frame(b.x + rx * ca + fx * cb, b.z + rz * ca + fz * cb, b.angle, r - l, f - k);
}

/** Upward surface over a local rectangle following the terrain (grid of `step`), planar world uvs. */
function terrainPatch(W: WB, w: World, F: Frame, a0: number, a1: number, b0: number, b1: number, yOff: number, sc: number, step = 0.5) {
  const na = Math.max(1, Math.ceil((a1 - a0) / step)), nb = Math.max(1, Math.ceil((b1 - b0) / step));
  const X: number[] = [], Y: number[] = [], Z: number[] = [];
  for (let j = 0; j <= nb; j++) for (let i = 0; i <= na; i++) {
    const a = a0 + ((a1 - a0) * i) / na, b = b0 + ((b1 - b0) * j) / nb;
    const x = F.x(a, b), z = F.z(a, b);
    X.push(x); Z.push(z); Y.push(w.heightAt(x, z) + yOff);
  }
  const k = (i: number, j: number) => j * (na + 1) + i;
  for (let j = 0; j < nb; j++) for (let i = 0; i < na; i++) {
    const p = k(i, j), q = k(i + 1, j), r = k(i + 1, j + 1), s = k(i, j + 1);
    W.ttri(X[p], Y[p], Z[p], X[p] / sc, Z[p] / sc, X[q], Y[q], Z[q], X[q] / sc, Z[q] / sc, X[r], Y[r], Z[r], X[r] / sc, Z[r] / sc, 0, 1, 0);
    W.ttri(X[p], Y[p], Z[p], X[p] / sc, Z[p] / sc, X[r], Y[r], Z[r], X[r] / sc, Z[r] / sc, X[s], Y[s], Z[s], X[s] / sc, Z[s] / sc, 0, 1, 0);
  }
}

/** Ribbon along a local polyline (a,b pairs) on the terrain. */
function pathRibbon(W: WB, w: World, F: Frame, pts: [number, number][], width: number, yOff: number, sc: number) {
  const n = pts.length;
  const L: [number, number, number][] = [], R: [number, number, number][] = [];
  for (let i = 0; i < n; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[Math.min(n - 1, i + 1)];
    let ta = p1[0] - p0[0], tb = p1[1] - p0[1];
    const tl = Math.hypot(ta, tb) || 1;
    ta /= tl; tb /= tl;
    const [a, b] = pts[i];
    for (const [arr, sg] of [[L, -1], [R, 1]] as [[number, number, number][], number][]) {
      const aa = a + tb * sg * width / 2, bb = b - ta * sg * width / 2;
      const x = F.x(aa, bb), z = F.z(aa, bb);
      arr.push([x, w.heightAt(x, z) + yOff, z]);
    }
  }
  for (let i = 0; i < n - 1; i++) {
    const a = L[i], b = R[i], c = R[i + 1], d = L[i + 1];
    W.ttri(a[0], a[1], a[2], a[0] / sc, a[2] / sc, b[0], b[1], b[2], b[0] / sc, b[2] / sc, c[0], c[1], c[2], c[0] / sc, c[2] / sc, 0, 1, 0);
    W.ttri(a[0], a[1], a[2], a[0] / sc, a[2] / sc, c[0], c[1], c[2], c[0] / sc, c[2] / sc, d[0], d[1], d[2], d[0] / sc, d[2] / sc, 0, 1, 0);
  }
}

/** Disc (or ellipse with wobble) of a cell at a fixed or terrain height. */
function disc(W: WB, w: World, F: Frame, ca: number, cb: number, ra: number, rb: number, y: number | null, yOff: number, sc: number, wob = 0, seed = 1, seg = 16) {
  const ring: [number, number, number][] = [];
  for (let k = 0; k < seg; k++) {
    const t = (k / seg) * Math.PI * 2;
    const m = 1 + wob * (Math.sin(t * 2 + seed) * 0.6 + Math.sin(t * 3 + seed * 1.7) * 0.4);
    const a = ca + Math.cos(t) * ra * m, b = cb + Math.sin(t) * rb * m;
    const x = F.x(a, b), z = F.z(a, b);
    ring.push([x, (y ?? w.heightAt(x, z)) + yOff, z]);
  }
  const x0 = F.x(ca, cb), z0 = F.z(ca, cb), y0 = (y ?? w.heightAt(x0, z0)) + yOff;
  for (let k = 0; k < seg; k++) {
    const p = ring[k], q = ring[(k + 1) % seg];
    W.ttri(x0, y0, z0, x0 / sc, z0 / sc, p[0], p[1], p[2], p[0] / sc, p[2] / sc, q[0], q[1], q[2], q[0] / sc, q[2] / sc, 0, 1, 0);
  }
  return ring;
}

/** Flat stone ring (annulus) of width `rw` inside the given ellipse; returns the outer points. */
function ring(W: WB, w: World, F: Frame, ca: number, cb: number, ra: number, rb: number, rw: number, y: number, wob: number, seed: number, seg = 16) {
  const out: [number, number, number][] = [], inn: [number, number, number][] = [];
  for (let k = 0; k < seg; k++) {
    const t = (k / seg) * Math.PI * 2;
    const m = 1 + wob * (Math.sin(t * 2 + seed) * 0.6 + Math.sin(t * 3 + seed * 1.7) * 0.4);
    const c = Math.cos(t), s = Math.sin(t);
    const ao = ca + c * ra * m, bo = cb + s * rb * m, ai = ca + c * (ra * m - rw), bi = cb + s * (rb * m - rw);
    out.push([F.x(ao, bo), y, F.z(ao, bo)]);
    inn.push([F.x(ai, bi), y, F.z(ai, bi)]);
  }
  W.use(WC.CONCRETE, 0xd2ccc0, 1);
  for (let k = 0; k < seg; k++) {
    const a = out[k], b = out[(k + 1) % seg], c = inn[(k + 1) % seg], d = inn[k];
    W.ttri(a[0], a[1], a[2], 0, 0, b[0], b[1], b[2], 0.2, 0, c[0], c[1], c[2], 0.2, 0.05, 0, 1, 0);
    W.ttri(a[0], a[1], a[2], 0, 0, c[0], c[1], c[2], 0.2, 0.05, d[0], d[1], d[2], 0, 0.05, 0, 1, 0);
  }
  void w;
  return out;
}

/** Park bench facing (fx,fz) (detail layer). */
export function bench(D: WB, x: number, y: number, z: number, fx: number, fz: number) {
  D.use(WC.PLAIN, 0x7a5636, 0);
  D.box(x, y + 0.04, z, 0.17, 0.012, 0.05, fx, fz, true);
  D.box(x - fx * 0.024, y + 0.052, z - fz * 0.024, 0.17, 0.045, 0.01, fx, fz, true);
  D.use(WC.METAL, 0x3b3f42, 0);
  for (const s of [-1, 1]) D.box(x + fz * s * 0.07, y, z - fx * s * 0.07, 0.012, 0.04, 0.045, fx, fz);
}

/** Distance from point (a,b) to a local polyline. */
function distToPath(pts: [number, number][], a: number, b: number): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const [a0, b0] = pts[i], [a1, b1] = pts[i + 1];
    const da = a1 - a0, db = b1 - b0, l2 = da * da + db * db;
    const t = l2 > 1e-9 ? Math.max(0, Math.min(1, ((a - a0) * da + (b - b0) * db) / l2)) : 0;
    best = Math.min(best, Math.hypot(a - a0 - da * t, b - b0 - db * t));
  }
  return best;
}

/** Quadratic Bezier polyline in local coordinates. */
function curve(p0: [number, number], c: [number, number], p1: [number, number], n = 10): [number, number][] {
  const out: [number, number][] = [];
  for (let k = 0; k <= n; k++) {
    const t = k / n, u = 1 - t;
    out.push([u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]]);
  }
  return out;
}

export function buildPark(ctx: ChunkCtx, b: Building) {
  const w = ctx.game.world;
  const W = ctx.w, D = ctx.d;
  const r = new RNG(b.seed);
  const F = fitLot(ctx, b);
  const { hw, hd } = F;
  W.cast = 0;
  // lawn
  W.use(WC.GRASS, 0xffffff, 0);
  terrainPatch(W, w, F, -hw, hw, -hd, hd, 0.012, WSCALE.GRASS);
  // feature in the middle: pond, playground or a small rondel with a statue
  const big = Math.min(hw, hd) >= 1.15;
  let kind = big ? (r.chance(0.5) ? 'pond' : 'play') : r.chance(0.5) ? 'rondel' : 'play';
  const ca = (r.next() - 0.5) * hw * 0.3, cb = (r.next() - 0.5) * hd * 0.3 - hd * 0.1;
  let fr = Math.min(hw, hd) * (kind === 'pond' ? 0.42 : 0.3);
  // ponds only on near-level ground (water level = highest ground under the rim)
  let pondTop = -Infinity, pondLow = Infinity;
  if (kind === 'pond') {
    for (let k = 0; k < 12; k++) {
      const t = (k / 12) * Math.PI * 2;
      const hgt = w.heightAt(F.x(ca + Math.cos(t) * fr * 1.15, cb + Math.sin(t) * fr), F.z(ca + Math.cos(t) * fr * 1.15, cb + Math.sin(t) * fr));
      pondTop = Math.max(pondTop, hgt); pondLow = Math.min(pondLow, hgt);
    }
    if (pondTop - pondLow > 0.18) { kind = 'rondel'; fr = Math.min(hw, hd) * 0.3; }
  }
  // paths: from the front entrance to the feature, then on to one or two other edges
  const paths: [number, number][][] = [];
  const entry: [number, number] = [(r.next() - 0.5) * hw * 0.6, hd];
  const toF: [number, number] = [ca + Math.sign(entry[0] - ca || 1) * fr * 0.8, cb + fr * 0.8];
  paths.push(curve(entry, [entry[0], (entry[1] + toF[1]) / 2], toF));
  const exits: [number, number][] = [[-hw, (r.next() - 0.5) * hd], [hw, (r.next() - 0.5) * hd], [(r.next() - 0.5) * hw, -hd]];
  for (let i = exits.length - 1; i > 0; i--) { const j = r.int(i + 1); [exits[i], exits[j]] = [exits[j], exits[i]]; }
  for (const ex of exits.slice(0, 1 + r.int(2))) {
    const st: [number, number] = [ca + Math.sign(ex[0] - ca || 0.5) * fr * 0.7, cb + Math.sign(ex[1] - cb || -1) * fr * 0.7];
    paths.push(curve(st, [(st[0] + ex[0]) / 2 + (r.next() - 0.5) * 0.6, (st[1] + ex[1]) / 2 + (r.next() - 0.5) * 0.6], ex));
  }
  W.use(WC.GRAVEL, 0xe4d6b4, 0);
  for (const pth of paths) pathRibbon(W, w, F, pth, 0.11, 0.022, WSCALE.GRAVEL);
  // ring path around the feature
  {
    const ring: [number, number][] = [];
    for (let k = 0; k <= 20; k++) { const t = (k / 20) * Math.PI * 2; ring.push([ca + Math.cos(t) * (fr + 0.1), cb + Math.sin(t) * (fr + 0.1)]); }
    pathRibbon(W, w, F, ring, 0.1, 0.021, WSCALE.GRAVEL);
    paths.push(ring);
  }
  const fx = F.x(ca, cb), fz = F.z(ca, cb), fy = w.heightAt(fx, fz);
  if (kind === 'pond') {
    // flat water inside a stone rim
    const yw = Math.max(fy, pondTop) + 0.03;
    const rim = ring(W, w, F, ca, cb, fr, fr * 0.8, 0.045, yw + 0.012, 0.12, b.seed % 7, 18);
    W.use(WC.WATER, 0xffffff, 0);
    disc(W, w, F, ca, cb, fr - 0.04, fr * 0.8 - 0.04, yw, 0, WSCALE.WATER, 0.12, b.seed % 7, 18);
    // rim outer wall down to the lawn
    W.use(WC.CONCRETE, 0xc4bdb0, 1);
    for (let k = 0; k < rim.length; k++) {
      const p = rim[k], q = rim[(k + 1) % rim.length];
      wallQuad(W, p[0], p[2], q[0], q[2], Math.min(w.heightAt(p[0], p[2]), p[1]) - 0.02, p[1], Math.min(w.heightAt(q[0], q[2]), q[1]) - 0.02, q[1], (p[0] + q[0]) / 2 - fx, (p[2] + q[2]) / 2 - fz);
    }
  } else if (kind === 'play') {
    W.use(WC.GRAVEL, 0xf0dfb0, 0);
    disc(W, w, F, ca, cb, fr, fr * 0.85, null, 0.024, 0.3, 0.05, 3, 14);
    // swing frame and a climbing frame (detail)
    const y = fy + 0.024;
    D.use(WC.METAL, 0xc0392b, 0);
    const ax = F.x(ca - fr * 0.4, cb), az = F.z(ca - fr * 0.4, cb), bx = F.x(ca + fr * 0.2, cb), bz = F.z(ca + fr * 0.2, cb);
    for (const [px, pz] of [[ax, az], [bx, bz]]) {
      D.tube(px - F.fx * 0.06, y, pz - F.fz * 0.06, px, y + 0.2, pz, 0.006, 4);
      D.tube(px + F.fx * 0.06, y, pz + F.fz * 0.06, px, y + 0.2, pz, 0.006, 4);
    }
    D.tube(ax, y + 0.2, az, bx, y + 0.2, bz, 0.006, 4);
    D.use(WC.METAL, 0x2f3437, 0);
    for (const t of [0.33, 0.66]) {
      const sx = ax + (bx - ax) * t, sz = az + (bz - az) * t;
      D.tube(sx, y + 0.2, sz, sx, y + 0.06, sz, 0.002, 3);
      D.box(sx, y + 0.055, sz, 0.05, 0.008, 0.025, F.fx, F.fz);
    }
    D.use(WC.METAL, 0x2e86c1, 0);
    const cx2 = F.x(ca + fr * 0.55, cb - fr * 0.35), cz2 = F.z(ca + fr * 0.55, cb - fr * 0.35);
    D.box(cx2, y, cz2, 0.14, 0.1, 0.14, F.fx, F.fz);
    D.use(WC.METAL, 0xf1c40f, 0);
    D.box(cx2 + F.fx * 0.14, y + 0.03, cz2 + F.fz * 0.14, 0.06, 0.012, 0.16, F.fx, F.fz);
  } else {
    // rondel: gravel circle with a small statue on a plinth
    W.use(WC.GRAVEL, 0xe4d6b4, 0);
    disc(W, w, F, ca, cb, fr, fr, null, 0.022, WSCALE.GRAVEL, 0, 1, 16);
    W.use(WC.STONE, 0xcfc6b4, 1);
    W.tbox(fx, fy, fz, 0.12, 0.14, 0.12, F.fx, F.fz, WSCALE.STONE, false);
    W.use(WC.METAL, 0x5f6e58, 1);
    W.cylinder(fx, fy + 0.14, fz, 0.025, 0.12, 6);
    W.box(fx, fy + 0.26, fz, 0.035, 0.035, 0.035);
  }
  // flower beds beside the entrance
  W.use(WC.FLOWERS, 0xffffff, 0);
  for (const s of [-1, 1]) {
    const a = entry[0] + s * 0.32, bb = hd - 0.22;
    if (Math.abs(a) < hw - 0.15) disc(W, w, F, a, bb, 0.16, 0.1, null, 0.026, WSCALE.FLOWERS, 0.1, s + 3, 10);
  }
  // trees on the lawn, clear of paths, the feature and the edges
  const area = 4 * hw * hd;
  const nTrees = Math.max(2, Math.min(14, Math.round(area * 0.7)));
  for (let k = 0, tries = 0; k < nTrees && tries < nTrees * 12; tries++) {
    const a = (r.next() - 0.5) * (2 * hw - 0.5), bb = (r.next() - 0.5) * (2 * hd - 0.5);
    if (Math.hypot(a - ca, bb - cb) < fr + 0.45) continue;
    if (paths.some((pth) => distToPath(pth, a, bb) < 0.32)) continue;
    const x = F.x(a, bb), z = F.z(a, bb);
    const conifer = r.chance(0.2);
    ctx.trees.push({ type: conifer ? 3 : r.chance(0.3) ? 1 : 0, x, y: w.heightAt(x, z) - 0.02, z, s: 0.6 + r.next() * 0.45, rot: r.next() * Math.PI * 2, tint: r.next() });
    k++;
  }
  // benches along the paths, a couple of lamps
  let benches = 0;
  for (const pth of paths) {
    if (benches >= 4) break;
    const i = Math.floor(pth.length / 2);
    const [a, bb] = pth[i], [a2, b2] = pth[Math.min(pth.length - 1, i + 1)];
    let ta = a2 - a, tb = b2 - bb;
    const tl = Math.hypot(ta, tb) || 1; ta /= tl; tb /= tl;
    const na = tb, nb = -ta; // side of the path
    const qa = a + na * 0.12, qb = bb + nb * 0.12;
    if (Math.abs(qa) > hw - 0.1 || Math.abs(qb) > hd - 0.1) continue;
    const x = F.x(qa, qb), z = F.z(qa, qb);
    // face the path
    const dx = F.x(a, bb) - x, dz = F.z(a, bb) - z, dl = Math.hypot(dx, dz) || 1;
    bench(D, x, w.heightAt(x, z) + 0.015, z, dx / dl, dz / dl);
    benches++;
  }
  for (const pth of paths.slice(0, 2)) {
    const [a, bb] = pth[Math.floor(pth.length * 0.3)];
    const x = F.x(a + 0.09, bb), z = F.z(a + 0.09, bb);
    lampPost(ctx, x, w.heightAt(x, z) + 0.01, z, -F.rx, -F.rz, 0.42, 0.04);
  }
  // low hedge around the back and sides
  D.use(WC.GRAVEL, 0x45632f, 0);
  const hedge = (a0: number, b0: number, a1: number, b1: number) => {
    const x0 = F.x(a0, b0), z0 = F.z(a0, b0), x1 = F.x(a1, b1), z1 = F.z(a1, b1);
    const len = Math.hypot(x1 - x0, z1 - z0);
    if (len < 0.05) return;
    const mx = (x0 + x1) / 2, mz = (z0 + z1) / 2;
    D.tbox(mx, Math.min(w.heightAt(x0, z0), w.heightAt(x1, z1)) - 0.02, mz, len, 0.1, 0.07, (z1 - z0) / len, -(x1 - x0) / len, 0.5);
  };
  hedge(-hw + 0.04, -hd + 0.04, hw - 0.04, -hd + 0.04);
  hedge(-hw + 0.04, -hd + 0.04, -hw + 0.04, hd - 0.3);
  hedge(hw - 0.04, -hd + 0.04, hw - 0.04, hd - 0.3);
}

export function buildPlaza(ctx: ChunkCtx, b: Building) {
  const w = ctx.game.world;
  const W = ctx.w, D = ctx.d;
  const r = new RNG(b.seed);
  const F = fitLot(ctx, b);
  const { hw, hd } = F;
  // terrain under the square (sampled on a grid: the game's base height only looks at corners)
  let hmin = Infinity, hmax = -Infinity;
  for (let a = -hw; a <= hw + 1e-6; a += Math.max(0.3, hw / 6)) for (let bb = -hd; bb <= hd + 1e-6; bb += Math.max(0.3, hd / 6)) {
    const hgt = w.heightAt(F.x(a, bb), F.z(a, bb));
    hmin = Math.min(hmin, hgt); hmax = Math.max(hmax, hgt);
  }
  const level = hmax - hmin <= 0.3;
  const cx = F.cx, cz = F.cz;
  const R = Math.max(0.22, Math.min(0.5, Math.min(hw, hd) * 0.32));
  // the centrepiece always stands on a level pad
  const padY = level ? hmax + 0.02 : Math.max(w.heightAt(cx, cz), ...[0, 1, 2, 3, 4, 5].map((k) => w.heightAt(cx + Math.cos(k) * (R + 0.2), cz + Math.sin(k) * (R + 0.2)))) + 0.03;
  const y0 = padY;
  const bw = Math.min(0.14, Math.min(hw, hd) * 0.15);
  const tone = r.chance(0.5) ? 0xe6dccb : 0xd8d4cc;
  if (level) {
    // raised square: stone sides, paved border, cobbled field
    W.use(WC.STONE, 0xbdb3a2, 1);
    W.tbox(F.cx, hmin - 0.08, F.cz, 2 * hw, y0 - hmin + 0.08, 2 * hd, F.fx, F.fz, WSCALE.STONE, false, false);
    W.cast = 0;
    const flat = (cell: number, color: number, a0: number, a1: number, b0: number, b1: number, yy: number, sc: number) => {
      W.use(cell, color, 0);
      const p = [[a0, b0], [a1, b0], [a1, b1], [a0, b1]].map(([a, bb]) => [F.x(a, bb), F.z(a, bb)]);
      W.ttri(p[0][0], yy, p[0][1], p[0][0] / sc, p[0][1] / sc, p[1][0], yy, p[1][1], p[1][0] / sc, p[1][1] / sc, p[2][0], yy, p[2][1], p[2][0] / sc, p[2][1] / sc, 0, 1, 0);
      W.ttri(p[0][0], yy, p[0][1], p[0][0] / sc, p[0][1] / sc, p[2][0], yy, p[2][1], p[2][0] / sc, p[2][1] / sc, p[3][0], yy, p[3][1], p[3][0] / sc, p[3][1] / sc, 0, 1, 0);
    };
    flat(WC.PAVING, 0xb8b0a2, -hw, hw, -hd, -hd + bw, y0, WSCALE.PAVING);
    flat(WC.PAVING, 0xb8b0a2, -hw, hw, hd - bw, hd, y0, WSCALE.PAVING);
    flat(WC.PAVING, 0xb8b0a2, -hw, -hw + bw, -hd + bw, hd - bw, y0, WSCALE.PAVING);
    flat(WC.PAVING, 0xb8b0a2, hw - bw, hw, -hd + bw, hd - bw, y0, WSCALE.PAVING);
    flat(WC.COBBLE, tone, -hw + bw, hw - bw, -hd + bw, hd - bw, y0, WSCALE.COBBLE);
  } else {
    // sloping square: paving follows the ground; a level stone pad carries the centrepiece
    W.cast = 0;
    W.use(WC.PAVING, 0xb8b0a2, 0);
    terrainPatch(W, w, F, -hw, hw, -hd, -hd + bw, 0.026, WSCALE.PAVING, 0.33);
    terrainPatch(W, w, F, -hw, hw, hd - bw, hd, 0.026, WSCALE.PAVING, 0.33);
    terrainPatch(W, w, F, -hw, -hw + bw, -hd + bw, hd - bw, 0.026, WSCALE.PAVING, 0.33);
    terrainPatch(W, w, F, hw - bw, hw, -hd + bw, hd - bw, 0.026, WSCALE.PAVING, 0.33);
    W.use(WC.COBBLE, tone, 0);
    terrainPatch(W, w, F, -hw + bw, hw - bw, -hd + bw, hd - bw, 0.026, WSCALE.COBBLE, 0.33);
    W.use(WC.STONE, 0xbdb3a2, 1);
    const ring = 20, Rp = R + 0.2;
    const pts: [number, number][] = [];
    for (let k = 0; k < ring; k++) { const t = (k / ring) * Math.PI * 2; pts.push([cx + Math.cos(t) * Rp, cz + Math.sin(t) * Rp]); }
    for (let k = 0; k < ring; k++) {
      const [ax, az] = pts[k], [bx2, bz2] = pts[(k + 1) % ring];
      wallQuad(W, ax, az, bx2, bz2, w.heightAt(ax, az) - 0.05, y0, w.heightAt(bx2, bz2) - 0.05, y0, (ax + bx2) / 2 - cx, (az + bz2) / 2 - cz);
    }
  }
  // centrepiece: fountain or monument on a darker ring
  W.use(WC.COBBLE, 0x9a948a, 0);
  disc(W, w, F, 0, 0, R + 0.2, R + 0.2, y0, 0.004, WSCALE.COBBLE, 0, 1, 20);
  if (r.chance(0.6)) {
    // fountain: basin with rim, water, column and bowl
    const yb = y0 + 0.004, rimH = 0.07;
    W.use(WC.STONE, 0xd9d0bf, 1);
    W.cylinder(cx, yb, cz, R, rimH, 20, R, false);
    const ringIn = R - 0.035;
    for (let k = 0; k < 20; k++) {
      const t0 = (k / 20) * Math.PI * 2, t1 = ((k + 1) / 20) * Math.PI * 2;
      const o0 = [cx + Math.cos(t0) * R, cz + Math.sin(t0) * R], o1 = [cx + Math.cos(t1) * R, cz + Math.sin(t1) * R];
      const i0 = [cx + Math.cos(t0) * ringIn, cz + Math.sin(t0) * ringIn], i1 = [cx + Math.cos(t1) * ringIn, cz + Math.sin(t1) * ringIn];
      W.ttri(o0[0], yb + rimH, o0[1], 0, 0, o1[0], yb + rimH, o1[1], 0.1, 0, i1[0], yb + rimH, i1[1], 0.1, 0.05, 0, 1, 0);
      W.ttri(o0[0], yb + rimH, o0[1], 0, 0, i1[0], yb + rimH, i1[1], 0.1, 0.05, i0[0], yb + rimH, i0[1], 0, 0.05, 0, 1, 0);
      // inner wall above the water, facing the centre
      wallQuad(W, i0[0], i0[1], i1[0], i1[1], yb + rimH - 0.03, yb + rimH, yb + rimH - 0.03, yb + rimH, cx - (i0[0] + i1[0]) / 2, cz - (i0[1] + i1[1]) / 2);
    }
    W.use(WC.WATER, 0xffffff, 0);
    disc(W, w, F, 0, 0, ringIn, ringIn, yb + rimH - 0.025, 0, WSCALE.WATER, 0, 1, 20);
    W.use(WC.STONE, 0xd9d0bf, 1);
    W.cylinder(cx, yb + rimH - 0.03, cz, 0.04, 0.16, 8);
    W.cylinder(cx, yb + rimH + 0.13, cz, 0.12, 0.025, 12, 0.13);
    W.cylinder(cx, yb + rimH + 0.155, cz, 0.018, 0.08, 6, 0.008);
    W.use(WC.WATER, 0xc8e4ec, 0);
    W.cylinder(cx, yb + rimH + 0.15, cz, 0.105, 0.006, 12);
  } else {
    // monument: stepped plinth with an obelisk or a column and statue
    W.use(WC.STONE, 0xcfc6b4, 1);
    W.tbox(cx, y0, cz, 0.42, 0.06, 0.42, F.fx, F.fz, WSCALE.STONE);
    W.tbox(cx, y0 + 0.06, cz, 0.3, 0.06, 0.3, F.fx, F.fz, WSCALE.STONE);
    if (r.chance(0.5)) {
      const h = 0.9, b0 = 0.1, b1 = 0.06, yb = y0 + 0.12;
      const c = (s: number, t: number, hh: number, k: number): [number, number, number] => [cx + F.rx * s * k + F.fx * t * k, yb + hh, cz + F.rz * s * k + F.fz * t * k];
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
      for (let i = 0; i < 4; i++) {
        const [s0, t0] = corners[i], [s1, t1] = corners[(i + 1) % 4];
        const a = c(s0, t0, 0, b0), bq = c(s1, t1, 0, b0), cq = c(s1, t1, h, b1), dq = c(s0, t0, h, b1);
        const ox = (a[0] + bq[0]) / 2 - cx, oz = (a[2] + bq[2]) / 2 - cz;
        W.ttri(...a, 0, 0, ...bq, 0.2, 0, ...cq, 0.2, 2, ox, 0, oz);
        W.ttri(...a, 0, 0, ...cq, 0.2, 2, ...dq, 0, 2, ox, 0, oz);
        const apex: [number, number, number] = [cx, yb + h + 0.12, cz];
        W.ttri(...dq, 0, 0, ...cq, 0.2, 0, ...apex, 0.1, 0.2, ox, 0.5, oz);
      }
    } else {
      W.cylinder(cx, y0 + 0.12, cz, 0.07, 0.62, 10);
      W.tbox(cx, y0 + 0.74, cz, 0.18, 0.04, 0.18, F.fx, F.fz, WSCALE.STONE);
      W.use(WC.METAL, 0x5d6b52, 1);
      W.box(cx, y0 + 0.78, cz, 0.06, 0.13, 0.04, F.fx, F.fz);
      W.cylinder(cx, y0 + 0.91, cz, 0.022, 0.035, 6);
    }
  }
  // planters with trees along the long sides, benches facing the centre, lamps at the corners
  const along = hw >= hd;
  const n = Math.max(1, Math.round((along ? 2 * hw : 2 * hd) / 1.1));
  for (let k = 0; k < n; k++) {
    const t = n === 1 ? 0 : -1 + (2 * k) / (n - 1);
    for (const s of [-1, 1]) {
      const a = along ? t * (hw - 0.35) : s * (hw - 0.3), bb = along ? s * (hd - 0.3) : t * (hd - 0.35);
      if (Math.hypot(a, bb) < R + 0.35) continue;
      const x = F.x(a, bb), z = F.z(a, bb);
      const py = level ? y0 : w.heightAt(x, z) + 0.026;
      W.use(WC.STONE, 0xb5ab99, 1);
      W.tbox(x, py - (level ? 0 : 0.05), z, 0.2, 0.08 + (level ? 0 : 0.05), 0.2, F.fx, F.fz, WSCALE.STONE, false);
      W.use(WC.FLOWERS, 0x9a9a9a, 0);
      W.ttri(x - 0.085, py + 0.075, z - 0.085, 0, 0, x + 0.085, py + 0.075, z - 0.085, 0.3, 0, x + 0.085, py + 0.075, z + 0.085, 0.3, 0.3, 0, 1, 0);
      W.ttri(x - 0.085, py + 0.075, z - 0.085, 0, 0, x + 0.085, py + 0.075, z + 0.085, 0.3, 0.3, x - 0.085, py + 0.075, z + 0.085, 0, 0.3, 0, 1, 0);
      ctx.trees.push({ type: r.chance(0.3) ? 1 : 0, x, y: py + 0.07, z, s: 0.5 + r.next() * 0.15, rot: r.next() * Math.PI * 2, tint: r.next() });
      // bench between planter and centre
      const ba = a * 0.72, bb2 = bb * 0.72;
      if (Math.hypot(ba, bb2) > R + 0.3 && k % 2 === 0) {
        const bx = F.x(ba, bb2), bz = F.z(ba, bb2);
        const dx = cx - bx, dz = cz - bz, dl = Math.hypot(dx, dz) || 1;
        bench(D, bx, level ? y0 : w.heightAt(bx, bz) + 0.026, bz, dx / dl, dz / dl);
      }
    }
  }
  for (const [sa, sb] of [[-1, -1], [1, 1]]) {
    const x = F.x(sa * (hw - 0.12), sb * (hd - 0.12)), z = F.z(sa * (hw - 0.12), sb * (hd - 0.12));
    lampPost(ctx, x, level ? y0 : w.heightAt(x, z) + 0.026, z, F.fx, F.fz, 0.44, 0.0);
  }
}
