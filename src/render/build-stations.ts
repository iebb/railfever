// Rail stations (platforms with ramps, canopies, signage, station building, footbridge) and depots.
import type { Station, RailPart } from '../game/stations';
import { stationLayout } from '../game/stations';
import type { Depot } from '../game/build-ops';
import { depotSize } from '../game/build-ops';
import { ChunkCtx, Smp, RailPartX, StationEntrance, stationLevelOf, inChunk, stationFrame } from './build-common';
import { WB } from './build-mesh';
import { gableWalls, roofGable, roofHip, roofFlat, lowestUnder, boardText } from './build-buildings';
import { FC, WC, WSCALE, TRAM_BED_HALF, TRAM_BED_PERIOD } from './textures';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR, WATER_Y } from '../game/constants';
import { distToRect } from '../game/world';
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

/**
 * A rail station (called for every chunk; parts are built by the chunk that owns them). Ground stations:
 * platforms, canopies, building, footbridge. Underground: surface entrances and vents only. Elevated:
 * station viaduct with platforms, piers and stair / lift towers.
 */
export function buildStation(ctx: ChunkCtx, st: Station, color: number) {
  const r = st.rail;
  if (!r) return;
  const lv = stationLevelOf(r);
  if (lv === 'underground') { undergroundStation(ctx, st, r as RailPartX, color); return; }
  if (lv === 'elevated') { elevatedStation(ctx, st, r as RailPartX, color); return; }
  if (!inChunk(ctx, r.x, r.z)) return;
  platformsAndCanopies(ctx, r, color);
  stationBuilding(ctx, st, r, color);
}

