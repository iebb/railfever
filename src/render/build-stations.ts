// Rail stations (platforms with ramps, canopies, signage, station building, footbridge) and depots.
import type { Station } from '../game/stations';
import { stationLayout } from '../game/stations';
import type { Depot } from '../game/build-ops';
import { depotSize } from '../game/build-ops';
import { ChunkCtx, Smp } from './build-common';
import { WB } from './build-mesh';
import { gableWalls, roofGable, roofHip, roofFlat, lowestUnder, boardText } from './build-buildings';
import { FC, WC, WSCALE } from './textures';
import { RAIL_TOP_Y } from './build-rail';
import { lampPost } from './build-road';

/** Platform top above the station's track profile. */
export const PLATFORM_Y = RAIL_TOP_Y + 0.08;

/** Inward-facing dark room (seen through door openings). Frame: centre, forward f (towards the opening), size. */
function darkRoom(m: WB, cx: number, cz: number, fx: number, fz: number, w: number, d: number, y0: number, y1: number) {
  const rx = fz, rz = -fx;
  const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
  const bl = P(-w / 2, -d / 2), br = P(w / 2, -d / 2), fl = P(-w / 2, d / 2), fr = P(w / 2, d / 2);
  m.use(WC.PLAIN, 0x0b0c0d, 0);
  m.twall(bl[0], bl[1], fl[0], fl[1], y0, y1, y0, y1, rx, rz);
  m.twall(br[0], br[1], fr[0], fr[1], y0, y1, y0, y1, -rx, -rz);
  m.twall(bl[0], bl[1], br[0], br[1], y0, y1, y0, y1, fx, fz);
  m.ttri(bl[0], y1, bl[1], 0, 0, br[0], y1, br[1], 0, 0, fr[0], y1, fr[1], 0, 0, 0, -1, 0);
  m.ttri(bl[0], y1, bl[1], 0, 0, fr[0], y1, fr[1], 0, 0, fl[0], y1, fl[1], 0, 0, 0, -1, 0);
}

/** Platform slab with sloped ends: top surface (platform paving), sides (concrete). */
function platform(W: WB, cx: number, cz: number, fx: number, fz: number, w: number, L: number, y0: number, y1: number) {
  const rx = fz, rz = -fx;
  const R = Math.min(0.4, L * 0.1); // ramp length
  const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
  const hw = w / 2, hl = L / 2;
  // profile along the platform: (along, height)
  const prof: [number, number][] = [[-hl, y0 + 0.012], [-hl + R, y1], [hl - R, y1], [hl, y0 + 0.012]];
  const sc = WSCALE.PLATFORM;
  W.use(WC.PLATFORM, 0xd2cec6, 0);
  for (let k = 0; k < 3; k++) {
    const [a0, h0] = prof[k], [a1, h1] = prof[k + 1];
    const p0 = P(-hw, a0), p1 = P(hw, a0), p2 = P(hw, a1), p3 = P(-hw, a1);
    W.ttri(p0[0], h0, p0[1], -hw / sc, a0 / sc, p1[0], h0, p1[1], hw / sc, a0 / sc, p2[0], h1, p2[1], hw / sc, a1 / sc, 0, 1, 0);
    W.ttri(p0[0], h0, p0[1], -hw / sc, a0 / sc, p2[0], h1, p2[1], hw / sc, a1 / sc, p3[0], h1, p3[1], -hw / sc, a1 / sc, 0, 1, 0);
  }
  W.use(WC.CONCRETE, 0xbdb8ae, 0);
  for (const s of [-1, 1]) {
    for (let k = 0; k < 3; k++) {
      const [a0, h0] = prof[k], [a1, h1] = prof[k + 1];
      const p = P(s * hw, a0), q = P(s * hw, a1);
      W.twall(p[0], p[1], q[0], q[1], y0 - 0.1, h0, y0 - 0.1, h1, rx * s, rz * s, WSCALE.CONCRETE, a0);
    }
  }
}

