// Building geometry: facades with atlas cells, roofs and details.
import { World, Building } from '../game/world';
import { GeoBuilder } from './geo';
import { DX, DZ, HSTEP } from '../game/constants';
import { RNG } from '../game/rng';
import { FC, ATLAS_CELLS } from './textures';
import {
  BT_HOUSE_S, BT_HOUSE_L, BT_TOWNHOUSE, BT_SHOP, BT_APARTMENT, BT_OFFICE, BT_TOWER, BT_CHURCH,
} from '../game/towns';

const BAY = 0.13;
export const FLOOR_H = 0.105;

/** Builder for facade walls: uv in (bay, floor) units plus atlas cell and seed attributes. */
export class FacadeBuilder {
  gb = new GeoBuilder(true);

  /** Wall between bottom points A and B, facing outward (nx,nz). */
  wall(ax: number, az: number, bx: number, bz: number, y0: number, y1: number, nx: number, nz: number,
    upper: number, ground: number, tint: number, seed: number, floorH = FLOOR_H) {
    const ux = bx - ax, uz = bz - az;
    if (-uz * nx + ux * nz < 0) { [ax, bx] = [bx, ax]; [az, bz] = [bz, az]; }
    const len = Math.hypot(bx - ax, bz - az);
    const bays = Math.max(1, Math.round(len / BAY));
    const H = y1 - y0;
    const floors = Math.max(1, Math.round(H / floorH));
    const gb = this.gb;
    gb.color(tint);
    const push = (ya: number, yb: number, v0: number, v1: number, cell: number) => {
      gb.quad(ax, ya, az, bx, ya, bz, bx, yb, bz, ax, yb, az, [0, v0, bays, v1]);
      const col = cell % ATLAS_CELLS, row = Math.floor(cell / ATLAS_CELLS);
      for (let i = 0; i < 4; i++) { gb.attr('aCell', 2, col, row); gb.attr('aSeed', 1, seed % 997); }
    };
    if (ground >= 0 && floors >= 1) {
      const gh = H / floors;
      push(y0, y0 + gh, 0, 1, ground);
      if (floors > 1) push(y0 + gh, y1, 1, floors, upper);
    } else push(y0, y1, 0, floors, upper);
  }

