// Town buildings: facade-atlas walls on rotated rectangles, textured roofs (tiles/slate/flat) with dormers,
// balconies, rooftop details and front gardens. Walls = facade layer; roofs = world layer; small
// details = detail layer (hidden at a distance).
import type { World, Building } from '../game/world';
import { RNG } from '../game/rng';
import { FLOOR_H, BUILDING_TYPES, BT_HOUSE_S, BT_HOUSE_L, BT_TOWNHOUSE, BT_SHOP, BT_APARTMENT, BT_OFFICE, BT_TOWER, BT_CHURCH } from '../game/towns';
import { WB } from './build-mesh';
import { FC, WC, WSCALE, FACADE_CELL0 } from './textures';
import type { ChunkCtx } from './build-common';
import { EARTHWORK_TINT } from './build-common';
import { buildPark, buildPlaza, BT_PARK, BT_PLAZA } from './build-landuse';

/** Width of one window bay on facades (units). */
export const BAY = 0.32;
export { FLOOR_H };


/** Simplified parts of the building being built, recorded for its far LOD version (null = not recording). */
interface FarPart { k: 'box' | 'gable' | 'hip' | 'flat' | 'ends' | 'spire'; a: number[]; c?: number; cell?: number; along?: boolean; tint?: number; seed?: number; fh?: number }
let REC: FarPart[] | null = null;

/**
 * Builder for facade walls (world material): uv in (bay, floor) units, aCell = FACADE_CELL0 + facade
 * atlas cell, aSeed for the lit-window pattern. Writes into the given world builder (or its own).
 */
export class FacadeBuilder {
  gb: WB;
  constructor(gb?: WB) { this.gb = gb ?? new WB(); }

  private push(ax: number, az: number, bx: number, bz: number, ya: number, yb: number, u0: number, u1: number, v0: number, v1: number, cell: number, seed: number) {
    const gb = this.gb;
    const pc = gb.cell, ps = gb.seed, pk = gb.cast;
    gb.cell = FACADE_CELL0 + cell; gb.seed = seed % 997; gb.cast = 1;
    gb.quad(ax, ya, az, bx, ya, bz, bx, yb, bz, ax, yb, az, [u0, v0, u1, v1]);
    gb.cell = pc; gb.seed = ps; gb.cast = pk;
  }

  /**
   * Wall between bottom points A and B facing outward (nx,nz). Ground floor uses `ground` (all bays) or,
   * with `door`, a single door bay in the middle and `upper` cells elsewhere.
   */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, nx: number, nz: number,
    upper: number, ground: number, tint: number, seed: number, floorH = FLOOR_H, door = -1) {
    const ux = bx - ax, uz = bz - az;
    if (-uz * nx + ux * nz < 0) { [ax, bx] = [bx, ax]; [az, bz] = [bz, az]; }
    const len = Math.hypot(bx - ax, bz - az);
    const bays = Math.max(1, Math.round(len / BAY));
    const H = y1 - y0;
    const floors = Math.max(1, Math.round(H / floorH));
    this.gb.color(tint);
    const gh = H / floors;
    const lerp = (t: number): [number, number] => [ax + (bx - ax) * t, az + (bz - az) * t];
    if (door >= 0) {
      const k = Math.floor((bays - 1) / 2);
      const [p0x, p0z] = lerp(k / bays), [p1x, p1z] = lerp((k + 1) / bays);
      if (k > 0) this.push(ax, az, p0x, p0z, y0, y0 + gh, 0, k, 0, 1, upper, seed);
      this.push(p0x, p0z, p1x, p1z, y0, y0 + gh, k, k + 1, 0, 1, door, seed);
      if (k + 1 < bays) this.push(p1x, p1z, bx, bz, y0, y0 + gh, k + 1, bays, 0, 1, upper, seed);
      if (floors > 1) this.push(ax, az, bx, bz, y0 + gh, y1, 0, bays, 1, floors, upper, seed);
    } else if (ground >= 0) {
      this.push(ax, az, bx, bz, y0, y0 + gh, 0, bays, 0, 1, ground, seed);
      if (floors > 1) this.push(ax, az, bx, bz, y0 + gh, y1, 0, bays, 1, floors, upper, seed);
    } else this.push(ax, az, bx, bz, y0, y1, 0, bays, 0, floors, upper, seed);
  }

  /** Four walls of an oriented box; front faces (fx,fz). */
  boxWalls(cx: number, y: number, cz: number, W: number, D: number, H: number, fx: number, fz: number,
    upper: number, ground: number, tint: number, seed: number,
    opts: { frontCell?: number; sideGround?: number; door?: number; floorH?: number; skipFront?: boolean } = {}) {
    const rx = fz, rz = -fx;
    const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
    const hw = W / 2, hd = D / 2;
    const fl = P(-hw, hd), fr = P(hw, hd), bl = P(-hw, -hd), br = P(hw, -hd);
    const sg = opts.sideGround ?? -1;
    const fh = opts.floorH ?? FLOOR_H;
    if (REC) REC.push({ k: 'box', a: [cx, y, cz, W, D, H, fx, fz], cell: upper, tint, seed, fh });
    if (!opts.skipFront) {
      if (opts.frontCell === undefined) this.wall(fl[0], fl[1], fr[0], fr[1], y, y + H, fx, fz, upper, ground, tint, seed, fh, opts.door ?? -1);
      else if (opts.frontCell >= 0) this.wall(fl[0], fl[1], fr[0], fr[1], y, y + H, fx, fz, opts.frontCell, -1, tint, seed, H);
    }
    this.wall(br[0], br[1], bl[0], bl[1], y, y + H, -fx, -fz, upper, sg, tint, seed + 1, fh);
    this.wall(fr[0], fr[1], br[0], br[1], y, y + H, rx, rz, upper, sg, tint, seed + 2, fh);
    this.wall(bl[0], bl[1], fl[0], fl[1], y, y + H, -rx, -rz, upper, sg, tint, seed + 3, fh);
  }
}

