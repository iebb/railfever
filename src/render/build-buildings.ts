// Town buildings: facade-atlas walls on rotated rectangles, varied roofs and rooftop details.
import type { World, Building } from '../game/world';
import { RNG } from '../game/rng';
import { FLOOR_H, BT_HOUSE_S, BT_HOUSE_L, BT_TOWNHOUSE, BT_SHOP, BT_APARTMENT, BT_OFFICE, BT_TOWER, BT_CHURCH } from '../game/towns';
import { GeoBuilder } from './geo';
import { FC, ATLAS_CELLS } from './textures';

/** Width of one window bay on facades (units). */
export const BAY = 0.32;
export { FLOOR_H };

/** Builder for facade walls: uv in (bay, floor) units plus atlas cell and seed attributes. */
export class FacadeBuilder {
  gb = new GeoBuilder(true);

  private push(ax: number, az: number, bx: number, bz: number, ya: number, yb: number, u0: number, u1: number, v0: number, v1: number, cell: number, seed: number) {
    const gb = this.gb;
    gb.quad(ax, ya, az, bx, ya, bz, bx, yb, bz, ax, yb, az, [u0, v0, u1, v1]);
    const col = cell % ATLAS_CELLS, row = Math.floor(cell / ATLAS_CELLS);
    for (let i = 0; i < 4; i++) { gb.attr('aCell', 2, col, row); gb.attr('aSeed', 1, seed % 997); }
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
    if (!opts.skipFront) {
      if (opts.frontCell === undefined) this.wall(fl[0], fl[1], fr[0], fr[1], y, y + H, fx, fz, upper, ground, tint, seed, fh, opts.door ?? -1);
      else if (opts.frontCell >= 0) this.wall(fl[0], fl[1], fr[0], fr[1], y, y + H, fx, fz, opts.frontCell, -1, tint, seed, H);
    }
    this.wall(br[0], br[1], bl[0], bl[1], y, y + H, -fx, -fz, upper, sg, tint, seed + 1, fh);
    this.wall(fr[0], fr[1], br[0], br[1], y, y + H, rx, rz, upper, sg, tint, seed + 2, fh);
    this.wall(bl[0], bl[1], fl[0], fl[1], y, y + H, -rx, -rz, upper, sg, tint, seed + 3, fh);
  }
}

/** Gabled roof on a box; ridge runs along local z (forward) if `alongForward`. */
export function gableRoof(gb: GeoBuilder, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number, alongForward: boolean) {
  const rx = fz, rz = -fx;
  const [ax, az, bx, bz, hw, hl] = alongForward ? [rx, rz, fx, fz, w / 2, d / 2] : [fx, fz, rx, rz, d / 2, w / 2];
  const P = (a: number, b: number, yy: number): [number, number, number] => [cx + ax * a + bx * b, yy, cz + az * a + bz * b];
  gb.color(color);
  const s1 = [P(-hw, -hl, y), P(-hw, hl, y), P(0, hl, y + h), P(0, -hl, y + h)];
  const s2 = [P(hw, hl, y), P(hw, -hl, y), P(0, -hl, y + h), P(0, hl, y + h)];
  for (const s of [s1, s2]) {
    const n = (s[1][0] - s[0][0]) * (s[3][2] - s[0][2]) - (s[1][2] - s[0][2]) * (s[3][0] - s[0][0]);
    if (n < 0) gb.quad(...s[0], ...s[1], ...s[2], ...s[3]);
    else gb.quad(...s[3], ...s[2], ...s[1], ...s[0]);
  }
  // underside of the eaves
  gb.color(color, 0.6);
  for (const s of [s1, s2]) {
    const n = (s[1][0] - s[0][0]) * (s[3][2] - s[0][2]) - (s[1][2] - s[0][2]) * (s[3][0] - s[0][0]);
    if (n < 0) gb.quad(...s[3], ...s[2], ...s[1], ...s[0]);
    else gb.quad(...s[0], ...s[1], ...s[2], ...s[3]);
  }
}

/** Gable end walls (triangles) under a gabled roof. */
export function gableWalls(gb: GeoBuilder, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number, alongForward: boolean) {
  const rx = fz, rz = -fx;
  const [ax, az, bx, bz, hw, hl] = alongForward ? [rx, rz, fx, fz, w / 2, d / 2] : [fx, fz, rx, rz, d / 2, w / 2];
  const P = (a: number, b: number, yy: number): [number, number, number] => [cx + ax * a + bx * b, yy, cz + az * a + bz * b];
  gb.color(color);
  for (const sb of [-1, 1]) {
    const a = P(-hw, sb * hl, y), b = P(hw, sb * hl, y), c = P(0, sb * hl, y + h);
    const ox = bx * sb, oz = bz * sb;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    if (nx * ox + nz * oz > 0) gb.triangle(...a, ...b, ...c); else gb.triangle(...b, ...a, ...c);
  }
}