/** Platforms (with ramps), coping and safety lines, canopies with lamps, name boards. */
function platformsAndCanopies(ctx: ChunkCtx, r: RailPart, color: number) {
  const W = ctx.w, D = ctx.d;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
  const rx = fz, rz = -fx;
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
    // canopy over the middle part (shorter on short platforms): columns, slab roof with a company colour fascia
    const CL = L * (L < 12 ? 0.4 : 0.5);
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
      if (k < cols - 1 && (k & 1) === 0) {
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
    // stairs down to the pedestrian underpass (stations without a footbridge)
    if (r.platforms.length < 3 && (r.platforms.length > 1 || r.tracks > 1)) {
      const [ux, uz] = at(p.off, L * 0.3);
      stairWell(W, D, ux, PY, uz, fx, fz, Math.min(0.2, p.w - 0.34), 0.42, 0.06);
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
}

/** Ground station: building beside the tracks, forecourt, clock tower, footbridge. */
function stationBuilding(ctx: ChunkCtx, st: Station, r: RailPart, color: number) {
  const w = ctx.game.world;
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
  const rx = fz, rz = -fx;
  const y = r.y;
  const L = r.length;
  const at = (off: number, along: number): [number, number] => [r.x + rx * off + fx * along, r.z + rz * off + fz * along];
  const PY = y + PLATFORM_Y;
  // station building beside the tracks (long side along the tracks, entrance facing away)
  const { bx, bz, ex, ez, BL, BD, cx, cz, cw, cd } = stationFrame(r);
  // compact: a single-storey hall, two storeys only for big (4+ track) stations
  const floors = r.tracks >= 4 ? 2 : 1;
  const H = floors === 1 ? 0.42 : 0.66;
  const base = y + 0.02;
  const lo = lowestUnder(w, bx, bz, Math.atan2(ex, ez), BL, BD) - 0.06;
  W.use(WC.STONE, 0xb4aa98, 1);
  W.tbox(bx, lo, bz, BL + 0.04, base - lo, BD + 0.04, ex, ez, WSCALE.STONE);
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.STATION, -1, 0xffffff, st.id * 7 + 3, { door: FC.TOWN_DOOR, floorH: H / floors });
  roofHip(W, bx, base + H, bz, BL + 0.12, BD + 0.12, Math.min(BL, BD) * 0.3, ex, ez, 0x5a6066, WC.ROOF_SLATE);
  W.use(WC.PLAIN, color, 1);
  W.box(bx, base + H - 0.06, bz, BL + 0.025, 0.06, BD + 0.025, ex, ez);
  W.box(bx + ex * (BD / 2 + 0.1), base + 0.3, bz + ez * (BD / 2 + 0.1), Math.min(0.5, BL * 0.6), 0.022, 0.2, ex, ez, false);
  // name board on the eaves band over the entrance
  boardText(D, bx + ex * (BD / 2 + 0.016), base + H - 0.032, bz + ez * (BD / 2 + 0.016), ex, ez, Math.min(0.8, BL * 0.5), 0.05, color);
  // forecourt in front of the entrance (slightly above street sidewalks: access streets end on it)
  const fl = lowestUnder(w, cx, cz, Math.atan2(ex, ez), cw, cd) - 0.04;
  W.use(WC.PAVING, 0xd8d2c6, 0);
  W.tbox(cx, fl, cz, cw, base + 0.004 - fl, cd, ex, ez, WSCALE.PAVING);
  // clock tower for big stations
  if (r.tracks >= 4) {
    const TH = Math.min(BL, BD) * 0.3 + 0.34; // clear of the hipped roof
    fac.boxWalls(bx, base + H, bz, 0.28, 0.28, TH, ex, ez, FC.STATION, -1, 0xffffff, st.id * 7 + 5, { floorH: TH });
    roofHip(W, bx, base + H + TH, bz, 0.36, 0.36, 0.3, ex, ez, 0x3f6b5c, WC.ROOF_SLATE);
  }
  // footbridge across the tracks for big stations (3+ platforms); smaller ones use an underpass
  if (r.platforms.length >= 3) {
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

// ------------------------------------------------------------------------------ stairs, signs

/** Horizontal up-facing quad in a local frame (a across, b along (fx,fz)), plain uvs. */
function flatQuad(B: WB, cx: number, y: number, cz: number, fx: number, fz: number, a0: number, a1: number, b0: number, b1: number) {
  const rx = fz, rz = -fx;
  const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
  const p0 = P(a0, b0), p1 = P(a1, b0), p2 = P(a1, b1), p3 = P(a0, b1);
  B.ttri(p0[0], y, p0[1], 0, 0, p1[0], y, p1[1], 1, 0, p2[0], y, p2[1], 1, 1, 0, 1, 0);
  B.ttri(p0[0], y, p0[1], 0, 0, p2[0], y, p2[1], 1, 1, p3[0], y, p3[1], 0, 1, 0, 1, 0);
}

/**
 * Stairs going down from a floor at height y: a dark well with treads fading into the dark (top step at
 * +len/2 along (fx,fz)) and a low railing round the sides and far end. The ground mesh stays intact, so
 * the descent is painted rather than modelled below the floor.
 */
function stairWell(W: WB, D: WB, cx: number, y: number, cz: number, fx: number, fz: number, sw: number, len: number, railH: number) {
  const rx = fz, rz = -fx;
  W.use(WC.PLAIN, 0x0b0c0d, 0);
  flatQuad(W, cx, y + 0.002, cz, fx, fz, -sw / 2, sw / 2, -len / 2, len / 2);
  const n = 6, step = len / (n + 2);
  for (let k = 0; k < n; k++) {
    const b = len / 2 - (k + 0.35) * step;
    const g = Math.round(150 - k * 19);
    W.use(WC.CONCRETE, (g << 16) | (g << 8) | g, 0);
    flatQuad(W, cx, y + 0.003, cz, fx, fz, -sw / 2 + 0.008, sw / 2 - 0.008, b - step * 0.45, b);
  }
  if (railH <= 0) return;
  D.use(WC.METAL, 0x50565b);
  for (const sg of [-1, 1]) {
    const x = cx + rx * sg * (sw / 2 + 0.006), z = cz + rz * sg * (sw / 2 + 0.006);
    D.box(x, y, z, 0.008, railH, len, fx, fz);
  }
  D.box(cx - fx * (len / 2 + 0.006), y, cz - fz * (len / 2 + 0.006), sw + 0.02, railH, 0.008, fx, fz);
}

const ROUNDEL_BAR = 0x1f2f5a;

/**
 * Station roundel facing ±(nx,nz) centred at (x,y,z): company colour ring, white disc (lit at night) and a
 * dark name bar across, on both faces.
 */
function roundel(ctx: ChunkCtx, x: number, y: number, z: number, nx: number, nz: number, R: number, color: number) {
  const D = ctx.d;
  const ux = -nz, uz = nx;
  const SEG = 16, ri = R * 0.64;
  for (const sd of [-1, 1]) {
    const px = x + nx * sd * 0.003, pz = z + nz * sd * 0.003;
    const pt = (r: number, k: number): [number, number, number] => {
      const a = (k / SEG) * Math.PI * 2;
      return [px + ux * Math.cos(a) * r, y + Math.sin(a) * r, pz + uz * Math.cos(a) * r];
    };
    D.use(WC.PLAIN, color, 0);
    for (let k = 0; k < SEG; k++) {
      const a0 = pt(R, k), a1 = pt(R, k + 1), b0 = pt(ri, k), b1 = pt(ri, k + 1);
      D.ttri(...a0, 0, 0, ...a1, 0, 0, ...b1, 0, 0, nx * sd, 0, nz * sd);
      D.ttri(...a0, 0, 0, ...b1, 0, 0, ...b0, 0, 0, nx * sd, 0, nz * sd);
    }
    D.use(WC.LAMP, 0xfbf6e8, 0);
    for (let k = 0; k < SEG; k++) {
      const b0 = pt(ri, k), b1 = pt(ri, k + 1);
      D.ttri(px, y, pz, 0, 0, ...b0, 0, 0, ...b1, 0, 0, nx * sd, 0, nz * sd);
    }
    boardText(D, x + nx * sd * 0.006, y, z + nz * sd * 0.006, nx * sd, nz * sd, R * 2.5, R * 0.46, ROUNDEL_BAR);
  }
  ctx.lights.push(x, y, z);
}

/** Era of a station's architecture: modern (glass and steel) from 1960 on, classic (stone) before. */
function modernStation(ctx: ChunkCtx, st: Station): boolean {
  const g = ctx.game;
  const year = g.options.startYear + Math.floor((st.built ?? g.day) / (DAYS_PER_MONTH * MONTHS_PER_YEAR));
  return year >= 1960;
}

/** Highest / lowest ground under an oriented rectangle (corners and centre). */
function groundRange(ctx: ChunkCtx, x: number, z: number, fx: number, fz: number, w: number, d: number): [number, number] {
  const wd = ctx.game.world;
  const rx = fz, rz = -fx;
  let hi = -Infinity, lo = Infinity;
  for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1], [0, 0]]) {
    const h = wd.heightAt(x + rx * a * w / 2 + fx * b * d / 2, z + rz * a * w / 2 + fz * b * d / 2);
    if (h > hi) hi = h;
    if (h < lo) lo = h;
  }
  return [hi, lo];
}