type V3 = [number, number, number];

/** Textured sloped quad (a,b on the eave, c,d on the ridge side): u along the eave, v up the slope. */
function slope(W: WB, a: V3, b: V3, c: V3, d: V3, sc: number, ox: number, oz: number) {
  const ex = b[0] - a[0], ez = b[2] - a[2];
  const el = Math.hypot(ex, ez) || 1;
  const ux = ex / el, uz = ez / el;
  const uv = (p: V3): [number, number] => {
    const du = (p[0] - a[0]) * ux + (p[2] - a[2]) * uz;
    const hx = p[0] - a[0] - ux * du, hz = p[2] - a[2] - uz * du;
    return [du / sc, Math.hypot(Math.hypot(hx, hz), p[1] - a[1]) / sc];
  };
  const [ua, va] = uv(a), [ub, vb] = uv(b), [uc, vc] = uv(c), [ud, vd] = uv(d);
  W.ttri(a[0], a[1], a[2], ua, va, b[0], b[1], b[2], ub, vb, c[0], c[1], c[2], uc, vc, ox, 1, oz);
  W.ttri(a[0], a[1], a[2], ua, va, c[0], c[1], c[2], uc, vc, d[0], d[1], d[2], ud, vd, ox, 1, oz);
}

/** Gabled roof; ridge along local z (forward) if `alongForward`. Textured slopes plus eave undersides. */
export function roofGable(W: WB, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number, alongForward: boolean, cell = WC.ROOF_TILES, under = true) {
  if (REC) REC.push({ k: 'gable', a: [cx, y, cz, w, d, h, fx, fz], c: color, cell, along: alongForward });
  const rx = fz, rz = -fx;
  const [ax, az, bx, bz, ha, hl] = alongForward ? [rx, rz, fx, fz, w / 2, d / 2] : [fx, fz, rx, rz, d / 2, w / 2];
  const P = (a: number, b: number, yy: number): V3 => [cx + ax * a + bx * b, yy, cz + az * a + bz * b];
  const sc = cell === WC.ROOF_SLATE ? WSCALE.ROOF_SLATE : WSCALE.ROOF_TILES;
  W.use(cell, color, 1);
  for (const s of [-1, 1]) {
    const e0 = P(s * ha, -hl, y), e1 = P(s * ha, hl, y), r1 = P(0, hl, y + h), r0 = P(0, -hl, y + h);
    slope(W, e0, e1, r1, r0, sc, ax * s, az * s);
  }
  if (!under) return;
  // eave undersides (seen from below/sides)
  W.use(WC.PLAIN, color, 1).color(color, 0.5);
  for (const s of [-1, 1]) {
    const e0 = P(s * ha, -hl, y - 0.005), e1 = P(s * ha, hl, y - 0.005), r1 = P(0, hl, y + h - 0.005), r0 = P(0, -hl, y + h - 0.005);
    W.ttri(...e0, 0, 0, ...e1, 0, 0, ...r1, 0, 0, 0, -1, 0);
    W.ttri(...e0, 0, 0, ...r1, 0, 0, ...r0, 0, 0, 0, -1, 0);
  }
}

/** Hipped roof: four sloped faces, ridge along the longer side. */
export function roofHip(W: WB, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number, cell = WC.ROOF_TILES) {
  if (REC) REC.push({ k: 'hip', a: [cx, y, cz, w, d, h, fx, fz], c: color, cell });
  const rx = fz, rz = -fx;
  const P = (a: number, b: number, yy: number): V3 => [cx + rx * a + fx * b, yy, cz + rz * a + fz * b];
  const hw = w / 2, hd = d / 2;
  const alongZ = d >= w;
  const r = alongZ ? hd - hw : hw - hd;
  const r0 = alongZ ? P(0, -r, y + h) : P(-r, 0, y + h), r1 = alongZ ? P(0, r, y + h) : P(r, 0, y + h);
  const c = [P(-hw, -hd, y), P(hw, -hd, y), P(hw, hd, y), P(-hw, hd, y)];
  const sc = cell === WC.ROOF_SLATE ? WSCALE.ROOF_SLATE : WSCALE.ROOF_TILES;
  W.use(cell, color, 1);
  // faces: back (c0,c1), right (c1,c2), front (c2,c3), left (c3,c0)
  const out: [number, number][] = [[-fx, -fz], [rx, rz], [fx, fz], [-rx, -rz]];
  const tops: [V3, V3][] = alongZ ? [[r0, r0], [r1, r0], [r1, r1], [r0, r1]] : [[r1, r0], [r1, r1], [r0, r1], [r0, r0]];
  for (let i = 0; i < 4; i++) {
    const a = c[i], b = c[(i + 1) % 4];
    const [t1, t0] = tops[i]; // t1 above b, t0 above a
    slope(W, a, b, t1, t0, sc, out[i][0], out[i][1]);
  }
}

/** Horizontal quad facing up, corners a..d in either winding; uv rectangle as WB.quad. */
function hq(W: WB, a: V3, b: V3, c: V3, d: V3, uv: [number, number, number, number]) {
  const ny = (b[2] - a[2]) * (d[0] - a[0]) - (b[0] - a[0]) * (d[2] - a[2]);
  if (ny >= 0) W.quad(...a, ...b, ...c, ...d, uv);
  else W.quad(...a, ...d, ...c, ...b, [uv[1], uv[0], uv[3], uv[2]]);
}

