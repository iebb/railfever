// Rail stations (platforms, canopies, station building, footbridge) and depots.
import type { Station } from '../game/stations';
import { stationLayout } from '../game/stations';
import type { Depot } from '../game/build-ops';
import { depotSize } from '../game/build-ops';
import { GeoBuilder } from './geo';
import { ChunkCtx, wallQuad } from './build-common';
import { FacadeBuilder, gableRoof, gableWalls, hipRoof, flatRoof, lowestUnder } from './build-buildings';
import { FC } from './textures';
import { RAIL_TOP_Y } from './build-rail';

/** Platform top above the station's track profile. */
export const PLATFORM_Y = RAIL_TOP_Y + 0.08;

/** Inward-facing dark room (seen through door openings). Frame: centre, forward f (towards the opening), size. */
function darkRoom(m: GeoBuilder, cx: number, cz: number, fx: number, fz: number, w: number, d: number, y0: number, y1: number) {
  const rx = fz, rz = -fx;
  const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
  const bl = P(-w / 2, -d / 2), br = P(w / 2, -d / 2), fl = P(-w / 2, d / 2), fr = P(w / 2, d / 2);
  m.color(0x0b0c0d);
  wallQuad(m, bl[0], bl[1], fl[0], fl[1], y0, y1, y0, y1, rx, rz);
  wallQuad(m, br[0], br[1], fr[0], fr[1], y0, y1, y0, y1, -rx, -rz);
  wallQuad(m, bl[0], bl[1], br[0], br[1], y0, y1, y0, y1, fx, fz);
  // ceiling facing down
  const q = [bl, br, fr, fl];
  m.quad(q[0][0], y1, q[0][1], q[3][0], y1, q[3][1], q[2][0], y1, q[2][1], q[1][0], y1, q[1][1]);
  const n = m.nrm.length;
  if (m.nrm[n - 2] > 0) {
    const I = m.idx, k = I.length - 6;
    [I[k + 1], I[k + 2]] = [I[k + 2], I[k + 1]];
    [I[k + 4], I[k + 5]] = [I[k + 5], I[k + 4]];
    for (let i = n - 12; i < n; i += 3) { m.nrm[i] = -m.nrm[i]; m.nrm[i + 1] = -m.nrm[i + 1]; m.nrm[i + 2] = -m.nrm[i + 2]; }
  }
}