/** Is (x,z) clear of roads (paved width + margin) and ground-level rail track? */
function clearOfNetwork(ctx: ChunkCtx, x: number, z: number, margin: number, skip?: Set<number>): boolean {
  const net = ctx.game.world.net;
  for (const e of net.edgesNear(x - 1.5, z - 1.5, x + 1.5, z + 1.5)) {
    if (skip && skip.has(e.id)) continue;
    const g = net.geo(e);
    const hw = net.halfWidth(e) + margin;
    for (let i = 0; i < g.n; i++) {
      const dx = g.pts[i * 3] - x, dz = g.pts[i * 3 + 2] - z;
      if (dx * dx + dz * dz < hw * hw && net.sectionAt(e, g.cum[i]) === 'ground') return false;
    }
  }
  return true;
}

/** Is (x,z) clear of buildings (and parks/plazas) by `margin`? */
function clearOfBuildings(ctx: ChunkCtx, x: number, z: number, margin: number): boolean {
  for (const b of ctx.game.world.buildingsNear(x, z, margin + 2)) {
    if (distToRect(x, z, b.x, b.z, b.angle, b.w / 2, b.d / 2) < margin) return false;
  }
  return true;
}

// ------------------------------------------------------------------------------ underground stations

/** Underground station: nothing above ground but the entrance pavilions and a pair of ventilation grilles. */
function undergroundStation(ctx: ChunkCtx, st: Station, r: RailPartX, color: number) {
  const modern = modernStation(ctx, st);
  for (const en of r.entrances ?? []) if (inChunk(ctx, en.x, en.z)) entrancePavilion(ctx, st, en, color, modern);
  // ventilation grilles above the platforms (only on open ground)
  const w = ctx.game.world;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
  for (const a of [-r.length * 0.3, r.length * 0.3]) {
    const x = r.x + fx * a, z = r.z + fz * a;
    if (!inChunk(ctx, x, z)) continue;
    if (!clearOfNetwork(ctx, x, z, 0.35) || !clearOfBuildings(ctx, x, z, 0.4)) continue;
    const [hi, lo] = groundRange(ctx, x, z, fx, fz, 0.3, 0.5);
    if (lo < WATER_Y + 0.05 || hi - lo > 0.25) continue;
    const W = ctx.w;
    W.use(WC.CONCRETE, 0xb3afa6, 0);
    W.tbox(x, lo - 0.04, z, 0.3, hi + 0.03 - (lo - 0.04), 0.5, fx, fz, WSCALE.CONCRETE, false, true);
    W.use(WC.METAL, 0x2b2e30, 0);
    flatQuad(W, x, hi + 0.032, z, fx, fz, -0.11, 0.11, -0.2, 0.2);
    W.use(WC.METAL, 0x5d6266, 0);
    for (let k = -3; k <= 3; k++) flatQuad(W, x, hi + 0.033, z, fx, fz, -0.11, 0.11, k * 0.055 - 0.006, k * 0.055 + 0.006);
    void w;
  }
}

/**
 * Entrance pavilion with stairs down: a stone kiosk with a hipped copper roof (classic) or a glass box with
 * a slab roof (modern); company colour band, name board, lit roundel, small forecourt.
 */