/** Flat roof with a low parapet ring (roof surface inside it; no hidden or coplanar faces). */
export function roofFlat(W: WB, cx: number, y: number, cz: number, w: number, d: number, fx: number, fz: number, color = 0x9a9890) {
  if (REC) REC.push({ k: 'flat', a: [cx, y, cz, w, d, fx, fz], c: color });
  const rx = fz, rz = -fx;
  const t = Math.min(0.04, w * 0.2, d * 0.2), ph = 0.07;
  const hw = w / 2, hd = d / 2, iw = hw - t, id = hd - t;
  const P = (a: number, b: number, yy: number): V3 => [cx + rx * a + fx * b, yy, cz + rz * a + fz * b];
  const sc = WSCALE.ROOF_FLAT, ys = y + 0.02, yt = y + ph;
  W.use(WC.ROOF_FLAT, color, 1);
  hq(W, P(-iw, -id, ys), P(iw, -id, ys), P(iw, id, ys), P(-iw, id, ys), [0, 0, (2 * iw) / sc, (2 * id) / sc]);
  W.use(WC.CONCRETE, 0xbab6ae, 1);
  const O = [P(-hw, -hd, yt), P(hw, -hd, yt), P(hw, hd, yt), P(-hw, hd, yt)];
  const I = [P(-iw, -id, yt), P(iw, -id, yt), P(iw, id, yt), P(-iw, id, yt)];
  const out = [[-fx, -fz], [rx, rz], [fx, fz], [-rx, -rz]];
  for (let i = 0; i < 4; i++) {
    const j = (i + 1) & 3, nx = out[i][0], nz = out[i][1];
    W.twall(O[i][0], O[i][2], O[j][0], O[j][2], y, yt, y, yt, nx, nz, 1);
    W.twall(I[i][0], I[i][2], I[j][0], I[j][2], ys, yt, ys, yt, -nx, -nz, 1);
    hq(W, O[i], O[j], I[j], I[i], [0, 0, 1, 0.04]);
  }
}

/** Gable end walls (triangles) under a gabled roof. */
export function gableWalls(W: WB, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number, alongForward: boolean) {
  if (REC) REC.push({ k: 'ends', a: [cx, y, cz, w, d, h, fx, fz], c: color, along: alongForward });
  const rx = fz, rz = -fx;
  const [ax, az, bx, bz, hw, hl] = alongForward ? [rx, rz, fx, fz, w / 2, d / 2] : [fx, fz, rx, rz, d / 2, w / 2];
  const P = (a: number, b: number, yy: number): V3 => [cx + ax * a + bx * b, yy, cz + az * a + bz * b];
  W.use(WC.PLAIN, color, 1);
  for (const sb of [-1, 1]) {
    const a = P(-hw, sb * hl, y), b = P(hw, sb * hl, y), c = P(0, sb * hl, y + h);
    W.ttri(...a, 0, 0, ...b, 0, 0, ...c, 0, 0, bx * sb, 0, bz * sb);
  }
}

/** Company sign board facing (nx,nz) with fake lettering. */
export function boardText(D: WB, x: number, y: number, z: number, nx: number, nz: number, w: number, h: number, color: number) {
  const rx = -nz, rz = nx;
  const P = (a: number, b: number, f: number): V3 => [x + rx * a + nx * f, y + b, z + rz * a + nz * f];
  D.use(WC.PLAIN, color, 0);
  const q = (a0: number, a1: number, b0: number, b1: number, f: number) => {
    const p0 = P(a0, b0, f), p1 = P(a1, b0, f), p2 = P(a1, b1, f), p3 = P(a0, b1, f);
    D.ttri(...p0, 0, 0, ...p1, 0, 0, ...p2, 0, 0, nx, 0, nz);
    D.ttri(...p0, 0, 0, ...p2, 0, 0, ...p3, 0, 0, nx, 0, nz);
  };
  q(-w / 2, w / 2, -h / 2, h / 2, 0);
  D.use(WC.PLAIN, 0xf4f4f0, 0);
  const lh = h * 0.42, lw = lh * 0.62, gap = lh * 0.22;
  const n = Math.max(2, Math.floor((w * 0.82) / (lw + gap)));
  const tw = n * (lw + gap) - gap;
  let a = -tw / 2;
  for (let i = 0; i < n; i++) {
    if (i % 5 !== 3) q(a, a + lw, -lh / 2, lh / 2, 0.002);
    a += lw + gap;
  }
}

/** Lowest terrain height under a rectangle (corners + centre). */
export function lowestUnder(w: World, x: number, z: number, angle: number, W: number, D: number): number {
  const fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx;
  let lo = w.heightAt(x, z);
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lo = Math.min(lo, w.heightAt(x + rx * a * W / 2 + fx * b * D / 2, z + rz * a * W / 2 + fz * b * D / 2));
  return lo;
}