export function buildStation(ctx: ChunkCtx, fac: FacadeBuilder, st: Station, color: number) {
  const r = st.rail;
  if (!r) return;
  const w = ctx.game.world;
  const m = ctx.matte, mt = ctx.metal;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
  const rx = fz, rz = -fx; // lateral axis used by trackOffsets / platforms
  const y = r.y;
  const L = r.length;
  const at = (off: number, along: number): [number, number] => [r.x + rx * off + fx * along, r.z + rz * off + fz * along];
  const PY = y + PLATFORM_Y;
  // platforms
  for (const p of r.platforms) {
    const [cx, cz] = at(p.off, 0);
    const PL = L - 0.1;
    m.color(0xb3afa6);
    m.box(cx, y - 0.1, cz, p.w, PY - (y - 0.1), PL, fx, fz);
    // surface details: white coping and yellow safety lines along both edges
    for (const s of [-1, 1]) {
      const [ex, ez] = at(p.off + s * (p.w / 2 - 0.02), 0);
      m.color(0xe8e6e0);
      m.box(ex, PY, ez, 0.04, 0.003, PL, fx, fz);
      const [yx, yz] = at(p.off + s * (p.w / 2 - 0.075), 0);
      m.color(0xe2bd2c);
      m.box(yx, PY, yz, 0.012, 0.003, PL, fx, fz);
    }
    // canopy over the middle part
    const CL = L * 0.55;
    const cols = Math.max(2, Math.round(CL / 1.1));
    mt.color(0x4f5a62);
    for (let k = 0; k < cols; k++) {
      const a = -CL / 2 + (CL * (k + 0.5)) / cols;
      const [px, pz] = at(p.off, a);
      mt.box(px, PY, pz, 0.03, 0.36, 0.03, fx, fz);
      if (k < cols - 1) {
        const [bx, bz] = at(p.off, a + CL / cols / 2);
        m.color(0x6d533a);
        m.box(bx, PY + 0.04, bz, 0.06, 0.012, 0.22, fx, fz, false);
      }
      ctx.lights.push(px, PY + 0.33, pz);
    }
    const [kx, kz] = at(p.off, 0);
    m.color(0x8e979c);
    m.box(kx, PY + 0.36, kz, p.w - 0.02, 0.03, CL + 0.1, fx, fz, false);
    m.color(color);
    for (const s of [-1, 1]) {
      const [ex, ez] = at(p.off + s * (p.w / 2 - 0.01), 0);
      m.box(ex, PY + 0.35, ez, 0.02, 0.05, CL + 0.1, fx, fz, false);
    }
    // lamps on the open platform ends
    for (const a of [-L * 0.38, L * 0.38]) {
      const [lx, lz] = at(p.off, a);
      mt.color(0x3d4246);
      mt.cylinder(lx, PY, lz, 0.008, 0.4, 5);
      m.color(0xfff1c8);
      m.box(lx, PY + 0.39, lz, 0.05, 0.02, 0.05, fx, fz, false);
      ctx.lights.push(lx, PY + 0.38, lz);
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
  // entrance faces away from the tracks
  const ex = rx * sideSign, ez = rz * sideSign;
  const floors = r.tracks >= 3 ? 3 : 2;
  const H = floors * 0.33;
  const base = y + 0.02;
  const lo = lowestUnder(w, bx, bz, Math.atan2(ex, ez), BL, BD) - 0.06;
  m.color(0x8d877c);
  m.box(bx, lo, bz, BL + 0.04, base - lo, BD + 0.04, ex, ez);
  // walls: W along local x (= along the tracks), D across
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.STATION, -1, 0xffffff, st.id * 7 + 3, { door: FC.TOWN_DOOR, floorH: 0.33 });
  hipRoof(m, bx, base + H, bz, BL + 0.12, BD + 0.12, Math.min(BL, BD) * 0.35, ex, ez, 0x4b5258);
  // company colour band under the eaves and an entrance canopy
  m.color(color);
  m.box(bx, base + H - 0.06, bz, BL + 0.025, 0.06, BD + 0.025, ex, ez);
  m.box(bx + ex * (BD / 2 + 0.12), base + 0.3, bz + ez * (BD / 2 + 0.12), 0.6, 0.025, 0.24, ex, ez, false);
  // clock tower for bigger stations
  if (r.tracks >= 3) {
    const tx = bx, tz = bz;
    fac.boxWalls(tx, base + H, tz, 0.32, 0.32, 0.45, ex, ez, FC.STATION, -1, 0xffffff, st.id * 7 + 5, { floorH: 0.45 });
    hipRoof(m, tx, base + H + 0.45, tz, 0.4, 0.4, 0.35, ex, ez, 0x3f6b5c);
  }
  // footbridge across the tracks
  if (r.platforms.length >= 2) {
    const a = L * 0.28;
    const offs = r.platforms.map((p) => p.off);
    const o0 = Math.min(...offs), o1 = Math.max(...offs);
    const FY = PY + 0.62;
    const [mx, mz] = at((o0 + o1) / 2, a);
    m.color(0x7d868c);
    m.box(mx, FY, mz, 0.2, 0.05, o1 - o0 + 0.2, rx, rz, false);
    m.color(0x9fb8c6);
    for (const s of [-1, 1]) {
      const [wx, wz] = at((o0 + o1) / 2, a + s * 0.095);
      m.box(wx, FY + 0.05, wz, 0.012, 0.15, o1 - o0 + 0.2, rx, rz, false);
    }
    m.color(0x5f686e);
    m.box(mx, FY + 0.2, mz, 0.24, 0.025, o1 - o0 + 0.24, rx, rz, false);
    for (const o of offs) {
      const [sx, sz] = at(o, a + 0.18);
      m.color(0x8d969b);
      m.box(sx, PY, sz, 0.22, FY + 0.2 - PY, 0.5, fx, fz);
    }
  }
}

export function buildDepot(ctx: ChunkCtx, fac: FacadeBuilder, d: Depot, color: number) {
  const w = ctx.game.world;
  const m = ctx.matte;
  const sz = depotSize(d.kind);
  const fx = Math.sin(d.angle), fz = Math.cos(d.angle), rx = fz, rz = -fx;
  const y = d.y;
  const lo = lowestUnder(w, d.x, d.z, d.angle, sz.w, sz.d) - 0.06;
  m.color(0x8d877c);
  m.box(d.x, lo, d.z, sz.w + 0.04, y - 0.02 - lo, sz.d + 0.04, fx, fz);
  if (d.kind === 'rail') {
    const H = 0.95, DW = 0.62, DH = 0.8;
    fac.boxWalls(d.x, y - 0.02, d.z, sz.w, sz.d, H, fx, fz, FC.BRICK, -1, 0xffffff, d.id * 13 + 1, { skipFront: true, floorH: H / 2 });
    // front wall with the open door
    const fcx = d.x + fx * (sz.d / 2 - 0.04), fcz = d.z + fz * (sz.d / 2 - 0.04);
    m.color(0x9a5a42);
    const side = (sz.w - DW) / 2;
    for (const s of [-1, 1]) {
      const o = s * (DW / 2 + side / 2);
      m.box(fcx + rx * o, y - 0.02, fcz + rz * o, side, H, 0.08, fx, fz);
    }
    m.box(fcx, y + DH, fcz, DW, H - DH - 0.02, 0.08, fx, fz);
    m.color(color);
    m.box(fcx + fx * 0.045, y + DH, fcz + fz * 0.045, DW + 0.08, 0.05, 0.012, fx, fz, false);
    darkRoom(m, d.x - fx * 0.02, d.z - fz * 0.02, fx, fz, sz.w - 0.08, sz.d - 0.2, y - 0.02, y + DH + 0.02);
    gableWalls(m, d.x, y - 0.02 + H, d.z, sz.w, sz.d, 0.38, fx, fz, 0x9a5a42, true);
    gableRoof(m, d.x, y - 0.03 + H, d.z, sz.w + 0.12, sz.d + 0.1, 0.4, fx, fz, 0x50565c, true);
    // roof lantern along the ridge
    m.color(0x8fb0c0);
    m.box(d.x, y + H + 0.3, d.z, 0.16, 0.12, sz.d * 0.7, fx, fz);
  } else {
    const H = 0.55;
    fac.boxWalls(d.x, y - 0.02, d.z, sz.w, sz.d, H, fx, fz, FC.BRICK_PLAIN, FC.BRICK_PLAIN, 0xffffff, d.id * 13 + 2, { frontCell: FC.GARAGE });
    flatRoof(m, d.x, y - 0.02 + H, d.z, sz.w, sz.d, fx, fz, 0x6d6a64);
    m.color(color);
    m.box(d.x + fx * (sz.d / 2 + 0.006), y + H - 0.12, d.z + fz * (sz.d / 2 + 0.006), sz.w, 0.07, 0.012, fx, fz, false);
    // forecourt
    m.color(0x8c8a84);
    m.box(d.x + fx * (sz.d / 2 + 0.16), y - 0.06, d.z + fz * (sz.d / 2 + 0.16), sz.w, 0.062, 0.32, fx, fz);
  }
}