  /** Four walls of an oriented box; front faces (fx,fz). */
  boxWalls(cx: number, y: number, cz: number, W: number, D: number, H: number, fx: number, fz: number,
    upper: number, ground: number, tint: number, seed: number, opts: { frontCell?: number; sideGround?: number } = {}) {
    const rx = fz, rz = -fx;
    const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
    const hw = W / 2, hd = D / 2;
    const fl = P(-hw, hd), fr = P(hw, hd), bl = P(-hw, -hd), br = P(hw, -hd);
    const sg = opts.sideGround ?? -1;
    if (opts.frontCell === undefined) this.wall(fl[0], fl[1], fr[0], fr[1], y, y + H, fx, fz, upper, ground, tint, seed);
    else if (opts.frontCell >= 0) this.wall(fl[0], fl[1], fr[0], fr[1], y, y + H, fx, fz, opts.frontCell, -1, tint, seed, H);
    this.wall(br[0], br[1], bl[0], bl[1], y, y + H, -fx, -fz, upper, sg, tint, seed + 1);
    this.wall(fr[0], fr[1], br[0], br[1], y, y + H, rx, rz, upper, sg, tint, seed + 2);
    this.wall(bl[0], bl[1], fl[0], fl[1], y, y + H, -rx, -rz, upper, sg, tint, seed + 3);
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
  gb.color(color, 0.8);
  for (const sb of [-1, 1]) {
    const a = P(-hw, sb * hl, y), b = P(hw, sb * hl, y), c = P(0, sb * hl, y + h);
    const ox = bx * sb, oz = bz * sb;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, nz = ux * vy - uy * vx;
    if (nx * ox + nz * oz > 0) gb.triangle(...a, ...b, ...c); else gb.triangle(...b, ...a, ...c);
  }
}

/** Gable end walls (triangles) in wall colour under a gabled roof. */
function gableWalls(gb: GeoBuilder, cx: number, y: number, cz: number, w: number, d: number, h: number, fx: number, fz: number, color: number, alongForward: boolean) {
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

function flatRoof(matte: GeoBuilder, cx: number, y: number, cz: number, W: number, D: number, fx: number, fz: number, color = 0x77797c) {
  matte.color(color);
  matte.box(cx, y, cz, W, 0.012, D, fx, fz);
  matte.color(color, 1.15);
  const rx = fz, rz = -fx;
  const t = 0.018, ph = 0.03;
  matte.box(cx + fx * (D / 2 - t / 2), y, cz + fz * (D / 2 - t / 2), W, ph, t, fx, fz);
  matte.box(cx - fx * (D / 2 - t / 2), y, cz - fz * (D / 2 - t / 2), W, ph, t, fx, fz);
  matte.box(cx + rx * (W / 2 - t / 2), y, cz + rz * (W / 2 - t / 2), t, ph, D, fx, fz);
  matte.box(cx - rx * (W / 2 - t / 2), y, cz - rz * (W / 2 - t / 2), t, ph, D, fx, fz);
}

const PASTELS = [0xf3e9d2, 0xf0dcc0, 0xe2ebf0, 0xf2e0dc, 0xe5eed6, 0xffffff, 0xeedfb8, 0xf5e6c8, 0xdfe6ea];
const ROOFS = [0x9c4a32, 0xa65a3c, 0x4b5258, 0x6b4a36, 0x7d3b2c, 0x5a6066];
const AWNINGS = [0xb83b3b, 0x2f6e9e, 0x3c8c4e, 0xd09a2a, 0x6b4a8a];

export function buildBuilding(w: World, b: Building, matte: GeoBuilder, metal: GeoBuilder, fac: FacadeBuilder) {
  const r = new RNG(b.seed);
  const base = w.tileMax(b.x, b.z) * HSTEP;
  const lo = w.tileMin(b.x, b.z) * HSTEP;
  const fx = DX[b.face], fz = DZ[b.face];
  const rx = fz, rz = -fx;
  let cx = b.x + 0.5, cz = b.z + 0.5;
  const seed = b.seed;
  const urban = b.type >= BT_SHOP && b.type !== BT_CHURCH;
  if (base > lo + 0.001) {
    matte.color(0x8d877c);
    matte.aabb(b.x + 0.04, lo - 0.02, b.z + 0.04, b.x + 0.96, base + 0.005, b.z + 0.96);
  }
  if (urban) {
    matte.color(0xa29f97);
    matte.aabb(b.x + 0.02, base, b.z + 0.02, b.x + 0.98, base + 0.012, b.z + 0.98);
  }
  const y = base + (urban ? 0.012 : 0);
  switch (b.type) {
    case BT_HOUSE_S:
    case BT_HOUSE_L: {
      const large = b.type === BT_HOUSE_L;
      const W = large ? 0.5 + r.next() * 0.1 : 0.4 + r.next() * 0.12;
      const D = large ? 0.42 + r.next() * 0.1 : 0.34 + r.next() * 0.1;
      cx += fx * 0.06; cz += fz * 0.06;
      const H = b.floors * 0.11;
      const sty = r.next();
      const [up, gr] = sty < 0.4 ? [FC.HOUSE, FC.HOUSE_DOOR] : sty < 0.7 ? [FC.WOOD, FC.WOOD_DOOR] : [FC.BRICK, FC.BRICK_DOOR];
      const tint = up === FC.BRICK ? 0xffffff : r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, up, gr, tint, seed);
      const rh = 0.11 + r.next() * 0.07;
      const along = r.chance(0.3);
      const wallTint = up === FC.BRICK ? 0xa95f45 : tint;
      gableWalls(matte, cx, y + H, cz, W, D, rh, fx, fz, wallTint, along);
      gableRoof(matte, cx, y + H - 0.005, cz, W + 0.06, D + 0.07, rh + 0.02, fx, fz, r.pick(ROOFS), along);
      // chimney
      matte.color(0x7a4a3a);
      matte.box(cx + rx * W * 0.25 - fx * D * 0.15, y + H + rh * 0.4, cz + rz * W * 0.25 - fz * D * 0.15, 0.04, rh * 0.75, 0.04, fx, fz);
      // garden path to the road
      matte.color(0xc4bcae);
      const px = cx + fx * (D / 2 + 0.12), pz = cz + fz * (D / 2 + 0.12);
      matte.box(px, base + 0.002, pz, 0.06, 0.008, 0.24, fx, fz);
      // hedge / fence
      if (r.chance(0.6)) {
        matte.color(0x3f5f2a);
        const ex = b.x + 0.5 + fx * 0.43, ez = b.z + 0.5 + fz * 0.43;
        matte.box(ex + rx * 0.27, base, ez + rz * 0.27, 0.4, 0.045, 0.05, fx, fz);
        matte.box(ex - rx * 0.27, base, ez - rz * 0.27, 0.4, 0.045, 0.05, fx, fz);
      }
      break;
    }
    case BT_TOWNHOUSE: {
      const W = 0.68 + r.next() * 0.12, D = 0.5 + r.next() * 0.1;
      cx += fx * 0.12; cz += fz * 0.12;
      const H = b.floors * FLOOR_H;
      const brick = r.chance(0.5);
      const tint = brick ? 0xffffff : r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, brick ? FC.BRICK : FC.TOWNHOUSE, brick ? FC.BRICK_DOOR : FC.TOWN_DOOR, tint, seed);
      const rh = 0.14 + r.next() * 0.06;
      gableWalls(matte, cx, y + H, cz, W, D, rh, fx, fz, brick ? 0xa95f45 : tint, false);
      gableRoof(matte, cx, y + H - 0.005, cz, W + 0.04, D + 0.06, rh + 0.02, fx, fz, r.pick(ROOFS), false);
      matte.color(0x6e5a4a);
      for (const k of [-0.3, 0.3]) matte.box(cx + rx * W * k, y + H + rh * 0.5, cz + rz * W * k, 0.035, rh * 0.75, 0.05, fx, fz);
      break;
    }
    case BT_SHOP: {
      const W = 0.72 + r.next() * 0.1, D = 0.6 + r.next() * 0.12;
      cx += fx * 0.1; cz += fz * 0.1;
      const H = Math.max(1, b.floors) * FLOOR_H + 0.02;
      const g2 = r.chance(0.5);
      const up = g2 ? FC.BRICK : FC.APART;
      const tint = g2 ? 0xffffff : r.pick(PASTELS);
      if (b.floors <= 1) fac.boxWalls(cx, y, cz, W, D, H, fx, fz, g2 ? FC.SHOP2 : FC.SHOP, g2 ? FC.SHOP2 : FC.SHOP, tint, seed, { sideGround: -1 });
      else fac.boxWalls(cx, y, cz, W, D, H, fx, fz, up, g2 ? FC.SHOP2 : FC.SHOP, tint, seed);
      flatRoof(matte, cx, y + H, cz, W, D, fx, fz);
      // awning
      matte.color(r.pick(AWNINGS));
      const ax = cx + fx * (D / 2 + 0.04), az = cz + fz * (D / 2 + 0.04);
      matte.box(ax, y + 0.085, az, W * 0.92, 0.016, 0.09, fx, fz);
      break;
    }
    case BT_APARTMENT: {
      const W = 0.72 + r.next() * 0.12, D = 0.68 + r.next() * 0.12;
      const H = b.floors * FLOOR_H;
      const panel = r.chance(0.45);
      const tint = r.pick(PASTELS);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, panel ? FC.PANEL : FC.APART, FC.APART_DOOR, tint, seed, { sideGround: panel ? FC.PANEL : FC.APART });
      flatRoof(matte, cx, y + H, cz, W, D, fx, fz);
      matte.color(0x8a8c90);
      matte.box(cx - fx * 0.1 + rx * 0.12, y + H, cz - fz * 0.1 + rz * 0.12, 0.16, 0.06, 0.12, fx, fz);
      if (r.chance(0.5)) { matte.color(0x6a5040); metal.cylinder(cx + rx * -0.2, y + H, cz + rz * -0.2, 0.05, 0.09, 8); }
      break;
    }
    case BT_OFFICE: {
      const W = 0.74 + r.next() * 0.12, D = 0.72 + r.next() * 0.12;
      const H = b.floors * FLOOR_H + 0.02;
      const glass = r.chance(0.55);
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, glass ? FC.GLASS : FC.STONE, FC.LOBBY, glass ? 0xffffff : 0xf4efe6, seed, { sideGround: glass ? FC.GLASS : FC.STONE });
      flatRoof(matte, cx, y + H, cz, W, D, fx, fz, 0x6c6e72);
      matte.color(0x9b9da1);
      matte.box(cx, y + H, cz, W * 0.45, 0.08, D * 0.4, fx, fz);
      break;
    }
    case BT_TOWER: {
      const W = 0.76 + r.next() * 0.08, D = 0.74 + r.next() * 0.1;
      const topFloors = 3;
      const H1 = (b.floors - topFloors) * FLOOR_H;
      const H2 = topFloors * FLOOR_H;
      const cell = r.chance(0.5) ? FC.TOWER : FC.GLASS;
      fac.boxWalls(cx, y, cz, W, D, H1, fx, fz, cell, FC.LOBBY, 0xffffff, seed, { sideGround: cell });
      flatRoof(matte, cx, y + H1, cz, W, D, fx, fz, 0x5d6064);
      fac.boxWalls(cx, y + H1, cz, W * 0.72, D * 0.72, H2, fx, fz, cell, -1, 0xffffff, seed + 7);
      flatRoof(matte, cx, y + H1 + H2, cz, W * 0.72, D * 0.72, fx, fz, 0x5d6064);
      metal.color(0xb8bcc0);
      metal.cylinder(cx, y + H1 + H2, cz, 0.008, 0.28, 5);
      break;
    }
    case BT_CHURCH: {
      const W = 0.34, D = 0.66, H = 0.24;
      cx -= fx * 0.04; cz -= fz * 0.04;
      fac.boxWalls(cx, y, cz, W, D, H, fx, fz, FC.CHURCH, FC.CHURCH, 0xffffff, seed, { sideGround: -1, frontCell: FC.CHURCH_DOOR });
      gableWalls(matte, cx, y + H, cz, W, D, 0.16, fx, fz, 0xc9bfa8, true);
      gableRoof(matte, cx, y + H - 0.005, cz, W + 0.05, D + 0.04, 0.18, fx, fz, 0x4b5258, true);
      // tower at the front
      const tx = cx + fx * (D / 2 + 0.08), tz = cz + fz * (D / 2 + 0.08);
      const TH = 0.5;
      fac.boxWalls(tx, y, tz, 0.18, 0.18, TH, fx, fz, FC.CHURCH, FC.CHURCH_DOOR, 0xffffff, seed + 5, { sideGround: -1 });
      // spire (pyramid)
      matte.color(0x3f6b5c);
      const sy = y + TH, sh = 0.32, hs = 0.11;
      const apex: [number, number, number] = [tx, sy + sh, tz];
      const cs: [number, number, number][] = [
        [tx - hs, sy, tz - hs], [tx + hs, sy, tz - hs], [tx + hs, sy, tz + hs], [tx - hs, sy, tz + hs],
      ];
      for (let i = 0; i < 4; i++) matte.triangle(...cs[(i + 1) % 4], ...cs[i], ...apex);
      metal.color(0xd4b04a);
      metal.cylinder(tx, sy + sh, tz, 0.004, 0.05, 4);
      break;
    }
  }
}