/** Dormer on the front slope of a gable roof whose ridge runs along local x. */
function dormer(W: WB, fac: FacadeBuilder, cx: number, cz: number, fx: number, fz: number, along: number, D2: number, yE: number, rh: number, wallTint: number, roofC: number, seed: number) {
  const rx = fz, rz = -fx;
  const dw = 0.26, dh = 0.2;
  const zf = D2 * 0.45;
  const ySlope = (zz: number) => yE + rh * (1 - zz / D2);
  const yb = ySlope(zf), top = yb + dh;
  if (top + 0.02 > yE + rh) return;
  const zb = D2 * (1 - (top - yE) / rh);
  const P = (a: number, b: number, yy: number): V3 => [cx + rx * (along + a) + fx * b, yy, cz + rz * (along + a) + fz * b];
  // window wall
  const l = P(-dw / 2, zf, yb), r = P(dw / 2, zf, yb);
  fac.wall(l[0], l[2], r[0], r[2], yb - 0.02, top, fx, fz, FC.HOUSE, -1, wallTint, seed, dh + 0.02);
  W.use(WC.PLAIN, wallTint, 1);
  for (const s of [-1, 1]) {
    const a = P(s * dw / 2, zf, yb - 0.02), b = P(s * dw / 2, zf, top), c = P(s * dw / 2, zb, top);
    W.ttri(...a, 0, 0, ...b, 0, 0, ...c, 0, 0, rx * s, 0, rz * s);
  }
  // little gable roof over the dormer, ridge running back into the main roof
  const g = 0.08;
  const fg = P(0, zf + 0.03, top + g), bg = P(0, zb, top + g);
  W.use(WC.PLAIN, wallTint, 1);
  W.ttri(...P(-dw / 2, zf, top), 0, 0, ...P(dw / 2, zf, top), 0, 0, ...P(0, zf, top + g), 0, 0, fx, 0, fz);
  for (const s of [-1, 1]) {
    const e0 = P(s * (dw / 2 + 0.03), zf + 0.03, top - 0.01), e1 = P(s * (dw / 2 + 0.03), zb, top - 0.01);
    W.use(WC.ROOF_TILES, roofC, 1);
    slope(W, e0, e1, bg, fg, WSCALE.ROOF_TILES, rx * s, rz * s);
  }
}

const PASTELS = [0xf3e9d2, 0xf0dcc0, 0xe2ebf0, 0xf2e0dc, 0xe5eed6, 0xffffff, 0xeedfb8, 0xf5e6c8, 0xdfe6ea];
const ROOFS_TILE = [0xb5583a, 0xc0653f, 0xa04a30, 0x9a5236, 0x8b4a33, 0xb86b48];
const ROOFS_SLATE = [0x5a6068, 0x4b525a, 0x64686c, 0x52565e];
const AWNINGS = [0xb83b3b, 0x2f6e9e, 0x3c8c4e, 0xd09a2a, 0x6b4a8a];

/**
 * A building (near detail into W/Dt/fac). With `far`, a simplified version (facade boxes and plain roofs,
 * no details) is emitted into it as well, for the distant LOD of the super-chunk.
 */
export function buildBuilding(w: World, b: Building, W: WB, Dt: WB, fac: FacadeBuilder, ctx?: ChunkCtx, far?: WB | null) {
  // land use without a building (until the game exports BT_PARK / BT_PLAZA they are keyed off the numbers)
  if (b.type === BT_PARK || b.type === BT_PLAZA) {
    if (ctx) { if (b.type === BT_PARK) buildPark(ctx, b); else buildPlaza(ctx, b); }
    return;
  }
  if (!far) { buildNear(w, b, W, Dt, fac); return; }
  const parts: FarPart[] = [];
  REC = parts;
  try { buildNear(w, b, W, Dt, fac, parts); } finally { REC = null; }
  emitFar(w, b, far, parts);
}

const FARF = new FacadeBuilder();

/**
 * The far version from recorded parts: one quad per facade wall, plain roofs. Walls standing on the
 * building base reach down into the ground (no plinth) unless the lot is steep enough to show one.
 */
function emitFar(w: World, b: Building, F: WB, parts: FarPart[]) {
  const ff = FARF;
  ff.gb = F;
  const lowest = lowestUnder(w, b.x, b.z, b.angle, b.w, b.d);
  const base = b.y + 0.04;
  // Subpixel base bands can share the facade's ground-reaching quad; retain visible terrace walls.
  const plinth = b.y - lowest > 0.4;
  if (plinth) {
    F.use(WC.STONE, 0xa59d90, 1);
    F.tbox(b.x, lowest - 0.06, b.z, b.w + 0.03, base - lowest + 0.06, b.d + 0.03, Math.sin(b.angle), Math.cos(b.angle), WSCALE.STONE, false, false);
  }
  const y0 = lowest - 0.03;
  for (const p of parts) {
    const a = p.a;
    if (p.k === 'box') {
      if (!plinth && Math.abs(a[1] - base) < 1e-4) {
        // same number of floors, stretched down to the ground
        const H = a[5] + (a[1] - y0), floors = Math.max(1, Math.round(a[5] / p.fh!));
        ff.boxWalls(a[0], y0, a[2], a[3], a[4], H, a[6], a[7], p.cell!, -1, p.tint!, p.seed!, { floorH: H / floors });
      } else ff.boxWalls(a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], p.cell!, -1, p.tint!, p.seed!, { floorH: p.fh });
    }
    else if (p.k === 'gable') roofGable(F, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], p.c!, p.along!, p.cell, false);
    else if (p.k === 'hip') roofHip(F, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], p.c!, p.cell);
    else if (p.k === 'ends') gableWalls(F, a[0], a[1], a[2], a[3], a[4], a[5], a[6], a[7], p.c!, p.along!);
    else if (p.k === 'flat') {
      const [cx, y, cz, wd, dd, fx, fz] = a;
      const rx = fz, rz = -fx, hw = wd / 2, hd = dd / 2, yy = y + 0.01, sc = WSCALE.ROOF_FLAT;
      const P = (u: number, v: number): V3 => [cx + rx * u + fx * v, yy, cz + rz * u + fz * v];
      F.use(WC.ROOF_FLAT, p.c!, 1);
      hq(F, P(-hw, -hd), P(hw, -hd), P(hw, hd), P(-hw, hd), [0, 0, wd / sc, dd / sc]);
    } else if (p.k === 'spire') {
      const [tx, sy, tz, hs, sh, fx, fz] = a;
      const rx = fz, rz = -fx;
      const apex: V3 = [tx, sy + sh, tz];
      const cs: V3[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, v]) => [tx + rx * u * hs + fx * v * hs, sy, tz + rz * u * hs + fz * v * hs]);
      F.use(WC.ROOF_SLATE, p.c!, 1);
      for (let i = 0; i < 4; i++) {
        const q0 = cs[i], q1 = cs[(i + 1) % 4];
        F.ttri(...q0, 0, 0, ...q1, 1, 0, ...apex, 0.5, 2, (q0[0] + q1[0]) / 2 - tx, 0, (q0[2] + q1[2]) / 2 - tz);
      }
    }
  }
}