export function buildStation(ctx: ChunkCtx, st: Station, color: number) {
  const r = st.rail;
  if (!r) return;
  const w = ctx.game.world;
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
  const rx = fz, rz = -fx; // lateral axis used by trackOffsets / platforms
  const y = r.y;
  const L = r.length;
  const at = (off: number, along: number): [number, number] => [r.x + rx * off + fx * along, r.z + rz * off + fz * along];
  const PY = y + PLATFORM_Y;
  const PL = L - 0.1;
  for (const p of r.platforms) {
    const [cx, cz] = at(p.off, 0);
    platform(W, cx, cz, fx, fz, p.w, PL, y - 0.1, PY);
    // white coping and yellow safety lines along both edges (thin raised strips on the flat part)
    for (const s of [-1, 1]) {
      const [ex, ez] = at(p.off + s * (p.w / 2 - 0.02), 0);
      W.use(WC.PLAIN, 0xeceae4, 0);
      W.box(ex, PY, ez, 0.04, 0.003, PL - 0.8, fx, fz);
      const [yx, yz] = at(p.off + s * (p.w / 2 - 0.075), 0);
      W.use(WC.PLAIN, 0xe8c230, 0);
      W.box(yx, PY, yz, 0.012, 0.003, PL - 0.8, fx, fz);
    }
    // canopy over the middle part: columns, slab roof with a company colour fascia
    const CL = L * 0.55;
    const cols = Math.max(2, Math.round(CL / 1.1));
    for (let k = 0; k < cols; k++) {
      const a = -CL / 2 + (CL * (k + 0.5)) / cols;
      const [px, pz] = at(p.off, a);
      D.use(WC.METAL, 0x5c666e);
      D.box(px, PY, pz, 0.03, 0.36, 0.03, fx, fz);
      // lamp under the canopy
      D.use(WC.LAMP, 0xfff1c8);
      D.box(px, PY + 0.33, pz, 0.12, 0.012, 0.03, fx, fz, true);
      ctx.lights.push(px, PY + 0.31, pz);
      if (k < cols - 1) {
        const [bx, bz] = at(p.off, a + CL / cols / 2);
        D.use(WC.PLAIN, 0x6d533a);
        D.box(bx, PY + 0.04, bz, 0.06, 0.012, 0.22, fx, fz, false);
        D.use(WC.METAL, 0x40464b);
        D.box(bx, PY, bz, 0.05, 0.04, 0.2, fx, fz);
      }
    }
    const [kx, kz] = at(p.off, 0);
    W.use(WC.ROOF_FLAT, 0x9aa3a8, 1);
    W.tbox(kx, PY + 0.36, kz, p.w - 0.02, 0.03, CL + 0.1, fx, fz, WSCALE.ROOF_FLAT, true);
    W.use(WC.PLAIN, color, 1);
    for (const s of [-1, 1]) {
      const [ex, ez] = at(p.off + s * (p.w / 2 - 0.01), 0);
      W.box(ex, PY + 0.35, ez, 0.02, 0.05, CL + 0.1, fx, fz, false);
    }
    // name boards (company colour) on the open platform parts, lamps
    for (const a of [-L * 0.36, L * 0.36]) {
      const [lx, lz] = at(p.off, a);
      lampPost(ctx, lx, PY, lz, fx, fz, 0.42, 0.0);
      const [sx, sz] = at(p.off, a * 0.8);
      D.use(WC.METAL, 0x50565b);
      for (const o of [-0.09, 0.09]) { const [qx, qz] = [sx + fx * o, sz + fz * o]; D.cylinder(qx, PY, qz, 0.006, 0.26, 4); }
      boardText(D, sx, PY + 0.2, sz, rx, rz, 0.24, 0.06, color);
      boardText(D, sx, PY + 0.2, sz, -rx, -rz, 0.24, 0.06, color);
    }
  }
  // station building beside the tracks (long side along the tracks, entrance facing away)
  const b = r.building;
  const bfx = Math.sin(b.angle), bfz = Math.cos(b.angle), brx = bfz, brz = -bfx;
  const extAlong = Math.abs(brx * fx + brz * fz) * b.w + Math.abs(bfx * fx + bfz * fz) * b.d;
  const extAcross = Math.abs(brx * rx + brz * rz) * b.w + Math.abs(bfx * rx + bfz * rz) * b.d;
  const BL = Math.max(extAlong, extAcross), BD = Math.max(0.9, Math.min(extAlong, extAcross));
  const sideSign = ((b.x - r.x) * rx + (b.z - r.z) * rz) >= 0 ? 1 : -1;
  const width = stationLayout(r.tracks).width;
  const along = (b.x - r.x) * fx + (b.z - r.z) * fz;
  const [bx, bz] = at(sideSign * (width / 2 + BD / 2 + 0.15), along);
  const ex = rx * sideSign, ez = rz * sideSign; // entrance faces away from the tracks
  const floors = r.tracks >= 3 ? 3 : 2;
  const H = floors * 0.33;
  const base = y + 0.02;
  const lo = lowestUnder(w, bx, bz, Math.atan2(ex, ez), BL, BD) - 0.06;
  W.use(WC.STONE, 0xb4aa98, 1);
  W.tbox(bx, lo, bz, BL + 0.04, base - lo, BD + 0.04, ex, ez, WSCALE.STONE);
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.STATION, -1, 0xffffff, st.id * 7 + 3, { door: FC.TOWN_DOOR, floorH: 0.33 });
  roofHip(W, bx, base + H, bz, BL + 0.12, BD + 0.12, Math.min(BL, BD) * 0.35, ex, ez, 0x5a6066, WC.ROOF_SLATE);
  W.use(WC.PLAIN, color, 1);
  W.box(bx, base + H - 0.06, bz, BL + 0.025, 0.06, BD + 0.025, ex, ez);
  W.box(bx + ex * (BD / 2 + 0.12), base + 0.3, bz + ez * (BD / 2 + 0.12), 0.6, 0.025, 0.24, ex, ez, false);
  // name board over the entrance
  boardText(D, bx + ex * (BD / 2 + 0.012), base + H - 0.17, bz + ez * (BD / 2 + 0.012), ex, ez, Math.min(0.9, BL * 0.5), 0.09, color);
  // forecourt in front of the entrance
  W.use(WC.PAVING, 0xd8d2c6, 0);
  W.tbox(bx + ex * (BD / 2 + 0.4), Math.max(lo, base - 0.08), bz + ez * (BD / 2 + 0.4), BL + 0.4, base - 0.005 - Math.max(lo, base - 0.08), 0.8, ex, ez, WSCALE.PAVING);
  // clock tower for bigger stations
  if (r.tracks >= 3) {
    fac.boxWalls(bx, base + H, bz, 0.32, 0.32, 0.45, ex, ez, FC.STATION, -1, 0xffffff, st.id * 7 + 5, { floorH: 0.45 });
    roofHip(W, bx, base + H + 0.45, bz, 0.4, 0.4, 0.35, ex, ez, 0x3f6b5c, WC.ROOF_SLATE);
  }
  // footbridge across the tracks
  if (r.platforms.length >= 2) {
    const a = L * 0.28;
    const offs = r.platforms.map((p) => p.off);
    const o0 = Math.min(...offs), o1 = Math.max(...offs);
    const FY = PY + 0.62;
    const [mx, mz] = at((o0 + o1) / 2, a);
    W.use(WC.CONCRETE, 0xa9b0b5, 1);
    W.tbox(mx, FY, mz, 0.2, 0.05, o1 - o0 + 0.2, rx, rz, WSCALE.CONCRETE, true);
    W.use(WC.PLAIN, 0x9fb8c6, 1);
    for (const s of [-1, 1]) {
      const [wx, wz] = at((o0 + o1) / 2, a + s * 0.095);
      W.box(wx, FY + 0.05, wz, 0.012, 0.15, o1 - o0 + 0.2, rx, rz, false);
    }
    W.use(WC.ROOF_FLAT, 0x7b848a, 1);
    W.tbox(mx, FY + 0.2, mz, 0.24, 0.025, o1 - o0 + 0.24, rx, rz, WSCALE.ROOF_FLAT, true);
    W.use(WC.PLAIN, color, 1);
    for (const s of [-1, 1]) {
      const [wx, wz] = at((o0 + o1) / 2, a + s * 0.12);
      W.box(wx, FY + 0.17, wz, 0.008, 0.03, o1 - o0 + 0.24, rx, rz, false);
    }
    for (const o of offs) {
      const [sx, sz] = at(o, a + 0.18);
      W.use(WC.CONCRETE, 0xb3b9bd, 1);
      W.tbox(sx, PY, sz, 0.22, FY + 0.2 - PY, 0.5, fx, fz, WSCALE.CONCRETE);
    }
  }
}