/** Hipped roof: four sloped faces, ridge along the longer side. */
export function hipRoof(gb: GeoBuilder, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number) {
  const rx = fz, rz = -fx;
  const P = (a: number, b: number, yy: number): [number, number, number] => [cx + rx * a + fx * b, yy, cz + rz * a + fz * b];
  const hw = w / 2, hd = d / 2;
  const alongZ = d >= w;
  const r = alongZ ? hd - hw : hw - hd; // half ridge length
  const r0 = alongZ ? P(0, -r, y + h) : P(-r, 0, y + h), r1 = alongZ ? P(0, r, y + h) : P(r, 0, y + h);
  const c = [P(-hw, -hd, y), P(hw, -hd, y), P(hw, hd, y), P(-hw, hd, y)];
  gb.color(color);
  const up = (a: [number, number, number], b: [number, number, number], cc: [number, number, number]) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = cc[0] - a[0], vy = cc[1] - a[1], vz = cc[2] - a[2];
    if (uz * vx - ux * vz >= 0) gb.triangle(...a, ...b, ...cc); else gb.triangle(...a, ...cc, ...b);
    void uy; void vy;
  };
  if (alongZ) {
    up(c[0], c[1], r0); up(c[2], c[3], r1);
    up(c[1], c[2], r1); up(c[1], r1, r0);
    up(c[3], c[0], r0); up(c[3], r0, r1);
  } else {
    up(c[1], c[2], r1); up(c[3], c[0], r0);
    up(c[0], c[1], r1); up(c[0], r1, r0);
    up(c[2], c[3], r0); up(c[2], r0, r1);
  }
}

/** Flat roof with a low parapet. */
export function flatRoof(matte: GeoBuilder, cx: number, y: number, cz: number, W: number, D: number, fx: number, fz: number, color = 0x77797c) {
  matte.color(color);
  matte.box(cx, y, cz, W, 0.02, D, fx, fz);
  matte.color(color, 1.18);
  const rx = fz, rz = -fx;
  const t = 0.04, ph = 0.07;
  matte.box(cx + fx * (D / 2 - t / 2), y, cz + fz * (D / 2 - t / 2), W, ph, t, fx, fz);
  matte.box(cx - fx * (D / 2 - t / 2), y, cz - fz * (D / 2 - t / 2), W, ph, t, fx, fz);
  matte.box(cx + rx * (W / 2 - t / 2), y, cz + rz * (W / 2 - t / 2), t, ph, D - 2 * t, fx, fz);
  matte.box(cx - rx * (W / 2 - t / 2), y, cz - rz * (W / 2 - t / 2), t, ph, D - 2 * t, fx, fz);
}

const PASTELS = [0xf3e9d2, 0xf0dcc0, 0xe2ebf0, 0xf2e0dc, 0xe5eed6, 0xffffff, 0xeedfb8, 0xf5e6c8, 0xdfe6ea];
const ROOFS = [0x9c4a32, 0xa65a3c, 0x4b5258, 0x6b4a36, 0x7d3b2c, 0x5a6066, 0x8a4b33];
const AWNINGS = [0xb83b3b, 0x2f6e9e, 0x3c8c4e, 0xd09a2a, 0x6b4a8a];

/** Lowest terrain height under a rectangle (corners + centre). */
export function lowestUnder(w: World, x: number, z: number, angle: number, W: number, D: number): number {
  const fx = Math.sin(angle), fz = Math.cos(angle), rx = fz, rz = -fx;
  let lo = w.heightAt(x, z);
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) lo = Math.min(lo, w.heightAt(x + rx * a * W / 2 + fx * b * D / 2, z + rz * a * W / 2 + fz * b * D / 2));
  return lo;
}