/**
 * The base a building stands on, down to the lowest ground under it. Short: a dark stone base band. Tall (a
 * sloping lot): a dressed-stone terrace wall with a coping round a lawn, wider on the downhill sides, and steps
 * from the front door down to the ground - never a bare block.
 */
function plinth(w: World, b: Building, W: WB, base: number, lo: number) {
  const fx = Math.sin(b.angle), fz = Math.cos(b.angle), rx = fz, rz = -fx;
  const hw = b.w / 2, hd = b.d / 2;
  const h = base + 0.04 - (lo + 0.06);
  if (h <= 0.16) {
    W.use(WC.STONE, 0x6f675e, 1);
    W.tbox(b.x, lo, b.z, b.w + 0.03, base + 0.04 - lo, b.d + 0.03, fx, fz, WSCALE.STONE, false, false);
    return;
  }
  // how far the ground falls away beside each side (front, back, right, left)
  const drop = (ax: number, az: number) => base - w.heightAt(b.x + ax, b.z + az);
  const dF = drop(fx * (hd + 0.3), fz * (hd + 0.3)), dB = drop(-fx * (hd + 0.3), -fz * (hd + 0.3));
  const dR = drop(rx * (hw + 0.3), rz * (hw + 0.3)), dL = drop(-rx * (hw + 0.3), -rz * (hw + 0.3));
  const ext = (d: number) => (d > 0.12 ? 0.2 : 0.03);
  const eF = ext(dF), eB = ext(dB), eR = ext(dR), eL = ext(dL);
  const TW = b.w + eR + eL, TD = b.d + eF + eB;
  const tcx = b.x + rx * (eR - eL) / 2 + fx * (eF - eB) / 2, tcz = b.z + rz * (eR - eL) / 2 + fz * (eF - eB) / 2;
  // terrace wall (dressed stone), lawn on top, coping round the edge
  W.use(WC.STONE, 0xb3a894, 1);
  W.tbox(tcx, lo, tcz, TW, base - lo, TD, fx, fz, WSCALE.STONE, false, false);
  const P = (a: number, c: number): [number, number] => [tcx + rx * a + fx * c, tcz + rz * a + fz * c];
  const gs = WSCALE.GRASS;
  W.use(WC.GRASS, EARTHWORK_TINT, 0);
  {
    const p0 = P(-TW / 2, -TD / 2), p1 = P(TW / 2, -TD / 2), p2 = P(TW / 2, TD / 2), p3 = P(-TW / 2, TD / 2), yy = base + 0.002;
    W.ttri(p0[0], yy, p0[1], p0[0] / gs, p0[1] / gs, p1[0], yy, p1[1], p1[0] / gs, p1[1] / gs, p2[0], yy, p2[1], p2[0] / gs, p2[1] / gs, 0, 1, 0);
    W.ttri(p0[0], yy, p0[1], p0[0] / gs, p0[1] / gs, p2[0], yy, p2[1], p2[0] / gs, p2[1] / gs, p3[0], yy, p3[1], p3[0] / gs, p3[1] / gs, 0, 1, 0);
  }
  W.use(WC.STONE, 0x8d8475, 1);
  for (const [a, c, ww, dd] of [[0, TD / 2 - 0.025, TW + 0.02, 0.05], [0, -TD / 2 + 0.025, TW + 0.02, 0.05], [TW / 2 - 0.025, 0, 0.05, TD], [-TW / 2 + 0.025, 0, 0.05, TD]] as [number, number, number, number][]) {
    const [x, z] = P(a, c);
    W.box(x, base - 0.01, z, ww, 0.04, dd, fx, fz);
  }
  // the building's own base band
  W.use(WC.STONE, 0x6f675e, 1);
  W.tbox(b.x, base - 0.01, b.z, b.w + 0.03, 0.05, b.d + 0.03, fx, fz, WSCALE.STONE, false, false);
  // steps from the front door down to the ground in front
  if (dF > 0.12) {
    const n = Math.max(2, Math.min(8, Math.round(dF / 0.06)));
    const run = Math.min(0.32, n * 0.05), dep = run / n;
    const g = base - dF;
    W.use(WC.STONE, 0xa39886, 1);
    for (let k = 0; k < n; k++) {
      const top = base - ((k + 1) * dF) / (n + 1);
      const [x, z] = [b.x + fx * (hd + eF + (k + 0.5) * dep), b.z + fz * (hd + eF + (k + 0.5) * dep)];
      W.tbox(x, g - 0.05, z, 0.24, top - (g - 0.05), dep, fx, fz, WSCALE.STONE, false, true);
    }
  }
}