export function buildDepot(ctx: ChunkCtx, d: Depot, color: number) {
  const w = ctx.game.world;
  const W = ctx.w, fac = ctx.fac;
  const sz = depotSize(d.kind);
  const fx = Math.sin(d.angle), fz = Math.cos(d.angle), rx = fz, rz = -fx;
  const y = d.y;
  const lo = lowestUnder(w, d.x, d.z, d.angle, sz.w, sz.d) - 0.06;
  W.use(WC.CONCRETE, 0xa8a49b, 1);
  W.tbox(d.x, lo, d.z, sz.w + 0.04, y - 0.02 - lo, sz.d + 0.04, fx, fz, WSCALE.CONCRETE);
  if (d.kind === 'rail') {
    const H = 0.95, DW = 0.62, DH = 0.8;
    fac.boxWalls(d.x, y - 0.02, d.z, sz.w, sz.d, H, fx, fz, FC.BRICK, -1, 0xffffff, d.id * 13 + 1, { skipFront: true, floorH: H / 2 });
    // front wall with the open door
    const fcx = d.x + fx * (sz.d / 2 - 0.04), fcz = d.z + fz * (sz.d / 2 - 0.04);
    const side = (sz.w - DW) / 2;
    for (const s of [-1, 1]) {
      const o = s * (DW / 2 + side / 2);
      fac.wall(fcx + rx * (o - side / 2) + fx * 0.04, fcz + rz * (o - side / 2) + fz * 0.04, fcx + rx * (o + side / 2) + fx * 0.04, fcz + rz * (o + side / 2) + fz * 0.04, y - 0.02, y - 0.02 + H, fx, fz, FC.BRICK_PLAIN, -1, 0xffffff, d.id, H);
    }
    fac.wall(fcx - rx * DW / 2 + fx * 0.04, fcz - rz * DW / 2 + fz * 0.04, fcx + rx * DW / 2 + fx * 0.04, fcz + rz * DW / 2 + fz * 0.04, y + DH, y - 0.02 + H, fx, fz, FC.BRICK_PLAIN, -1, 0xffffff, d.id, H);
    W.use(WC.PLAIN, color, 1);
    W.box(fcx + fx * 0.045, y + DH, fcz + fz * 0.045, DW + 0.08, 0.05, 0.012, fx, fz, false);
    // door reveals
    W.use(WC.CONCRETE, 0x9a948a, 0);
    for (const s of [-1, 1]) W.twall(fcx + rx * s * DW / 2 + fx * 0.04, fcz + rz * s * DW / 2 + fz * 0.04, fcx + rx * s * DW / 2 - fx * 0.04, fcz + rz * s * DW / 2 - fz * 0.04, y - 0.02, y + DH, y - 0.02, y + DH, -rx * s, -rz * s);
    darkRoom(W, d.x - fx * 0.02, d.z - fz * 0.02, fx, fz, sz.w - 0.08, sz.d - 0.12, y - 0.02, y + DH + 0.02);
    gableWalls(W, d.x, y - 0.02 + H, d.z, sz.w, sz.d, 0.38, fx, fz, 0x9a5a42, true);
    roofGable(W, d.x, y - 0.03 + H, d.z, sz.w + 0.12, sz.d + 0.1, 0.4, fx, fz, 0x5d646a, true, WC.ROOF_SLATE);
    // roof lantern along the ridge
    W.use(WC.METAL, 0x8fb0c0, 1);
    W.box(d.x, y + H + 0.3, d.z, 0.16, 0.12, sz.d * 0.7, fx, fz);
  } else {
    const H = 0.55;
    fac.boxWalls(d.x, y - 0.02, d.z, sz.w, sz.d, H, fx, fz, FC.BRICK_PLAIN, FC.BRICK_PLAIN, 0xffffff, d.id * 13 + 2, { frontCell: FC.GARAGE });
    roofFlat(W, d.x, y - 0.02 + H, d.z, sz.w, sz.d, fx, fz, 0x8b8880);
    W.use(WC.PLAIN, color, 1);
    W.box(d.x + fx * (sz.d / 2 + 0.006), y + H - 0.12, d.z + fz * (sz.d / 2 + 0.006), sz.w, 0.07, 0.012, fx, fz, false);
    // forecourt
    W.use(WC.CONCRETE, 0xb5b2aa, 0);
    W.tbox(d.x + fx * (sz.d / 2 + 0.16), y - 0.06, d.z + fz * (sz.d / 2 + 0.16), sz.w, 0.062, 0.32, fx, fz, WSCALE.CONCRETE);
  }
}

export type { Smp };