export function buildBuilding(w: World, b: Building, matte: GeoBuilder, metal: GeoBuilder, fac: FacadeBuilder) {
  const r = new RNG(b.seed);
  const fx = Math.sin(b.angle), fz = Math.cos(b.angle);
  const rx = fz, rz = -fx;
  const base = b.y;
  const lo = lowestUnder(w, b.x, b.z, b.angle, b.w, b.d) - 0.06;
  const seed = b.seed;
  const cx = b.x, cz = b.z;
  // plinth down to the lowest terrain
  matte.color(0x8d877c);
  matte.box(cx, lo, cz, b.w + 0.03, base + 0.04 - lo, b.d + 0.03, fx, fz);
  const y = base + 0.04;
  const W = b.w, D = b.d;
  switch (b.type) {
    case BT_HOUSE_S:
    case BT_HOUSE_L: {
      const H = b.floors * FLOOR_H;
      const sty = r.next();
      const [up, gr] = sty < 0.4 ? [FC.HOUSE, FC.HOUSE_DOOR] : sty < 0.7 ? [FC.WOOD, FC.WOOD_DOOR] : [FC.BRICK, FC.BRICK_DOOR];
      const tint = up === FC.BRICK ? 0xffffff : r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, up, -1, tint, seed, { door: gr });
      const roofC = r.pick(ROOFS);
      const wallTint = up === FC.BRICK ? 0xa95f45 : tint;
      if (r.chance(0.4)) {
        const rh = Math.min(W, D) * (0.32 + r.next() * 0.12);
        hipRoof(matte, cx, y + H, cz, W + 0.1, D + 0.1, rh, fx, fz, roofC);
      } else {
        const along = r.chance(0.3);
        const span = along ? W : D;
        const rh = span * (0.32 + r.next() * 0.16);
        gableWalls(matte, cx, y + H, cz, W, D, rh, fx, fz, wallTint, along);
        gableRoof(matte, cx, y + H - 0.01, cz, W + 0.1, D + 0.1, rh + 0.02, fx, fz, roofC, along);
      }
      matte.color(0x7a4a3a);
      matte.box(cx + rx * W * 0.25 - fx * D * 0.15, y + H, cz + rz * W * 0.25 - fz * D * 0.15, 0.08, Math.min(W, D) * 0.45, 0.08, fx, fz);
      break;
    }
    case BT_TOWNHOUSE: {
      const H = b.floors * FLOOR_H;
      const brick = r.chance(0.5);
      const tint = brick ? 0xffffff : r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, brick ? FC.BRICK : FC.TOWNHOUSE, -1, tint, seed, { door: brick ? FC.BRICK_DOOR : FC.TOWN_DOOR });
      const rh = D * (0.28 + r.next() * 0.1);
      gableWalls(matte, cx, y + H, cz, W, D, rh, fx, fz, brick ? 0xa95f45 : tint, false);
      gableRoof(matte, cx, y + H - 0.01, cz, W + 0.04, D + 0.1, rh + 0.02, fx, fz, r.pick(ROOFS), false);
      matte.color(0x6e5a4a);
      for (const k of [-0.32, 0.32]) matte.box(cx + rx * W * k, y + H + rh * 0.4, cz + rz * W * k, 0.07, rh * 0.75, 0.1, fx, fz);
      break;
    }
    case BT_SHOP: {
      const H = Math.max(1, b.floors) * FLOOR_H + 0.05;
      const g2 = r.chance(0.5);
      const up = g2 ? FC.BRICK : FC.APART;
      const tint = g2 ? 0xffffff : r.pick(PASTELS);
      if (b.floors <= 1) fac.boxWalls(cx, y, cz, W, D, H, fx, fz, g2 ? FC.SHOP2 : FC.SHOP, g2 ? FC.SHOP2 : FC.SHOP, tint, seed, { sideGround: -1, floorH: H });
      else fac.boxWalls(cx, y, cz, W, D, H, fx, fz, up, g2 ? FC.SHOP2 : FC.SHOP, tint, seed);
      flatRoof(matte, cx, y + H, cz, W, D, fx, fz);
      matte.color(r.pick(AWNINGS));
      const ax = cx + fx * (D / 2 + 0.1), az = cz + fz * (D / 2 + 0.1);
      matte.box(ax, y + 0.24, az, W * 0.92, 0.03, 0.2, fx, fz, false);
      break;
    }
    case BT_APARTMENT: {
      const H = b.floors * FLOOR_H;
      const panel = r.chance(0.45);
      const tint = r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, panel ? FC.PANEL : FC.APART, -1, tint, seed, { door: FC.APART_DOOR });
      if (r.chance(0.3)) {
        hipRoof(matte, cx, y + H, cz, W + 0.08, D + 0.08, Math.min(W, D) * 0.22, fx, fz, r.pick(ROOFS));
      } else {
        flatRoof(matte, cx, y + H, cz, W, D, fx, fz);
        matte.color(0x8a8c90);
        matte.box(cx - fx * D * 0.15 + rx * W * 0.2, y + H, cz - fz * D * 0.15 + rz * W * 0.2, 0.36, 0.22, 0.3, fx, fz);
        metal.color(0x9aa0a4);
        metal.box(cx + fx * D * 0.2 - rx * W * 0.25, y + H, cz + fz * D * 0.2 - rz * W * 0.25, 0.14, 0.08, 0.1, fx, fz);
      }
      break;
    }
    case BT_OFFICE: {
      const H = b.floors * FLOOR_H + 0.05;
      const glass = r.chance(0.55);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, glass ? FC.GLASS : FC.STONE, FC.LOBBY, glass ? 0xffffff : 0xf4efe6, seed, { sideGround: glass ? FC.GLASS : FC.STONE });
      flatRoof(matte, cx, y + H, cz, W, D, fx, fz, 0x6c6e72);
      matte.color(0x9b9da1);
      matte.box(cx, y + H, cz, W * 0.45, 0.25, D * 0.4, fx, fz);
      break;
    }
    case BT_TOWER: {
      const topFloors = Math.min(4, Math.max(2, Math.floor(b.floors / 5)));
      const H1 = (b.floors - topFloors) * FLOOR_H;
      const H2 = topFloors * FLOOR_H;
      const cell = r.chance(0.5) ? FC.TOWER : FC.GLASS;
      fac.boxWalls(cx, y, cz, W, D, H1, fx, fz, cell, FC.LOBBY, 0xffffff, seed, { sideGround: cell });
      flatRoof(matte, cx, y + H1, cz, W, D, fx, fz, 0x5d6064);
      fac.boxWalls(cx, y + H1, cz, W * 0.72, D * 0.72, H2, fx, fz, cell, -1, 0xffffff, seed + 7);
      flatRoof(matte, cx, y + H1 + H2, cz, W * 0.72, D * 0.72, fx, fz, 0x5d6064);
      metal.color(0xb8bcc0);
      metal.cylinder(cx, y + H1 + H2, cz, 0.02, 1.2, 5);
      break;
    }
    case BT_CHURCH: {
      const NW = Math.min(W * 0.62, 1.0), ND = D * 0.72, H = 0.75;
      const ncx = cx - fx * (D - ND) / 2, ncz = cz - fz * (D - ND) / 2;
      fac.boxWalls(ncx, y, ncz, NW, ND, H, fx, fz, FC.CHURCH, FC.CHURCH, 0xffffff, seed, { sideGround: -1, frontCell: FC.CHURCH_DOOR, floorH: H });
      gableWalls(matte, ncx, y + H, ncz, NW, ND, 0.55, fx, fz, 0xc9bfa8, true);
      gableRoof(matte, ncx, y + H - 0.01, ncz, NW + 0.1, ND + 0.06, 0.6, fx, fz, 0x4b5258, true);
      // tower at the front with a spire
      const TS = Math.min(0.55, NW * 0.6);
      const tx = cx + fx * (D / 2 - TS / 2), tz = cz + fz * (D / 2 - TS / 2);
      const TH = 1.9;
      fac.boxWalls(tx, y, tz, TS, TS, TH, fx, fz, FC.CHURCH, FC.CHURCH_DOOR, 0xffffff, seed + 5, { sideGround: -1, floorH: TH / 3 });
      matte.color(0x3f6b5c);
      const sy = y + TH, sh = 1.1, hs = TS / 2 + 0.02;
      const apex: [number, number, number] = [tx, sy + sh, tz];
      const cs: [number, number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, bb]) => [tx + rx * a * hs + fx * bb * hs, sy, tz + rz * a * hs + fz * bb * hs]);
      for (let i = 0; i < 4; i++) {
        const p = cs[i], q = cs[(i + 1) % 4];
        const ux = q[0] - p[0], uz = q[2] - p[2], vx = apex[0] - p[0], vz = apex[2] - p[2];
        const ny = uz * vx - ux * vz;
        void ny;
        // outward-facing: check against the direction from the tower centre
        const mx = (p[0] + q[0]) / 2 - tx, mz = (p[2] + q[2]) / 2 - tz;
        const uy = 0, vy = apex[1] - p[1];
        const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
        if (nx * mx + nz * mz > 0) matte.triangle(...p, ...q, ...apex); else matte.triangle(...q, ...p, ...apex);
      }
      metal.color(0xd4b04a);
      metal.cylinder(tx, sy + sh, tz, 0.01, 0.16, 4);
      break;
    }
  }
}