function buildNear(w: World, b: Building, W: WB, Dt: WB, fac: FacadeBuilder, parts?: FarPart[]) {
  const r = new RNG(b.seed);
  const fx = Math.sin(b.angle), fz = Math.cos(b.angle);
  const rx = fz, rz = -fx;
  const base = b.y;
  const lo = lowestUnder(w, b.x, b.z, b.angle, b.w, b.d) - 0.06;
  const seed = b.seed;
  const cx = b.x, cz = b.z;
  // the base: a dark stone band where the lot is nearly level, a terrace on a sloping lot
  plinth(w, b, W, base, lo);
  const y = base + 0.04;
  const Wd = b.w, D = b.d;
  const slate = () => r.pick(ROOFS_SLATE);
  switch (b.type) {
    case BT_HOUSE_S:
    case BT_HOUSE_L: {
      const H = b.floors * FLOOR_H;
      const sty = r.next();
      const [up, gr] = sty < 0.4 ? [FC.HOUSE, FC.HOUSE_DOOR] : sty < 0.7 ? [FC.WOOD, FC.WOOD_DOOR] : [FC.BRICK, FC.BRICK_DOOR];
      const tint = up === FC.BRICK ? 0xffffff : r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, Wd, D, H, fx, fz, up, -1, tint, seed, { door: gr });
      const tiles = r.chance(0.7);
      const roofC = tiles ? r.pick(ROOFS_TILE) : slate();
      const cell = tiles ? WC.ROOF_TILES : WC.ROOF_SLATE;
      const wallTint = up === FC.BRICK ? 0xa95f45 : tint;
      let rhUsed = 0;
      if (r.chance(0.35)) {
        const rh = Math.min(Wd, D) * (0.32 + r.next() * 0.12);
        roofHip(W, cx, y + H, cz, Wd + 0.12, D + 0.12, rh, fx, fz, roofC, cell);
      } else {
        const along = r.chance(0.3);
        const span = along ? Wd : D;
        const rh = span * (0.34 + r.next() * 0.16);
        rhUsed = along ? 0 : rh;
        gableWalls(W, cx, y + H, cz, Wd, D, rh, fx, fz, wallTint, along);
        roofGable(W, cx, y + H - 0.01, cz, Wd + 0.12, D + 0.12, rh + 0.02, fx, fz, roofC, along, cell);
        if (!along && b.type === BT_HOUSE_L && Wd > 0.9 && r.chance(0.6)) dormer(W, fac, cx, cz, fx, fz, 0, D / 2 + 0.06, y + H - 0.01, rh + 0.02, wallTint, roofC, seed + 11);
      }
      void rhUsed;
      W.use(WC.PLAIN, 0x8a4a3a, 1);
      W.box(cx + rx * Wd * 0.25 - fx * D * 0.15, y + H, cz + rz * Wd * 0.25 - fz * D * 0.15, 0.08, Math.min(Wd, D) * 0.48, 0.08, fx, fz);
      // front garden: hedge with a gap and a path to the street
      if (r.chance(0.75)) {
        const setback = BUILDING_TYPES[b.type].setback;
        const hz = D / 2 + setback * 0.85;
        const hc = r.chance(0.5) ? 0x3f5a2a : 0x4b6a30;
        for (const s of [-1, 1]) {
          const a0 = 0.08, a1 = Wd / 2 + 0.12;
          const mx = cx + rx * s * (a0 + a1) / 2 + fx * hz, mz = cz + rz * s * (a0 + a1) / 2 + fz * hz;
          const gy = w.heightAt(mx, mz);
          Dt.use(WC.GRAVEL, hc, 0);
          Dt.tbox(mx, gy - 0.02, mz, a1 - a0, 0.1, 0.07, fx, fz, 0.5);
        }
        const pz = D / 2 + setback * 0.42;
        const px = cx + fx * pz, pzz = cz + fz * pz;
        Dt.use(WC.PAVING, 0xcfc8ba, 0);
        Dt.tbox(px, w.heightAt(px, pzz) - 0.01, pzz, 0.1, 0.016, setback * 0.85, fx, fz, WSCALE.PAVING);
      }
      break;
    }
    case BT_TOWNHOUSE: {
      const H = b.floors * FLOOR_H;
      const brick = r.chance(0.5);
      const tint = brick ? 0xffffff : r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, Wd, D, H, fx, fz, brick ? FC.BRICK : FC.TOWNHOUSE, -1, tint, seed, { door: brick ? FC.BRICK_DOOR : FC.TOWN_DOOR });
      const rh = D * (0.3 + r.next() * 0.1);
      const wallTint = brick ? 0xa95f45 : tint;
      const roofC = r.chance(0.5) ? r.pick(ROOFS_TILE) : slate();
      gableWalls(W, cx, y + H, cz, Wd, D, rh, fx, fz, wallTint, false);
      roofGable(W, cx, y + H - 0.01, cz, Wd + 0.04, D + 0.1, rh + 0.02, fx, fz, roofC, false, roofC === 0x5a6068 || ROOFS_SLATE.includes(roofC) ? WC.ROOF_SLATE : WC.ROOF_TILES);
      const nd = Wd > 1.25 ? 2 : 1;
      for (let k = 0; k < nd; k++) dormer(W, fac, cx, cz, fx, fz, nd === 1 ? 0 : (k - 0.5) * Wd * 0.45, D / 2 + 0.05, y + H - 0.01, rh + 0.02, wallTint, roofC, seed + 13 + k);
      W.use(WC.PLAIN, 0x7a5a4a, 1);
      for (const k of [-0.42, 0.42]) W.box(cx + rx * Wd * k, y + H + rh * 0.35, cz + rz * Wd * k, 0.08, rh * 0.85, 0.12, fx, fz);
      // balconies on the upper floors
      if (b.floors >= 3 && r.chance(0.5)) balconies(Dt, cx, cz, fx, fz, Wd, D, y, b.floors, r, 0x6a7076);
      break;
    }
    case BT_SHOP: {
      const H = Math.max(1, b.floors) * FLOOR_H + 0.05;
      const g2 = r.chance(0.5);
      const up = g2 ? FC.BRICK : FC.APART;
      const tint = g2 ? 0xffffff : r.pick(PASTELS);
      if (b.floors <= 1) fac.boxWalls(cx, y, cz, Wd, D, H, fx, fz, g2 ? FC.SHOP2 : FC.SHOP, g2 ? FC.SHOP2 : FC.SHOP, tint, seed, { sideGround: -1, floorH: H });
      else fac.boxWalls(cx, y, cz, Wd, D, H, fx, fz, up, g2 ? FC.SHOP2 : FC.SHOP, tint, seed);
      roofFlat(W, cx, y + H, cz, Wd, D, fx, fz);
      W.use(WC.PLAIN, r.pick(AWNINGS), 1);
      W.box(cx + fx * (D / 2 + 0.1), y + 0.24, cz + fz * (D / 2 + 0.1), Wd * 0.92, 0.03, 0.2, fx, fz, false);
      rooftopUnits(Dt, cx, y + H + 0.02, cz, fx, fz, Wd, D, r, 2);
      break;
    }
    case BT_APARTMENT: {
      const H = b.floors * FLOOR_H;
      const panel = r.chance(0.45);
      const tint = r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, Wd, D, H, fx, fz, panel ? FC.PANEL : FC.APART, -1, tint, seed, { door: FC.APART_DOOR });
      if (!panel) balconies(Dt, cx, cz, fx, fz, Wd, D, y, b.floors, r, r.chance(0.5) ? 0x3a3f44 : 0xe8e4dc);
      if (r.chance(0.3)) {
        roofHip(W, cx, y + H, cz, Wd + 0.08, D + 0.08, Math.min(Wd, D) * 0.22, fx, fz, slate(), WC.ROOF_SLATE);
      } else {
        roofFlat(W, cx, y + H, cz, Wd, D, fx, fz);
        W.use(WC.CONCRETE, 0xcfc9bf, 1);
        W.tbox(cx - fx * D * 0.15 + rx * Wd * 0.2, y + H, cz - fz * D * 0.15 + rz * Wd * 0.2, 0.36, 0.24, 0.3, fx, fz, 1);
        rooftopUnits(Dt, cx, y + H + 0.02, cz, fx, fz, Wd, D, r, 3);
      }
      break;
    }
    case BT_OFFICE: {
      const H = b.floors * FLOOR_H + 0.05;
      const glass = r.chance(0.55);
      fac.boxWalls(cx, y, cz, Wd, D, H, fx, fz, glass ? FC.GLASS : FC.STONE, FC.LOBBY, glass ? 0xffffff : 0xf4efe6, seed, { sideGround: glass ? FC.GLASS : FC.STONE });
      roofFlat(W, cx, y + H, cz, Wd, D, fx, fz, 0x8c8a86);
      W.use(WC.CONCRETE, 0xbfbcb6, 1);
      W.tbox(cx, y + H, cz, Wd * 0.45, 0.28, D * 0.4, fx, fz, 1);
      // water tank on legs
      if (r.chance(0.5)) {
        const tx = cx + rx * Wd * 0.28, tz = cz + rz * Wd * 0.28;
        Dt.use(WC.METAL, 0x6d6258, 0);
        Dt.cylinder(tx, y + H + 0.12, tz, 0.09, 0.16, 8);
        for (const [a, c] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) Dt.box(tx + a * 0.06, y + H, tz + c * 0.06, 0.012, 0.13, 0.012);
      }
      rooftopUnits(Dt, cx, y + H + 0.02, cz, fx, fz, Wd, D, r, 3);
      break;
    }
    case BT_TOWER: {
      const topFloors = Math.min(4, Math.max(2, Math.floor(b.floors / 5)));
      const H1 = (b.floors - topFloors) * FLOOR_H;
      const H2 = topFloors * FLOOR_H;
      const cell = r.chance(0.5) ? FC.TOWER : FC.GLASS;
      fac.boxWalls(cx, y, cz, Wd, D, H1, fx, fz, cell, FC.LOBBY, 0xffffff, seed, { sideGround: cell });
      roofFlat(W, cx, y + H1, cz, Wd, D, fx, fz, 0x7c7a76);
      fac.boxWalls(cx, y + H1, cz, Wd * 0.72, D * 0.72, H2, fx, fz, cell, -1, 0xffffff, seed + 7);
      roofFlat(W, cx, y + H1 + H2, cz, Wd * 0.72, D * 0.72, fx, fz, 0x7c7a76);
      W.use(WC.CONCRETE, 0xb9b6b0, 1);
      W.tbox(cx, y + H1 + H2, cz, Wd * 0.36, 0.22, D * 0.36, fx, fz, 1);
      Dt.use(WC.METAL, 0xc4c8cc, 0);
      Dt.cylinder(cx, y + H1 + H2 + 0.22, cz, 0.02, 1.2, 5);
      Dt.use(WC.LAMP, 0xff3020, 0);
      Dt.box(cx, y + H1 + H2 + 1.42, cz, 0.04, 0.04, 0.04);
      rooftopUnits(Dt, cx, y + H1 + 0.02, cz, fx, fz, Wd, D, r, 2);
      break;
    }
    case BT_CHURCH: {
      const NW = Math.min(Wd * 0.62, 1.0), ND = D * 0.72, H = 0.75;
      const ncx = cx - fx * (D - ND) / 2, ncz = cz - fz * (D - ND) / 2;
      fac.boxWalls(ncx, y, ncz, NW, ND, H, fx, fz, FC.CHURCH, FC.CHURCH, 0xffffff, seed, { sideGround: -1, frontCell: FC.CHURCH_DOOR, floorH: H });
      gableWalls(W, ncx, y + H, ncz, NW, ND, 0.55, fx, fz, 0xc9bfa8, true);
      roofGable(W, ncx, y + H - 0.01, ncz, NW + 0.1, ND + 0.06, 0.6, fx, fz, 0x50585e, true, WC.ROOF_SLATE);
      const TS = Math.min(0.55, NW * 0.6);
      const tx = cx + fx * (D / 2 - TS / 2), tz = cz + fz * (D / 2 - TS / 2);
      const TH = 1.9;
      fac.boxWalls(tx, y, tz, TS, TS, TH, fx, fz, FC.CHURCH, FC.CHURCH_DOOR, 0xffffff, seed + 5, { sideGround: -1, floorH: TH / 3 });
      // spire (pyramid, slate)
      const sy = y + TH, sh = 1.1, hs = TS / 2 + 0.02;
      const apex: V3 = [tx, sy + sh, tz];
      const cs: V3[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, bb]) => [tx + rx * a * hs + fx * bb * hs, sy, tz + rz * a * hs + fz * bb * hs]);
      W.use(WC.ROOF_SLATE, 0x4f7a6a, 1);
      if (parts) parts.push({ k: 'spire', a: [tx, sy, tz, hs, sh, fx, fz], c: 0x4f7a6a });
      for (let i = 0; i < 4; i++) {
        const p = cs[i], q = cs[(i + 1) % 4];
        const mx = (p[0] + q[0]) / 2 - tx, mz = (p[2] + q[2]) / 2 - tz;
        W.ttri(...p, 0, 0, ...q, Math.hypot(q[0] - p[0], q[2] - p[2]) / 0.3, 0, ...apex, 0.5 * Math.hypot(q[0] - p[0], q[2] - p[2]) / 0.3, sh / 0.3, mx, 0, mz);
      }
      Dt.use(WC.METAL, 0xd4b04a, 0);
      Dt.cylinder(tx, sy + sh, tz, 0.01, 0.16, 4);
      break;
    }
  }
}