function entrancePavilion(ctx: ChunkCtx, st: Station, en: StationEntrance, color: number, modern: boolean) {
  const net = ctx.game.world.net;
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const fx = Math.sin(en.angle), fz = Math.cos(en.angle), rx = fz, rz = -fx;
  const BW = 0.6, BD = 0.84, H = modern ? 0.3 : 0.4;
  const P = (a: number, b: number): [number, number] => [en.x + rx * a + fx * b, en.z + rz * a + fz * b];
  const [hi, lo] = groundRange(ctx, en.x, en.z, fx, fz, BW + 0.04, BD + 0.04);
  const yf = hi + 0.035, yb = lo - 0.06;
  const seed = st.id * 31 + Math.round(Math.abs(en.x * 7 + en.z * 13));
  // plinth and floor
  W.use(WC.STONE, modern ? 0xa09d96 : 0xaaa192, 1);
  W.tbox(en.x, yb, en.z, BW + 0.04, yf - yb, BD + 0.04, fx, fz, WSCALE.STONE, false, true);
  const OW = modern ? BW - 0.06 : 0.36, OH = modern ? H - 0.02 : 0.27;
  if (modern) {
    fac.boxWalls(en.x, yf, en.z, BW, BD, H, fx, fz, FC.GLASS, -1, 0xffffff, seed, { skipFront: true, floorH: H });
    W.use(WC.METAL, 0x3a4046, 1);
    for (const [a, b] of [[-1, 1], [1, 1], [-1, -1], [1, -1]]) {
      const [x, z] = P(a * (BW / 2 - 0.012), b * (BD / 2 - 0.012));
      W.box(x, yf, z, 0.028, H, 0.028, fx, fz);
    }
    // slab roof overhanging the front, company colour fascia
    const [cx, cz] = P(0, 0.06);
    W.use(WC.PLAIN, color, 1);
    W.tbox(cx, yf + H, cz, BW + 0.12, 0.045, BD + 0.14, fx, fz, 1, true, false);
    W.use(WC.ROOF_FLAT, 0x8e979d, 1);
    flatQuad(W, cx, yf + H + 0.045, cz, fx, fz, -(BW + 0.12) / 2, (BW + 0.12) / 2, -(BD + 0.14) / 2, (BD + 0.14) / 2);
    const [nx, nz] = P(0, 0.06 + (BD + 0.14) / 2 + 0.004);
    boardText(D, nx, yf + H + 0.0225, nz, fx, fz, BW * 0.75, 0.032, color);
  } else {
    fac.boxWalls(en.x, yf, en.z, BW, BD, H, fx, fz, FC.STATION, -1, 0xffffff, seed, { skipFront: true, floorH: H });
    for (const sg of [-1, 1]) {
      const [ax, az] = P(sg * BW / 2, BD / 2), [bx, bz] = P(sg * OW / 2, BD / 2);
      fac.wall(ax, az, bx, bz, yf, yf + OH, fx, fz, FC.PLASTER_PLAIN, -1, 0xeadfca, seed, OH);
    }
    { const [ax, az] = P(-BW / 2, BD / 2), [bx, bz] = P(BW / 2, BD / 2); fac.wall(ax, az, bx, bz, yf + OH, yf + H, fx, fz, FC.PLASTER_PLAIN, -1, 0xeadfca, seed, H - OH); }
    W.use(WC.CONCRETE, 0xc9bfa8, 0);
    for (const sg of [-1, 1]) {
      const [ax, az] = P(sg * OW / 2, BD / 2), [bx, bz] = P(sg * OW / 2, BD / 2 - 0.05);
      W.twall(ax, az, bx, bz, yf, yf + OH, yf, yf + OH, -rx * sg, -rz * sg);
    }
    roofHip(W, en.x, yf + H, en.z, BW + 0.1, BD + 0.1, 0.17, fx, fz, 0x4f7a6a, WC.ROOF_SLATE);
    W.use(WC.PLAIN, color, 1);
    W.box(en.x, yf + H - 0.045, en.z, BW + 0.016, 0.045, BD + 0.016, fx, fz, false);
    const [nx, nz] = P(0, BD / 2 + 0.01);
    boardText(D, nx, yf + OH + 0.04, nz, fx, fz, Math.min(0.46, BW - 0.1), 0.05, color);
  }
  darkRoom(W, en.x - fx * 0.01, en.z - fz * 0.01, fx, fz, BW - 0.04, BD - 0.04, yf, yf + H - 0.003);
  // the stairs inside, seen through the opening
  stairWell(W, D, en.x - fx * 0.05, yf, en.z - fz * 0.05, fx, fz, Math.min(0.4, OW - 0.06), BD - 0.24, 0.07);
  // paving from the door to the street (entrances stand beside the sidewalk; within the entrance footprint)
  const pd = frontPaving(ctx, P(0, BD / 2), fx, fz, BW + 0.06, Math.min(yf - 0.004, hi + 0.02), 0.26);
  // roundel on a post (classic) or a pylon (modern) at the front corner
  const [sx, sz] = P(BW / 2 - 0.03, BD / 2 + Math.min(0.1, Math.max(0.05, pd - 0.05)));
  const gy = Math.max(ctx.game.world.heightAt(sx, sz), pd > 0 ? Math.min(yf - 0.004, hi + 0.02) : -Infinity);
  if (modern) {
    W.use(WC.METAL, 0x3a4046, 1);
    W.box(sx, gy - 0.03, sz, 0.04, 0.53, 0.03, fx, fz);
    roundel(ctx, sx, gy + 0.58, sz, fx, fz, 0.07, color);
  } else {
    D.use(WC.METAL, 0x2f3438);
    D.cylinder(sx, gy - 0.03, sz, 0.012, 0.47, 6);
    roundel(ctx, sx, gy + 0.5, sz, fx, fz, 0.07, color);
  }
}

/**
 * Paving from a door (front face centre `f`, facing (fx,fz)) out to the nearest street's paved edge, at most
 * `maxD` deep, top at `top`. Returns the depth laid (0 when the sidewalk is right there).
 */
function frontPaving(ctx: ChunkCtx, f: [number, number], fx: number, fz: number, width: number, top: number, maxD: number): number {
  const net = ctx.game.world.net;
  const ne = net.nearestEdge(f[0] + fx * 0.02, f[1] + fz * 0.02, 2, 'road');
  const depth = ne ? Math.min(maxD, ne.d - net.halfWidth(ne.edge) - 0.01) : maxD;
  if (depth < 0.03) return 0;
  const qx = f[0] + fx * depth / 2, qz = f[1] + fz * depth / 2;
  const [, fl] = groundRange(ctx, qx, qz, fx, fz, width, depth);
  if (top <= fl - 0.02) return 0;
  const W = ctx.w;
  W.use(WC.PAVING, 0xd6d0c4, 0);
  W.tbox(qx, fl - 0.05, qz, width, top - (fl - 0.05), depth, fx, fz, WSCALE.PAVING, false, true);
  return depth;
}

// ------------------------------------------------------------------------------ elevated stations

/**
 * Elevated station: one wide viaduct deck carrying the tracks (their per-edge bridges are not built) and
 * the platforms with canopies; parapets, name boards on the fascia, column piers clear of the streets and
 * buildings below; stair / lift towers with a ground-floor entrance hall at the entrances.
 */
function elevatedStation(ctx: ChunkCtx, st: Station, r: RailPartX, color: number) {
  const W = ctx.w, D = ctx.d;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
  const L = r.length;
  const lay = stationLayout(r.tracks);
  const half = lay.width / 2 + 0.16;
  const at = (off: number, along: number): [number, number] => [r.x + rx * off + fx * along, r.z + rz * off + fz * along];
  const top = r.y - 0.05, bot = r.y - 0.25;
  const PY = r.y + PLATFORM_Y;
  if (inChunk(ctx, r.x, r.z)) {
    // deck slab, company colour stripe and name boards on both fascias
    W.use(WC.CONCRETE, 0xbab6ae, 1);
    W.tbox(r.x, bot, r.z, 2 * half, top - bot, L + 0.1, fx, fz, WSCALE.CONCRETE, true, true);
    for (const sg of [-1, 1]) {
      const [ex, ez] = at(sg * (half + 0.004), 0);
      W.use(WC.PLAIN, color, 1);
      W.box(ex, bot + 0.05, ez, 0.008, 0.035, L + 0.1, fx, fz, false);
      boardText(D, ex + rx * sg * 0.004, (top + bot) / 2 + 0.03, ez + rz * sg * 0.004, rx * sg, rz * sg, Math.min(1.2, L * 0.12), 0.08, color);
      // parapet (higher where a platform runs along the edge)
      const edgePlat = r.platforms.some((p) => Math.abs(p.off * sg + p.w / 2 - lay.width / 2) < 0.05 && p.off * sg > 0);
      const pt = edgePlat ? PY + 0.11 : top + 0.12;
      const [px, pz] = at(sg * (half - 0.02), 0);
      W.use(WC.CONCRETE, 0xc4c0b8, 1);
      W.tbox(px, top, pz, 0.04, pt - top, L + 0.1, fx, fz, WSCALE.CONCRETE, false, true);
      if (edgePlat) {
        // walkway between the platform edge and the parapet
        const [wx, wz] = at(sg * (lay.width / 2 + 0.07), 0);
        W.use(WC.PLATFORM, 0xd2cec6, 0);
        W.tbox(wx, top, wz, 0.14, PY - top, L - 0.2, fx, fz, WSCALE.PLATFORM, false, true);
      }
    }
    platformsAndCanopies(ctx, r, color);
  }
  // stair / lift towers to street level
  for (const en of r.entrances ?? []) if (inChunk(ctx, en.x, en.z)) liftTower(ctx, st, r, en, color, half, bot, PY);
  // piers (only where the deck crosses this chunk): the game's footprints, else rows of columns kept
  // clear of the streets, tracks and buildings below
  const ext = L / 2 + half + 0.5;
  if (r.x + ext < ctx.x0 || r.x - ext > ctx.x1 || r.z + ext < ctx.z0 || r.z - ext > ctx.z1) return;
  const skip = new Set<number>(r.edges);
  const cols: [number, number][] = [];
  if (r.piers && r.piers.length) for (const p of r.piers) cols.push([p.x, p.z]);
  else {
    const rows = Math.max(2, Math.round((L - 0.7) / 2.2) + 1);
    const lats = 2 * half <= 1.5 ? [0] : 2 * half <= 2.8 ? [-(half - 0.3), half - 0.3] : [-(half - 0.3), 0, half - 0.3];
    for (let k = 0; k < rows; k++) {
      const a0 = -L / 2 + 0.35 + (k * (L - 0.7)) / (rows - 1);
      for (const l of lats) {
        for (const da of [0, 0.3, -0.3, 0.6, -0.6]) {
          const a = a0 + da;
          if (Math.abs(a) > L / 2 - 0.1) continue;
          const [x, z] = at(l, a);
          if (clearOfNetwork(ctx, x, z, 0.1, skip) && clearOfBuildings(ctx, x, z, 0.1)) { cols.push([x, z]); break; }
        }
      }
    }
  }
  for (const [x, z] of cols) {
    if (!inChunk(ctx, x, z)) continue;
    const gy = ctx.game.world.heightAt(x, z);
    W.use(WC.CONCRETE, 0xa9a59d, 1);
    W.tbox(x, gy - 0.05, z, 0.13, bot - (gy - 0.05), 0.13, fx, fz, WSCALE.CONCRETE, false, false);
    W.tbox(x, bot - 0.08, z, 0.34, 0.08, 0.2, fx, fz, WSCALE.CONCRETE, true, false);
  }
}