function balconies(Dt: WB, cx: number, cz: number, fx: number, fz: number, Wd: number, D: number, y: number, floors: number, r: RNG, rail: number) {
  const rx = fz, rz = -fx;
  const bays = Math.max(1, Math.round(Wd / BAY));
  const pick: number[] = [];
  for (let k = 0; k < bays; k++) if ((bays >= 3 && (k === 0 || k === bays - 1)) || (bays < 3 && k === 0) || (k % 3 === 1 && r.chance(0.4))) pick.push(k);
  // slab (top, bottom, front edge) and a railing of double-sided panels: 18 triangles per balcony
  const hw = BAY * 0.45, f0 = D / 2, f1 = D / 2 + 0.12;
  for (let f = 1; f < floors; f++) {
    const yy = y + f * FLOOR_H, ys = yy - 0.012, yt = yy + 0.002, yr = yy + 0.08;
    for (const k of pick) {
      const a = -Wd / 2 + (k + 0.5) * (Wd / bays);
      const l0x = cx + rx * (a - hw) + fx * f0, l0z = cz + rz * (a - hw) + fz * f0;
      const r0x = cx + rx * (a + hw) + fx * f0, r0z = cz + rz * (a + hw) + fz * f0;
      const l1x = l0x + fx * (f1 - f0), l1z = l0z + fz * (f1 - f0), r1x = r0x + fx * (f1 - f0), r1z = r0z + fz * (f1 - f0);
      Dt.use(WC.CONCRETE, 0xc8c4bc, 0);
      Dt.ttri(l0x, yt, l0z, 0, 0, r0x, yt, r0z, 0, 0, r1x, yt, r1z, 0, 0, 0, 1, 0);
      Dt.ttri(l0x, yt, l0z, 0, 0, r1x, yt, r1z, 0, 0, l1x, yt, l1z, 0, 0, 0, 1, 0);
      Dt.ttri(l0x, ys, l0z, 0, 0, r0x, ys, r0z, 0, 0, r1x, ys, r1z, 0, 0, 0, -1, 0);
      Dt.ttri(l0x, ys, l0z, 0, 0, r1x, ys, r1z, 0, 0, l1x, ys, l1z, 0, 0, 0, -1, 0);
      Dt.twall(l1x, l1z, r1x, r1z, ys, yt, ys, yt, fx, fz);
      Dt.use(WC.METAL, rail, 0);
      Dt.twall(l1x, l1z, r1x, r1z, yt, yr, yt, yr, fx, fz);
      Dt.twall(l1x, l1z, r1x, r1z, yt, yr, yt, yr, -fx, -fz);
      Dt.twall(l0x, l0z, l1x, l1z, yt, yr, yt, yr, -rx, -rz);
      Dt.twall(l0x, l0z, l1x, l1z, yt, yr, yt, yr, rx, rz);
      Dt.twall(r0x, r0z, r1x, r1z, yt, yr, yt, yr, rx, rz);
      Dt.twall(r0x, r0z, r1x, r1z, yt, yr, yt, yr, -rx, -rz);
    }
  }
}

function rooftopUnits(Dt: WB, cx: number, y: number, cz: number, fx: number, fz: number, Wd: number, D: number, r: RNG, n: number) {
  const rx = fz, rz = -fx;
  for (let i = 0; i < n; i++) {
    const a = (r.next() - 0.5) * (Wd - 0.4), b = (r.next() - 0.5) * (D - 0.4);
    const x = cx + rx * a + fx * b, z = cz + rz * a + fz * b;
    const k = r.next();
    if (k < 0.55) { Dt.use(WC.METAL, 0xb0b4b6, 0); Dt.box(x, y, z, 0.12, 0.07, 0.09, fx, fz); }
    else if (k < 0.8) { Dt.use(WC.METAL, 0x8e9497, 0); Dt.cylinder(x, y, z, 0.006, 0.3, 4); Dt.box(x, y + 0.24, z, 0.08, 0.006, 0.006, fx, fz); }
    else { Dt.use(WC.METAL, 0x2d3a4a, 0); Dt.box(x, y + 0.03, z, 0.24, 0.012, 0.14, fx, fz); }
  }
}