/** Stair / lift tower from an entrance hall at street level up to the elevated platforms. */
function liftTower(ctx: ChunkCtx, st: Station, r: RailPartX, en: StationEntrance, color: number, half: number, bot: number, PY: number) {
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
  const efx = Math.sin(en.angle), efz = Math.cos(en.angle);
  const seed = st.id * 41 + Math.round(Math.abs(en.x * 5 + en.z * 11));
  const modern = modernStation(ctx, st);
  // entrance hall
  const HW = 0.56, HD = 0.5, HH = 0.3;
  const [hi, lo] = groundRange(ctx, en.x, en.z, efx, efz, HW + 0.04, HD + 0.04);
  const g = hi + 0.03;
  W.use(WC.STONE, 0xa8a090, 1);
  W.tbox(en.x, lo - 0.06, en.z, HW + 0.04, g - (lo - 0.06), HD + 0.04, efx, efz, WSCALE.STONE, false, true);
  fac.boxWalls(en.x, g, en.z, HW, HD, HH, efx, efz, modern ? FC.GLASS : FC.STATION, FC.LOBBY, 0xffffff, seed, { sideGround: -1, floorH: HH });
  roofFlat(W, en.x, g + HH, en.z, HW, HD, efx, efz, 0x8c8a86);
  W.use(WC.PLAIN, color, 1);
  W.box(en.x, g + HH - 0.04, en.z, HW + 0.012, 0.04, HD + 0.012, efx, efz, false);
  boardText(D, en.x + efx * (HD / 2 + 0.01), g + HH - 0.02, en.z + efz * (HD / 2 + 0.01), efx, efz, HW * 0.7, 0.03, color);
  roundel(ctx, en.x + efx * (HD / 2 + 0.03) + efz * (HW / 2 - 0.06), g + HH + 0.1, en.z + efz * (HD / 2 + 0.03) - efx * (HW / 2 - 0.06), efx, efz, 0.055, color);
  frontPaving(ctx, [en.x + efx * HD / 2, en.z + efz * HD / 2], efx, efz, HW + 0.08, g - 0.004, 0.14);
  // where is the tower relative to the deck?
  const lat = (en.x - r.x) * rx + (en.z - r.z) * rz, al = (en.x - r.x) * fx + (en.z - r.z) * fz;
  const under = Math.abs(lat) < half + 0.12 && Math.abs(al) < r.length / 2 + 0.05;
  const SW = 0.32;
  const sx = en.x - efx * 0.05, sz = en.z - efz * 0.05;
  if (under) {
    // shaft up to the deck, a stair head on the platform above
    fac.boxWalls(sx, g + HH, sz, SW, SW, Math.max(0.05, bot - (g + HH)), fx, fz, FC.CONCRETE_PLAIN, -1, 0xd6d2ca, seed + 1, { floorH: 0.3 });
    const pl = r.platforms.find((p) => Math.abs(lat - p.off) < p.w / 2);
    if (pl) {
      const [kx, kz] = [r.x + rx * pl.off + fx * al, r.z + rz * pl.off + fz * al];
      const kw = Math.min(0.3, pl.w - 0.2);
      fac.boxWalls(kx, PY, kz, kw, 0.42, 0.3, fx, fz, FC.GLASS, -1, 0xffffff, seed + 2, { floorH: 0.3, skipFront: true });
      roofFlat(W, kx, PY + 0.3, kz, kw + 0.04, 0.46, fx, fz, 0x8c8a86);
      darkRoom(W, kx, kz, fx, fz, kw - 0.02, 0.4, PY, PY + 0.29);
      stairWell(W, D, kx, PY, kz, fx, fz, kw - 0.08, 0.34, 0);
    }
    return;
  }
  // beside the deck: tower up past the platforms, covered walkway across to the deck edge
  const TH = PY + 0.36 - (g + HH);
  fac.boxWalls(sx, g + HH, sz, SW, SW, TH, efx, efz, modern ? FC.GLASS : FC.CONCRETE_PLAIN, -1, modern ? 0xffffff : 0xd6d2ca, seed + 1, { floorH: 0.33 });
  roofFlat(W, sx, g + HH + TH, sz, SW + 0.04, SW + 0.04, efx, efz, 0x7c7a76);
  const sg = lat >= 0 ? 1 : -1;
  const alc = Math.max(-r.length / 2 + 0.3, Math.min(r.length / 2 - 0.3, al));
  const tx = r.x + rx * sg * half + fx * alc, tz = r.z + rz * sg * half + fz * alc;
  const dx = tx - sx, dz = tz - sz, dl = Math.hypot(dx, dz);
  if (dl > SW / 2 + 0.05) {
    const ux = dx / dl, uz = dz / dl;
    const a0 = SW / 2 - 0.02, a1 = dl;
    const mx = sx + ux * (a0 + a1) / 2, mz = sz + uz * (a0 + a1) / 2;
    const len = a1 - a0;
    W.use(WC.CONCRETE, 0xb3b9bd, 1);
    W.tbox(mx, PY - 0.06, mz, 0.24, 0.06, len, ux, uz, WSCALE.CONCRETE, true, true);
    W.use(WC.ROOF_FLAT, 0x7b848a, 1);
    W.tbox(mx, PY + 0.29, mz, 0.28, 0.025, len, ux, uz, WSCALE.ROOF_FLAT, true, true);
    for (const s2 of [-1, 1]) {
      const qx = mx + uz * s2 * 0.12, qz = mz - ux * s2 * 0.12;
      const p0x = qx - ux * len / 2, p0z = qz - uz * len / 2, p1x = qx + ux * len / 2, p1z = qz + uz * len / 2;
      fac.wall(p0x, p0z, p1x, p1z, PY, PY + 0.29, uz * s2, -ux * s2, FC.GLASS, -1, 0xffffff, seed + 3, 0.29);
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
  } else if ((d.kind as string) === 'tram') {
    tramDepot(ctx, d, color, sz, y);
  } else {
    const H = 0.55;
    fac.boxWalls(d.x, y - 0.02, d.z, sz.w, sz.d, H, fx, fz, FC.BRICK_PLAIN, FC.BRICK_PLAIN, 0xffffff, d.id * 13 + 2, { frontCell: FC.GARAGE });
    roofFlat(W, d.x, y - 0.02 + H, d.z, sz.w, sz.d, fx, fz, 0x8b8880);
    W.use(WC.PLAIN, color, 1);
    W.box(d.x + fx * (sz.d / 2 + 0.006), y + H - 0.12, d.z + fz * (sz.d / 2 + 0.006), sz.w, 0.07, 0.012, fx, fz, false);
    // forecourt
    W.use(WC.CONCRETE, 0xb5b2aa, 0);
    W.tbox(d.x + fx * (sz.d / 2 + 0.16), y - 0.06, d.z + fz * (sz.d / 2 + 0.16), sz.w, 0.048, 0.32, fx, fz, WSCALE.CONCRETE);
  }
}

export type { Smp };

/** Tram depot: brick hall with three doors, tracks and overhead wires running in, company band. */
function tramDepot(ctx: ChunkCtx, d: Depot, color: number, sz: { w: number; d: number }, y: number) {
  const W = ctx.w, fac = ctx.fac;
  const fx = Math.sin(d.angle), fz = Math.cos(d.angle), rx = fz, rz = -fx;
  // trams use both lanes of the stub edge (±LANE_OFFSET, up to ~0.27 wide, pantographs at ~0.56): a wide
  // twin portal over both tracks (the centre pier hangs clear above the cars), closed doors either side
  const H = 0.9, DH = 0.68, PW = Math.min(sz.w - 0.3, 0.76);
  fac.boxWalls(d.x, y - 0.02, d.z, sz.w, sz.d, H, fx, fz, FC.BRICK, -1, 0xffffff, d.id * 13 + 4, { skipFront: true, floorH: H / 2 });
  const fcx = d.x + fx * sz.d / 2, fcz = d.z + fz * sz.d / 2;
  const P = (a: number, f = 0): [number, number] => [fcx + rx * a + fx * f, fcz + rz * a + fz * f];
  for (const sgn of [-1, 1]) {
    const [ax, az] = P(sgn * sz.w / 2), [bx, bz] = P(sgn * PW / 2);
    fac.wall(ax, az, bx, bz, y - 0.02, y + DH, fx, fz, FC.BRICK_PLAIN, -1, 0xffffff, d.id + sgn, DH);
  }
  { const [ax, az] = P(-sz.w / 2), [bx, bz] = P(sz.w / 2); fac.wall(ax, az, bx, bz, y + DH, y - 0.02 + H, fx, fz, FC.BRICK_PLAIN, -1, 0xffffff, d.id, H - DH); }
  // portal reveals, the hanging centre pier and the lintel band in the company colour
  W.use(WC.CONCRETE, 0x9a948a, 0);
  for (const sgn of [-1, 1]) {
    const [ax, az] = P(sgn * PW / 2), [bx, bz] = P(sgn * PW / 2, -0.06);
    W.twall(ax, az, bx, bz, y - 0.02, y + DH, y - 0.02, y + DH, -rx * sgn, -rz * sgn);
  }
  W.use(WC.STONE, 0x9a5a42, 1);
  { const [cx, cz] = P(0, -0.03); W.box(cx, y + 0.42, cz, 0.04, DH - 0.42, 0.06, fx, fz, false); }
  W.use(WC.PLAIN, color, 1);
  { const [cx, cz] = P(0, 0.006); W.box(cx, y + DH, cz, PW + 0.1, 0.05, 0.012, fx, fz, false); }
  boardText(ctx.d, fcx + fx * 0.008, y + DH + 0.11, fcz + fz * 0.008, fx, fz, Math.min(1.1, sz.w * 0.55), 0.08, color);
  darkRoom(W, d.x - fx * 0.02, d.z - fz * 0.02, fx, fz, PW - 0.02, sz.d - 0.1, y - 0.02, y + DH);
  // closed doors in the side bays (frame, planked leaves), with tracks out over the apron
  const side = (sz.w - PW) / 2;
  if (side > 0.36) {
    const DW = Math.min(0.42, side - 0.14), DD = 0.58;
    for (const sgn of [-1, 1]) {
      const o = sgn * (PW / 2 + side / 2);
      const q = (a0: number, a1: number, y0: number, y1: number, f: number) => {
        const [ax, az] = P(o + a0, f), [bx, bz] = P(o + a1, f);
        W.twall(ax, az, bx, bz, y0, y1, y0, y1, fx, fz);
      };
      W.use(WC.CONCRETE, 0x9a948a, 0);
      q(-DW / 2 - 0.025, DW / 2 + 0.025, y - 0.02, y + DD + 0.025, 0.003);
      W.use(WC.PLAIN, 0x2f4a3c, 0);
      for (const k of [-1, 1]) q(k < 0 ? -DW / 2 : 0.004, k < 0 ? -0.004 : DW / 2, y - 0.02, y + DD, 0.006);
      W.use(WC.TRAMBED, 0xffffff, 0);
      const L = 0.58, yb = y - 0.008;
      const c = [[-TRAM_BED_HALF, 0.01], [TRAM_BED_HALF, 0.01], [TRAM_BED_HALF, L], [-TRAM_BED_HALF, L]].map(([l, f]) => P(o + l, f));
      const v = L / TRAM_BED_PERIOD;
      W.ttri(c[0][0], yb, c[0][1], 0.01, 0, c[1][0], yb, c[1][1], 0.99, 0, c[2][0], yb, c[2][1], 0.99, v, 0, 1, 0);
      W.ttri(c[0][0], yb, c[0][1], 0.01, 0, c[2][0], yb, c[2][1], 0.99, v, c[3][0], yb, c[3][1], 0.01, v, 0, 1, 0);
    }
  }
  gableWalls(W, d.x, y - 0.02 + H, d.z, sz.w, sz.d, 0.3, fx, fz, 0x9a5a42, true);
  roofGable(W, d.x, y - 0.03 + H, d.z, sz.w + 0.12, sz.d + 0.1, 0.32, fx, fz, 0x5d646a, true, WC.ROOF_SLATE);
  W.use(WC.METAL, 0x8fb0c0, 1);
  W.box(d.x, y + H + 0.24, d.z, 0.14, 0.1, sz.d * 0.75, fx, fz);
  // concrete apron in front of the doors (the real tracks and wires are the stub edge's)
  W.use(WC.CONCRETE, 0xb5b2aa, 0);
  W.tbox(d.x + fx * (sz.d / 2 + 0.3), y - 0.06, d.z + fz * (sz.d / 2 + 0.3), sz.w, 0.048, 0.6, fx, fz, WSCALE.CONCRETE);
}
