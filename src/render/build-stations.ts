// Rail stations: platforms (ramps, coping, canopies, signage), the passenger building in the station's style
// (STATION_BUILDERS by station-styles.ts id - none, shelter, classic, brick, modern, concourse, terminal - with
// 'classic' for unknown ids), footbridges and underpasses to every platform, a ground station's added entrances
// (side halls, footbridges with stair towers, underpasses with stair pavilions, platform-end gates), underground
// entrances and elevated decks with stair towers (plus a street-level building when the style is not 'none'), and
// depots.
import type { Station, RailPart, Entrance } from '../game/stations';
import { railWidth, entranceKind, entranceLandings, entranceAlong, ENTRANCE_TYPES } from '../game/stations';
import { styleOf, CONCOURSE_PAVILION, STYLE_PLATFORMS, canopyLength, stationCrossings } from '../game/station-styles';
import type { CanopyKind } from '../game/station-styles';
import type { StationBuildingStyle } from '../game/station-styles';
import type { Depot } from '../game/build-ops';
import { depotSize } from '../game/build-ops';
import { ChunkCtx, RailPartX, StationEntrance, StationLevel, stationLevelOf, inChunk, buildingPose, BuildingPose, forecourtRects } from './build-common';
import { WB } from './build-mesh';
import { gableWalls, roofGable, roofHip, roofFlat, lowestUnder, boardText } from './build-buildings';
import { FC, WC, WSCALE, TRAM_BED_HALF, TRAM_BED_PERIOD } from './textures';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR, WATER_Y } from '../game/constants';
import { distToRect } from '../game/world';
import { RAIL_TOP_Y } from './build-rail';
import { lampPost, drapeBox } from './build-road';
import { stationPose, stationLocal } from '../game/station-geometry';

/** Platform top above the station's track profile. */
export const PLATFORM_Y = RAIL_TOP_Y + 0.08;
const PS = WSCALE.PAVING;

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

/**
 * Platform slab with sloped ends: top surface (platform paving), sides (concrete). `flatEnd` (+1 / -1) keeps
 * that end level (a terminal's head end, joining the concourse).
 */
function platform(W: WB, cx: number, cz: number, fx: number, fz: number, w: number, L: number, y0: number, y1: number, flatEnd = 0) {
  const rx = fz, rz = -fx;
  const R = Math.min(0.4, L * 0.1); // ramp length
  const P = (a: number, b: number): [number, number] => [cx + rx * a + fx * b, cz + rz * a + fz * b];
  const hw = w / 2, hl = L / 2;
  // profile along the platform: (along, height)
  const prof: [number, number][] = [];
  if (flatEnd < 0) prof.push([-hl, y1]); else prof.push([-hl, y0 + 0.012], [-hl + R, y1]);
  if (flatEnd > 0) prof.push([hl, y1]); else prof.push([hl - R, y1], [hl, y0 + 0.012]);
  const sc = WSCALE.PLATFORM;
  W.use(WC.PLATFORM, 0xd2cec6, 0);
  for (let k = 0; k < prof.length - 1; k++) {
    const [a0, h0] = prof[k], [a1, h1] = prof[k + 1];
    const p0 = P(-hw, a0), p1 = P(hw, a0), p2 = P(hw, a1), p3 = P(-hw, a1);
    W.ttri(p0[0], h0, p0[1], -hw / sc, a0 / sc, p1[0], h0, p1[1], hw / sc, a0 / sc, p2[0], h1, p2[1], hw / sc, a1 / sc, 0, 1, 0);
    W.ttri(p0[0], h0, p0[1], -hw / sc, a0 / sc, p2[0], h1, p2[1], hw / sc, a1 / sc, p3[0], h1, p3[1], -hw / sc, a1 / sc, 0, 1, 0);
  }
  W.use(WC.CONCRETE, 0xbdb8ae, 0);
  for (const s of [-1, 1]) {
    for (let k = 0; k < prof.length - 1; k++) {
      const [a0, h0] = prof[k], [a1, h1] = prof[k + 1];
      const p = P(s * hw, a0), q = P(s * hw, a1);
      W.twall(p[0], p[1], q[0], q[1], y0 - 0.1, h0, y0 - 0.1, h1, rx * s, rz * s, WSCALE.CONCRETE, a0);
    }
  }
  // a level end gets an end face (the concourse meets it)
  if (flatEnd !== 0) {
    const a = flatEnd * hl, p = P(-hw, a), q = P(hw, a);
    W.twall(p[0], p[1], q[0], q[1], y0 - 0.1, y1, y0 - 0.1, y1, fx * flatEnd, fz * flatEnd, WSCALE.CONCRETE);
  }
}

// ------------------------------------------------------------------------------ style registry

/** What is drawn on the platforms: canopy look ('shed': the terminal's train shed covers them; station-styles.ts). */
export type { CanopyKind };

/** One station building style: platform canopies, the way to the platforms, the building itself. */
export interface StationBuilder {
  canopy: CanopyKind;
  /** 'auto': an underpass (and a footbridge for 3+ platforms) reaches every platform; 'own': the building does */
  access: 'auto' | 'own';
  /** the building next to the tracks of a ground station */
  ground: (s: StationScene) => void;
  /** the building at street level of an underground / elevated station (only when the style is not 'none') */
  street: (s: StationScene) => void;
}

/** Everything a style builder needs about the station being built. */
export interface StationScene {
  ctx: ChunkCtx; st: Station; r: RailPart; color: number;
  sty: StationBuildingStyle; level: StationLevel;
  /** track axis: forward (fx,fz) along the tracks, right (rx,rz) */
  fx: number; fz: number; rx: number; rz: number;
  /** track profile height, platform top */
  y: number; PY: number;
  L: number; width: number;
  at(off: number, along: number): [number, number];
  /** terminal: the end with the head building (+1 front, -1 back), else 0 */
  headEnd: number;
  /** a building of the 1960s on */
  modern: boolean;
  seed: number;
}

function sceneOf(ctx: ChunkCtx, st: Station, r: RailPart, color: number): StationScene {
  const sty = styleOf(r.style);
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
  let headEnd = 0;
  if (sty.placement === 'end') headEnd = ((r.building.x - r.x) * fx + (r.building.z - r.z) * fz) >= 0 ? 1 : -1;
  return {
    ctx, st, r, color, sty, level: stationLevelOf(r), fx, fz, rx, rz,
    y: r.y, PY: r.y + PLATFORM_Y, L: r.length, width: railWidth(r),
    at: (off, along) => { const p = stationPose(r, off, along); return [p.x, p.z]; },
    headEnd, modern: modernStation(ctx, st), seed: st.id * 7 + 3,
  };
}

/** A hall drawn at a pose: ground floor at `base`, plinth from `lo`, `floors` storeys. */
type Hall = (s: StationScene, p: BuildingPose, base: number, lo: number, floors: number) => void;

// (canopies and the way to the platforms per style are shared with the game: station-styles.ts STYLE_PLATFORMS)
export const STATION_BUILDERS: Record<string, StationBuilder> = {
  none: { ...STYLE_PLATFORMS.none, ground: noneGround, street: () => undefined },
  shelter: { ...STYLE_PLATFORMS.shelter, ground: (s) => sideStation(s, shelterHut), street: (s) => streetStation(s, shelterHut) },
  classic: { ...STYLE_PLATFORMS.classic, ground: (s) => sideStation(s, classicHall), street: (s) => streetStation(s, classicHall) },
  brick: { ...STYLE_PLATFORMS.brick, ground: (s) => sideStation(s, brickHall), street: (s) => streetStation(s, brickHall) },
  modern: { ...STYLE_PLATFORMS.modern, ground: (s) => sideStation(s, modernHall), street: (s) => streetStation(s, modernHall) },
  concourse: { ...STYLE_PLATFORMS.concourse, ground: concourseGround, street: concourseUnderDeck },
  terminal: { ...STYLE_PLATFORMS.terminal, ground: terminalGround, street: (s) => streetStation(s, classicHall) },
};

/** The builder of a style id ('classic' for unknown ids, as styleOf). */
export function stationBuilder(id?: string): StationBuilder {
  return STATION_BUILDERS[styleOf(id).id] ?? STATION_BUILDERS.classic;
}

/**
 * A rail station (called for every chunk; parts are built by the chunk that owns them). Ground stations:
 * platforms with canopies, access to every platform and the building in the station's style. Underground:
 * surface entrances and vents (plus a street-level building with a style). Elevated: the station viaduct with
 * platforms, piers and stair / lift towers (plus a building at street level, or a concourse under the deck).
 */
export function buildStation(ctx: ChunkCtx, st: Station, color: number) {
  const r = st.rail;
  if (!r) return;
  const s = sceneOf(ctx, st, r, color);
  const B = stationBuilder(r.style);
  if (r.alignment) { nativeStation(ctx, st, r, color, s, B); return; }
  if (s.level === 'underground') { undergroundStation(ctx, st, r as RailPartX, color); if (s.sty.placement !== 'none') B.street(s); return; }
  if (s.level === 'elevated') { elevatedStation(ctx, st, r as RailPartX, color, B.canopy === 'shed' ? 'classic' : B.canopy); if (s.sty.placement !== 'none') B.street(s); return; }
  // added entrances: built by the chunk that owns their street-side structure
  for (const e of r.entrances ?? []) if (inChunk(ctx, e.x, e.z)) groundEntrance(s, e);
  if (!inChunk(ctx, r.x, r.z)) return;
  platformsAndCanopies(ctx, r, color, B.canopy, s.headEnd);
  if (B.access === 'auto') platformAccess(s);
  B.ground(s);
}

/** A slab swept over the actual track curves; paving, decks and roofs share the same geometry. */
function curvedSlab(W: WB, r: RailPart, off: number, width: number, from: number, to: number, bottom: number, top: number, ramp = false) {
  const n = Math.max(1, Math.ceil((to - from) / 0.3));
  const height = (a: number, p: ReturnType<typeof stationPose>) => p.y + (ramp
    ? bottom + 0.012 + (top - bottom - 0.012) * Math.min(1, Math.max(0, Math.min(a - from, to - a) / 0.4)) : top);
  for (let i = 0; i < n; i++) {
    const a = from + (to - from) * i / n, b = from + (to - from) * (i + 1) / n;
    const p = stationPose(r, off - width / 2, a), q = stationPose(r, off + width / 2, a);
    const t = stationPose(r, off + width / 2, b), u = stationPose(r, off - width / 2, b);
    const hp = height(a, p), hq = height(a, q), ht = height(b, t), hu = height(b, u);
    W.ttri(p.x, hp, p.z, 0, a, q.x, hq, q.z, width, a, t.x, ht, t.z, width, b, 0, 1, 0);
    W.ttri(p.x, hp, p.z, 0, a, t.x, ht, t.z, width, b, u.x, hu, u.z, 0, b, 0, 1, 0);
    W.twall(p.x, p.z, u.x, u.z, p.y + bottom, hp, u.y + bottom, hu, -p.fz, p.fx, WSCALE.CONCRETE, a);
    W.twall(q.x, q.z, t.x, t.z, q.y + bottom, hq, t.y + bottom, ht, q.fz, -q.fx, WSCALE.CONCRETE, a);
    if (i === 0) W.twall(p.x, p.z, q.x, q.z, p.y + bottom, hp, q.y + bottom, hq, -p.fx, -p.fz, WSCALE.CONCRETE);
    if (i === n - 1) W.twall(u.x, u.z, t.x, t.z, u.y + bottom, hu, t.y + bottom, ht, u.fx, u.fz, WSCALE.CONCRETE);
  }
}

/** Native platforms, screen doors and fit-out retain each physical track's curve and arc correspondence. */
function nativeStation(ctx: ChunkCtx, st: Station, r: RailPart, color: number, scene: StationScene, B: StationBuilder) {
  const W = ctx.w, D = ctx.d, level = stationLevelOf(r), width = railWidth(r), from = -r.length / 2 + 0.05, to = r.length / 2 - 0.05;
  if (level === 'ground') for (const e of r.entrances) if (inChunk(ctx, e.x, e.z)) groundEntrance(scene, e);
  if (level === 'underground') {
    for (const e of r.entrances) if (inChunk(ctx, e.x, e.z)) entrancePavilion(ctx, st, e, color, scene.modern);
    if (scene.sty.placement !== 'none') B.street(scene);
  }
  if (level === 'elevated') {
    for (const e of r.entrances) if (inChunk(ctx, e.x, e.z)) liftTower(ctx, st, r, e, color, width / 2 + 0.16, r.y - 0.25, r.y + PLATFORM_Y);
    for (const p of r.piers) if (inChunk(ctx, p.x, p.z)) {
      const h = ctx.game.world.heightAt(p.x, p.z), a = stationLocal(r, p.x, p.z).along, top = stationPose(r, 0, a).y - 0.25;
      W.use(WC.CONCRETE, 0xb4b0a7, 1); W.box(p.x, h - 0.2, p.z, 0.4, Math.max(0.1, top - h + 0.2), 0.4);
    }
    if (scene.sty.placement !== 'none') B.street(scene);
  }
  if (!inChunk(ctx, r.x, r.z)) return;
  if (level === 'elevated') {
    W.use(WC.CONCRETE, 0xbab6ae, 1); curvedSlab(W, r, 0, width + 0.32, from, to, -0.25, -0.05);
    for (const side of [-1, 1]) {
      W.use(WC.CONCRETE, 0xc4c0b8, 1); curvedSlab(W, r, side * (width / 2 + 0.13), 0.04, from, to, -0.05, PLATFORM_Y + 0.1);
      W.use(WC.PLAIN, color, 1); curvedSlab(W, r, side * (width / 2 + 0.162), 0.008, from, to, -0.20, -0.165);
    }
  }
  for (const p of r.platforms) {
    const [a0, a1] = platRange(r, p), lo = a0 + 0.05, hi = a1 - 0.05;
    W.use(WC.PLATFORM, 0xd2cec6, 0); curvedSlab(W, r, p.off, p.w, lo, hi, -0.2, PLATFORM_Y, true);
    for (const side of [-1, 1]) {
      const edge = p.off + side * (p.w / 2 - 0.02);
      W.use(WC.PLAIN, 0xeceae4, 0); curvedSlab(W, r, edge, 0.04, lo + 0.4, hi - 0.4, PLATFORM_Y, PLATFORM_Y + 0.003);
      W.use(WC.PLAIN, 0xe8c230, 0); curvedSlab(W, r, p.off + side * (p.w / 2 - 0.075), 0.012, lo + 0.4, hi - 0.4, PLATFORM_Y, PLATFORM_Y + 0.003);
      const track = r.trackOffsets.reduce((best, off) => Math.abs(off - edge) < Math.abs(best - edge) ? off : best, Infinity);
      if (r.psd && Math.abs(track - edge) < 0.4) {
        W.use(WC.PLAIN, 0x9fb8c6, 1); curvedSlab(W, r, edge - side * 0.01, 0.018, lo + 0.4, hi - 0.4, PLATFORM_Y, PLATFORM_Y + 0.32);
        for (let a = lo + 0.4; a < hi - 0.4; a += 0.7) { const q = stationPose(r, edge - side * 0.01, a); D.use(WC.METAL, color); D.box(q.x, q.y + PLATFORM_Y, q.z, 0.026, 0.34, 0.026, q.fx, q.fz); }
      }
    }
    const CL = canopyLength(B.canopy, hi - lo, r.length), mid = (hi + lo) / 2;
    if (CL > 0.1 && B.canopy !== 'shed') {
      if (B.canopy === 'shelter') {
        const q = stationPose(r, p.off, mid);
        canopy(ctx, B.canopy, (off, along) => { const v = stationPose(r, off, along); return [v.x, v.z]; }, p.off, mid, p.w, CL, q.y + PLATFORM_Y, q.fx, q.fz, color);
      } else {
        W.use(WC.ROOF_FLAT, 0x7b848a, 1); curvedSlab(W, r, p.off, Math.max(0.2, p.w - 0.04), mid - CL / 2, mid + CL / 2, PLATFORM_Y + 0.43, PLATFORM_Y + 0.46);
        for (let a = mid - CL / 2 + 0.15; a <= mid + CL / 2 - 0.15; a += 1.2) {
          const q = stationPose(r, p.off, a); D.use(WC.METAL, 0x6d757b); D.box(q.x, q.y + PLATFORM_Y, q.z, 0.025, 0.43, 0.025, q.fx, q.fz);
        }
      }
    }
    for (const a of [lo + 0.7, hi - 0.7]) {
      const q = stationPose(r, p.off, a); lampPost(ctx, q.x, q.y + PLATFORM_Y, q.z, q.fx, q.fz, 0.42, 0);
      D.use(WC.METAL, 0x50565b); D.cylinder(q.x, q.y + PLATFORM_Y, q.z, 0.008, 0.26, 4);
      boardText(D, q.x, q.y + PLATFORM_Y + 0.2, q.z, q.fz, -q.fx, 0.24, 0.06, color);
    }
  }
  if (B.access === 'auto') platformAccess(scene);
  if (level === 'ground') B.ground(scene);
}

/** Along-axis extent of a platform (merged stations: partial platforms). */
function platRange(r: RailPart, p: RailPart['platforms'][number]): [number, number] {
  return [p.from ?? -r.length / 2, p.to ?? r.length / 2];
}

/** Platforms (with ramps), coping and safety lines, canopies (by style) with lamps, name boards. */
function platformsAndCanopies(ctx: ChunkCtx, r: RailPart, color: number, kind: CanopyKind, headEnd: number) {
  const W = ctx.w, D = ctx.d;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
  const rx = fz, rz = -fx;
  const y = r.y;
  const at = (off: number, along: number): [number, number] => [r.x + rx * off + fx * along, r.z + rz * off + fz * along];
  const PY = y + PLATFORM_Y;
  const thr = r.throughOffsets ?? [];
  for (const p of r.platforms) {
    const [a0, a1] = platRange(r, p);
    const mid = (a0 + a1) / 2, PL = a1 - a0 - 0.1;
    if (PL < 0.4) continue;
    const flat = headEnd > 0 && a1 >= r.length / 2 - 0.05 ? 1 : headEnd < 0 && a0 <= -r.length / 2 + 0.05 ? -1 : 0;
    // a level head end reaches the platform's end (the head concourse continues from there)
    const pm = flat ? mid + flat * 0.025 : mid, pl = flat ? PL + 0.05 : PL;
    const [cx, cz] = at(p.off, pm);
    platform(W, cx, cz, fx, fz, p.w, pl, y - 0.1, PY, flat);
    // white coping and yellow safety lines along both edges (thin raised strips on the flat part); a low
    // fence where a through track (no stopping trains) runs next to the platform edge
    for (const s of [-1, 1]) {
      const edgeOff = p.off + s * p.w / 2;
      const nearT = [...r.trackOffsets, ...thr].reduce((best, o) => ((o - edgeOff) * s > 0 && Math.abs(o - edgeOff) < Math.abs(best - edgeOff) ? o : best), Infinity);
      if (thr.includes(nearT) && Math.abs(nearT - edgeOff) < 0.45) {
        const [gx, gz] = at(edgeOff - s * 0.03, mid);
        D.use(WC.METAL, 0x6d757b);
        D.box(gx, PY, gz, 0.008, 0.1, PL - 0.9, fx, fz);
        for (let a = -(PL - 0.9) / 2; a <= (PL - 0.9) / 2 + 1e-6; a += 0.5) {
          const [qx, qz] = at(edgeOff - s * 0.03, mid + a);
          D.box(qx, PY, qz, 0.014, 0.11, 0.014, fx, fz);
        }
      }
      const [ex, ez] = at(p.off + s * (p.w / 2 - 0.02), mid);
      W.use(WC.PLAIN, 0xeceae4, 0);
      W.box(ex, PY, ez, 0.04, 0.003, PL - 0.8, fx, fz);
      const [yx, yz] = at(p.off + s * (p.w / 2 - 0.075), mid);
      W.use(WC.PLAIN, 0xe8c230, 0);
      W.box(yx, PY, yz, 0.012, 0.003, PL - 0.8, fx, fz);
    }
    const CL = canopyLength(kind, PL, r.length);
    if (kind !== 'shed') canopy(ctx, kind, at, p.off, mid, p.w, CL, PY, fx, fz, color);
    // name boards (company colour) on the open platform parts, lamps
    const bo = Math.min(PL / 2 - 0.45, Math.max(CL / 2 + 0.75, PL * 0.36));
    for (const sg of [-1, 1]) {
      const [lx, lz] = at(p.off, mid + sg * Math.min(PL / 2 - 0.25, bo + 0.45));
      if (kind !== 'shed') lampPost(ctx, lx, PY, lz, fx, fz, 0.42, 0.0);
      const [sx, sz] = at(p.off, mid + sg * bo);
      D.use(WC.METAL, 0x50565b);
      for (const o of [-0.09, 0.09]) { const [qx, qz] = [sx + fx * o, sz + fz * o]; D.cylinder(qx, PY, qz, 0.006, 0.26, 4); }
      boardText(D, sx, PY + 0.2, sz, rx, rz, 0.24, 0.06, color);
      boardText(D, sx, PY + 0.2, sz, -rx, -rz, 0.24, 0.06, color);
    }
  }
}

/** A platform canopy (columns, roof, fascia, lamps, benches) of a kind, `CL` long, centred at `mid`. */
function canopy(ctx: ChunkCtx, kind: CanopyKind, at: (off: number, along: number) => [number, number], off: number, mid: number, pw: number,
  CL: number, PY: number, fx: number, fz: number, color: number) {
  const W = ctx.w, D = ctx.d;
  if (kind === 'shelter') {
    // one or two small shelters: back wall (glass), side screens, a roof slab, a bench
    const n = CL > 1.0 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const a = mid + (n === 1 ? 0 : (k - 0.5) * CL * 0.6);
      const sw = Math.min(0.5, CL / n * 0.8), sd = Math.min(0.24, pw - 0.22);
      if (sd < 0.1) continue;
      const [qx, qz] = at(off, a);
      D.use(WC.PLAIN, 0x9fb8c6);
      D.box(qx, PY, qz, 0.012, 0.25, sw, fx, fz);
      D.use(WC.METAL, 0x3c4246);
      for (const sg of [-1, 1]) { const [px, pz] = at(off + sg * (sd / 2 - 0.01), a + sw / 2); D.box(px, PY, pz, 0.016, 0.27, 0.016, fx, fz); const [bx, bz] = at(off + sg * (sd / 2 - 0.01), a - sw / 2); D.box(bx, PY, bz, 0.016, 0.27, 0.016, fx, fz); }
      W.use(WC.ROOF_FLAT, 0x6f777c, 1);
      W.tbox(qx, PY + 0.27, qz, sd + 0.06, 0.02, sw + 0.06, fx, fz, WSCALE.ROOF_FLAT, true, true);
      W.use(WC.PLAIN, color, 1);
      W.box(qx, PY + 0.262, qz, sd + 0.065, 0.012, sw + 0.065, fx, fz, false);
      D.use(WC.PLAIN, 0x6d533a);
      D.box(qx, PY + 0.04, qz, 0.05, 0.012, sw * 0.7, fx, fz, false);
      D.use(WC.LAMP, 0xfff1c8);
      D.box(qx, PY + 0.25, qz, 0.06, 0.01, 0.06, fx, fz, true);
      ctx.lights.push(qx, PY + 0.24, qz);
    }
    return;
  }
  const modern = kind === 'modern', heritage = kind === 'heritage';
  const cols = Math.max(2, Math.round(CL / (modern ? 1.4 : 1.1)));
  const H = modern ? 0.4 : 0.36;
  for (let k = 0; k < cols; k++) {
    const a = mid - CL / 2 + (CL * (k + 0.5)) / cols;
    const [px, pz] = at(off, a);
    D.use(WC.METAL, heritage ? 0x2f4a3a : modern ? 0x9aa3a9 : 0x5c666e);
    D.box(px, PY, pz, modern ? 0.024 : 0.03, H, modern ? 0.024 : 0.03, fx, fz);
    if (heritage) { D.box(px, PY + H - 0.06, pz, 0.08, 0.02, 0.08, fx, fz); }
    // lamp under the canopy
    D.use(WC.LAMP, 0xfff1c8);
    D.box(px, PY + H - 0.03, pz, 0.12, 0.012, 0.03, fx, fz, true);
    ctx.lights.push(px, PY + H - 0.05, pz);
    if (k < cols - 1 && (k & 1) === 0) {
      const [bx, bz] = at(off, a + CL / cols / 2);
      D.use(WC.PLAIN, 0x6d533a);
      D.box(bx, PY + 0.04, bz, 0.06, 0.012, 0.22, fx, fz, false);
      D.use(WC.METAL, 0x40464b);
      D.box(bx, PY, bz, 0.05, 0.04, 0.2, fx, fz);
    }
  }
  const [kx, kz] = at(off, mid);
  if (heritage) {
    // ridged canopy roof with a fringed valance (iron-and-timber)
    roofGable(W, kx, PY + H, kz, pw - 0.02, CL + 0.1, 0.07, fx, fz, 0x5a5f5c, true, WC.ROOF_SLATE);
    W.use(WC.PLAIN, 0xe9e2cf, 1);
    for (const s of [-1, 1]) {
      const [ex, ez] = at(off + s * ((pw - 0.02) / 2), mid);
      W.box(ex, PY + H - 0.05, ez, 0.01, 0.05, CL + 0.1, fx, fz, false);
    }
    W.use(WC.PLAIN, color, 1);
    for (const s of [-1, 1]) {
      const [ex, ez] = at(off + s * ((pw - 0.02) / 2 + 0.006), mid);
      W.box(ex, PY + H - 0.012, ez, 0.006, 0.012, CL + 0.1, fx, fz, false);
    }
    return;
  }
  W.use(WC.ROOF_FLAT, modern ? 0xc3c9cd : 0x9aa3a8, 1);
  W.tbox(kx, PY + H, kz, pw - 0.02, modern ? 0.022 : 0.03, CL + 0.1, fx, fz, WSCALE.ROOF_FLAT, true);
  if (modern) {
    // a glazed strip along the middle of the roof
    W.use(WC.PLAIN, 0x7f98a6, 1);
    W.box(kx, PY + H + 0.022, kz, Math.max(0.06, (pw - 0.02) * 0.3), 0.004, CL, fx, fz, false);
  }
  W.use(WC.PLAIN, color, 1);
  for (const s of [-1, 1]) {
    const [ex, ez] = at(off + s * (pw / 2 - 0.01), mid);
    W.box(ex, PY + H - 0.01, ez, 0.02, modern ? 0.035 : 0.05, CL + 0.1, fx, fz, false);
  }
}

/**
 * The way to every platform (styles without their own): an underpass with stairs on each platform (the
 * building, or a ramp pad's stair, is its street end) when trains run between the street and a platform, and
 * for 3+ platforms also a footbridge across all of them.
 */
function platformAccess(s: StationScene) {
  const { ctx, r, PY, fx, fz, rx, rz } = s;
  const W = ctx.w, D = ctx.d;
  // where they lie is shared with the game (entrances keep clear of them): station-styles.ts stationCrossings
  const own = stationCrossings(r);
  for (const q of own.stairs) {
    const p = r.platforms[q.platform];
    const [ux, uz] = s.at(p.off, q.along);
    const pose = stationPose(r, p.off, q.along);
    stairWell(W, D, ux, r.alignment ? pose.y + PLATFORM_Y : PY, uz, pose.fx, pose.fz, Math.min(0.2, p.w - 0.34), 0.42, 0.06);
  }
  if (own.footbridge === null) return;
  // footbridge across all platforms (beyond the canopies), stairs down onto each
  const offs = r.platforms.map((p) => p.off);
  const o0 = Math.min(...offs), o1 = Math.max(...offs);
  const a = own.footbridge;
  const FY = PY + 0.62;
  const [mx, mz] = s.at((o0 + o1) / 2, a);
  W.use(WC.CONCRETE, 0xa9b0b5, 1);
  W.tbox(mx, FY, mz, 0.2, 0.05, o1 - o0 + 0.2, rx, rz, WSCALE.CONCRETE, true);
  W.use(WC.PLAIN, 0x9fb8c6, 1);
  for (const sg of [-1, 1]) {
    const [wx, wz] = s.at((o0 + o1) / 2, a + sg * 0.095);
    W.box(wx, FY + 0.05, wz, 0.012, 0.15, o1 - o0 + 0.2, rx, rz, false);
  }
  W.use(WC.ROOF_FLAT, 0x7b848a, 1);
  W.tbox(mx, FY + 0.2, mz, 0.24, 0.025, o1 - o0 + 0.24, rx, rz, WSCALE.ROOF_FLAT, true);
  W.use(WC.PLAIN, s.color, 1);
  for (const sg of [-1, 1]) {
    const [wx, wz] = s.at((o0 + o1) / 2, a + sg * 0.12);
    W.box(wx, FY + 0.17, wz, 0.008, 0.03, o1 - o0 + 0.24, rx, rz, false);
  }
  for (const o of offs) {
    const [sx, sz] = s.at(o, a + 0.18);
    W.use(WC.CONCRETE, 0xb3b9bd, 1);
    W.tbox(sx, PY, sz, 0.22, FY + 0.2 - PY, 0.5, fx, fz, WSCALE.CONCRETE);
  }
}

// ------------------------------------------------------------------------------ station buildings

/** Paved forecourts in front of the building(s) (the access street ends on them). */
function forecourts(s: StationScene, top: number) {
  const W = s.ctx.w, w = s.ctx.game.world;
  for (const f of forecourtRects(s.r)) {
    W.use(WC.PAVING, 0xd8d2c6, 0);
    if (s.ctx.drape) drapeBox(W, s.ctx.drape, f.cx, f.cz, f.cw, f.cd, f.ex, f.ez, -0.03, 0.022, PS);
    else {
      const fl = lowestUnder(w, f.cx, f.cz, Math.atan2(f.ex, f.ez), f.cw, f.cd) - 0.04;
      W.tbox(f.cx, fl, f.cz, f.cw, Math.max(0.02, top - fl), f.cd, f.ex, f.ez, PS);
    }
  }
}

/** A side building (and its forecourt) of a ground station, at platform level. */
function sideStation(s: StationScene, hall: Hall) {
  const p = buildingPose(s.r);
  const base = s.y + 0.02;
  const lo = lowestUnder(s.ctx.game.world, p.bx, p.bz, Math.atan2(p.ex, p.ez), p.BL, p.BD) - 0.06;
  hall(s, p, base, Math.min(lo, base - 0.04), s.r.tracks + (s.r.through ?? 0) >= 4 ? 2 : 1);
  forecourts(s, base + 0.004);
}

/** A building at street level beside an underground / elevated station (in the chunk that owns its centre). */
function streetStation(s: StationScene, hall: Hall) {
  if (!s.r.forecourt) return;
  const p = buildingPose(s.r);
  if (!inChunk(s.ctx, p.bx, p.bz)) return;
  const [hi, lo] = groundRange(s.ctx, p.bx, p.bz, p.ex, p.ez, p.BL + 0.04, p.BD + 0.04);
  const base = hi + 0.03;
  hall(s, p, base, lo - 0.06, 1);
  forecourts(s, base - 0.004);
}

/** The classic station building: stone plinth, station facade, hipped slate roof, clock tower for big stations. */
function classicHall(s: StationScene, p: BuildingPose, base: number, lo: number, floors: number) {
  const W = s.ctx.w, D = s.ctx.d, fac = s.ctx.fac;
  const { bx, bz, ex, ez, BL, BD } = p;
  const H = floors === 1 ? 0.42 : 0.66;
  W.use(WC.STONE, 0xb4aa98, 1);
  W.tbox(bx, lo, bz, BL + 0.04, base - lo, BD + 0.04, ex, ez, WSCALE.STONE);
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.STATION, -1, 0xffffff, s.seed, { door: FC.TOWN_DOOR, floorH: H / floors });
  roofHip(W, bx, base + H, bz, BL + 0.12, BD + 0.12, Math.min(BL, BD) * 0.3, ex, ez, 0x5a6066, WC.ROOF_SLATE);
  W.use(WC.PLAIN, s.color, 1);
  W.box(bx, base + H - 0.06, bz, BL + 0.025, 0.06, BD + 0.025, ex, ez);
  W.box(bx + ex * (BD / 2 + 0.1), base + 0.3, bz + ez * (BD / 2 + 0.1), Math.min(0.5, BL * 0.6), 0.022, 0.2, ex, ez, false);
  boardText(D, bx + ex * (BD / 2 + 0.016), base + H - 0.032, bz + ez * (BD / 2 + 0.016), ex, ez, Math.min(0.8, BL * 0.5), 0.05, s.color);
  if (floors > 1 || s.r.tracks >= 4) {
    const TH = Math.min(BL, BD) * 0.3 + 0.34; // clear of the hipped roof
    fac.boxWalls(bx, base + H, bz, 0.28, 0.28, TH, ex, ez, FC.STATION, -1, 0xffffff, s.seed + 2, { floorH: TH });
    roofHip(W, bx, base + H + TH, bz, 0.36, 0.36, 0.3, ex, ez, 0x3f6b5c, WC.ROOF_SLATE);
    clockFace(D, bx + ex * 0.145, base + H + TH - 0.12, bz + ez * 0.145, ex, ez, 0.07);
  }
}

/** The early railway's brick building: gabled slate roof, brick gable ends, chimneys, a porch over the door. */
function brickHall(s: StationScene, p: BuildingPose, base: number, lo: number, floors: number) {
  const W = s.ctx.w, D = s.ctx.d, fac = s.ctx.fac;
  const { bx, bz, ex, ez, BL, BD } = p;
  const rx = ez, rz = -ex;
  const H = floors === 1 ? 0.44 : 0.7;
  W.use(WC.STONE, 0x8e8577, 1);
  W.tbox(bx, lo, bz, BL + 0.04, base - lo, BD + 0.04, ex, ez, WSCALE.STONE);
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.BRICK, -1, 0xffffff, s.seed, { door: FC.BRICK_DOOR, floorH: H / floors });
  // stone band over the ground floor, company colour band under the eaves
  W.use(WC.STONE, 0xc9bda6, 1);
  W.box(bx, base + Math.min(0.32, H / floors), bz, BL + 0.03, 0.025, BD + 0.03, ex, ez);
  W.use(WC.PLAIN, s.color, 1);
  W.box(bx, base + H - 0.035, bz, BL + 0.02, 0.035, BD + 0.02, ex, ez);
  const RH = Math.min(0.34, BD * 0.42);
  roofGable(W, bx, base + H, bz, BL + 0.1, BD + 0.16, RH, ex, ez, 0x4c5157, false, WC.ROOF_SLATE);
  gableWalls(W, bx, base + H, bz, BL, BD, RH - 0.01, ex, ez, 0x9b5a45, false);
  // chimneys on the ridge
  W.use(WC.STONE, 0x8a4f3c, 1);
  for (const sg of [-1, 1]) W.box(bx + rx * sg * BL * 0.3, base + H + RH * 0.55, bz + rz * sg * BL * 0.3, 0.07, RH * 0.45 + 0.12, 0.07, ex, ez);
  // porch over the door
  W.use(WC.ROOF_FLAT, 0x5b5f63, 1);
  W.tbox(bx + ex * (BD / 2 + 0.08), base + 0.31, bz + ez * (BD / 2 + 0.08), Math.min(0.5, BL * 0.4), 0.022, 0.16, ex, ez, WSCALE.ROOF_FLAT, true, true);
  boardText(D, bx + ex * (BD / 2 + 0.016), base + Math.min(H - 0.08, 0.4), bz + ez * (BD / 2 + 0.016), ex, ez, Math.min(0.7, BL * 0.45), 0.05, s.color);
}

/** The modern station: a glass hall under a cantilevered slab roof with a company colour fascia. */
function modernHall(s: StationScene, p: BuildingPose, base: number, lo: number, floors: number) {
  const W = s.ctx.w, D = s.ctx.d, fac = s.ctx.fac;
  const { bx, bz, ex, ez, BL, BD } = p;
  const rx = ez, rz = -ex;
  const H = floors === 1 ? 0.38 : 0.62;
  W.use(WC.CONCRETE, 0xa9a59d, 1);
  W.tbox(bx, lo, bz, BL + 0.04, base - lo, BD + 0.04, ex, ez, WSCALE.CONCRETE);
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.GLASS, FC.LOBBY, 0xffffff, s.seed, { door: FC.LOBBY, floorH: H / floors });
  const RW = BL + 0.26, RD = BD + 0.34, cx = bx + ex * 0.06, cz = bz + ez * 0.06;
  W.use(WC.PLAIN, s.color, 1);
  W.tbox(cx, base + H, cz, RW, 0.05, RD, ex, ez, 1, true, false);
  W.use(WC.ROOF_FLAT, 0x8e979d, 1);
  flatQuad(W, cx, base + H + 0.05, cz, ex, ez, -RW / 2, RW / 2, -RD / 2, RD / 2);
  // steel columns under the front overhang
  W.use(WC.METAL, 0x3a4046, 1);
  for (const sg of [-1, 1]) {
    const x = cx + rx * sg * (RW / 2 - 0.04) + ex * (RD / 2 - 0.04), z = cz + rz * sg * (RW / 2 - 0.04) + ez * (RD / 2 - 0.04);
    W.box(x, base, z, 0.03, H, 0.03, ex, ez);
  }
  boardText(D, cx + ex * (RD / 2 + 0.004), base + H + 0.025, cz + ez * (RD / 2 + 0.004), ex, ez, Math.min(0.9, RW * 0.5), 0.034, s.color);
}

/** A halt's shelter: glass back and side screens, a slab roof on posts, a bench, a name board, a ticket machine. */
function shelterHut(s: StationScene, p: BuildingPose, base: number, lo: number, _floors: number) {
  const W = s.ctx.w, D = s.ctx.d;
  const { bx, bz, ex, ez, BL, BD } = p;
  const rx = ez, rz = -ex;
  const H = 0.3;
  W.use(WC.PAVING, 0xcfcac0, 0);
  W.tbox(bx, lo, bz, BL + 0.1, base + 0.01 - lo, BD + 0.1, ex, ez, PS);
  // back screen on the street side, side screens; open towards the platforms
  const back = (a: number): [number, number] => [bx + ex * (BD / 2 - 0.02) + rx * a, bz + ez * (BD / 2 - 0.02) + rz * a];
  D.use(WC.PLAIN, 0x9fb8c6);
  { const [qx, qz] = back(0); D.box(qx, base + 0.03, qz, BL - 0.04, H - 0.05, 0.012, ex, ez); }
  for (const sg of [-1, 1]) D.box(bx + rx * sg * (BL / 2 - 0.02), base + 0.03, bz + rz * sg * (BL / 2 - 0.02), 0.012, H - 0.05, BD - 0.06, ex, ez);
  D.use(WC.METAL, 0x2e4636);
  for (const sa of [-1, 1]) for (const sb of [-1, 1]) {
    const x = bx + rx * sa * (BL / 2 - 0.02) + ex * sb * (BD / 2 - 0.02), z = bz + rz * sa * (BL / 2 - 0.02) + ez * sb * (BD / 2 - 0.02);
    D.box(x, base, z, 0.022, H, 0.022, ex, ez);
  }
  W.use(WC.ROOF_FLAT, 0x6a7176, 1);
  W.tbox(bx, base + H, bz, BL + 0.12, 0.03, BD + 0.14, ex, ez, WSCALE.ROOF_FLAT, true, true);
  W.use(WC.PLAIN, s.color, 1);
  W.box(bx, base + H - 0.012, bz, BL + 0.125, 0.014, BD + 0.145, ex, ez, false);
  D.use(WC.PLAIN, 0x6d533a);
  { const [qx, qz] = back(-0.0); D.box(qx - ex * 0.08, base + 0.07, qz - ez * 0.08, BL * 0.7, 0.012, 0.07, ex, ez, false); }
  D.use(WC.LAMP, 0xfff1c8);
  D.box(bx, base + H - 0.02, bz, 0.08, 0.01, 0.05, ex, ez, true);
  s.ctx.lights.push(bx, base + H - 0.04, bz);
  // name boards on the roof edge (both faces) and a ticket machine at a corner
  boardText(D, bx - ex * (BD / 2 + 0.075), base + H + 0.015, bz - ez * (BD / 2 + 0.075), -ex, -ez, Math.min(0.6, BL * 0.6), 0.04, s.color);
  boardText(D, bx + ex * (BD / 2 + 0.075), base + H + 0.015, bz + ez * (BD / 2 + 0.075), ex, ez, Math.min(0.6, BL * 0.6), 0.04, s.color);
  ticketMachine(D, bx + rx * (BL / 2 + 0.07), base, bz + rz * (BL / 2 + 0.07), ex, ez, s.color);
}

/** No building: a paved ramp pad at a platform end with a ticket machine and a name sign, a path to the street. */
function noneGround(s: StationScene) {
  const { ctx, r } = s;
  const W = ctx.w, D = ctx.d;
  const p = buildingPose(r);
  const { bx, bz, ex, ez, BL, BD } = p;
  const rx = ez, rz = -ex;
  const g = ctx.drape ? ctx.drape.ground(bx, bz) : s.y;
  W.use(WC.PAVING, 0xcfcac0, 0);
  if (ctx.drape) drapeBox(W, ctx.drape, bx, bz, BL, BD, ex, ez, -0.03, 0.03, PS);
  else W.tbox(bx, s.y - 0.08, bz, BL, 0.11, BD, ex, ez, PS);
  const top = g + 0.03;
  ticketMachine(D, bx + rx * (BL / 2 - 0.08) + ex * (BD / 2 - 0.06), top, bz + rz * (BL / 2 - 0.08) + ez * (BD / 2 - 0.06), ex, ez, s.color);
  // name sign on two posts
  const sx = bx - rx * (BL / 2 - 0.12), sz = bz - rz * (BL / 2 - 0.12);
  D.use(WC.METAL, 0x50565b);
  for (const o of [-0.08, 0.08]) D.cylinder(sx + rx * o, top, sz + rz * o, 0.006, 0.28, 4);
  boardText(D, sx, top + 0.22, sz, ex, ez, 0.22, 0.055, s.color);
  boardText(D, sx, top + 0.22, sz, -ex, -ez, 0.22, 0.055, s.color);
  // the underpass starts here when trains run between the pad and a platform
  if (r.platforms.length >= 2 || r.tracks + (r.through ?? 0) >= 2) stairWell(W, D, bx, top, bz, ex, ez, Math.min(0.2, BL - 0.4), Math.min(0.36, BD - 0.1), 0.06);
  forecourts(s, top - 0.004);
}

/**
 * A concourse across the tracks (bridge station): a glazed deck over the tracks with a two-storey pavilion on
 * each side (entrances, forecourts on both sides) and stair enclosures down to every platform.
 */
function concourseGround(s: StationScene) {
  const { ctx, r, width, PY } = s;
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const b = r.building, CP = CONCOURSE_PAVILION;
  const along0 = stationLocal(r, b.x, b.z).along;
  const pose = stationPose(r, 0, along0), fx = pose.fx, fz = pose.fz, rx = fz, rz = -fx;
  const bw = Math.max(1.2, b.w);
  const FL = s.y + 1.12, TOP = s.y + 1.7;
  const [cx, cz] = s.at(0, along0);
  // the deck over the tracks
  W.use(WC.CONCRETE, 0xb9b5ad, 1);
  W.tbox(cx, FL - 0.1, cz, width + 0.02, 0.1, bw, fx, fz, WSCALE.CONCRETE, true, false);
  W.use(WC.PLAIN, s.color, 1);
  for (const sg of [-1, 1]) W.box(cx + fx * sg * (bw / 2 + 0.004), FL - 0.07, cz + fz * sg * (bw / 2 + 0.004), width, 0.035, 0.008, fx, fz, false);
  fac.boxWalls(cx, FL, cz, width, bw, TOP - FL, fx, fz, FC.GLASS, -1, 0xffffff, s.seed, { floorH: TOP - FL });
  roofFlat(W, cx, TOP, cz, width + 0.04, bw + 0.04, fx, fz, 0x8c8a86);
  // pavilions: street level up to the concourse, entrances on the outer faces
  for (const sd of [-1, 1]) {
    const [px, pz] = s.at(sd * (width / 2 + CP / 2), along0);
    const [hi, lo] = groundRange(ctx, px, pz, fx, fz, CP, bw);
    const g = Math.max(hi, s.y) + 0.02;
    W.use(WC.CONCRETE, 0xa9a59d, 1);
    W.tbox(px, lo - 0.06, pz, CP + 0.04, g - (lo - 0.06), bw + 0.04, fx, fz, WSCALE.CONCRETE);
    fac.boxWalls(px, g, pz, bw, CP, TOP - g, rx * sd, rz * sd, FC.GLASS, FC.LOBBY, 0xffffff, s.seed + 1 + sd, { door: FC.LOBBY, floorH: Math.max(0.3, (TOP - g) / 3) });
    roofFlat(W, px, TOP, pz, bw + 0.04, CP + 0.04, rx * sd, rz * sd, 0x8c8a86);
    W.use(WC.PLAIN, s.color, 1);
    W.box(px, TOP - 0.05, pz, CP + 0.05, 0.05, bw + 0.05, fx, fz, false);
    const [nx, nz] = s.at(sd * (width / 2 + CP + 0.012), along0);
    boardText(D, nx, TOP - 0.14, nz, rx * sd, rz * sd, Math.min(1.0, bw * 0.6), 0.07, s.color);
  }
  // stair enclosures down to each platform
  for (const p of r.platforms) {
    const sw = Math.min(0.28, p.w - 0.16);
    if (sw < 0.12) continue;
    const [qx, qz] = s.at(p.off, along0 - Math.min(0.25, bw / 2 - 0.4));
    fac.boxWalls(qx, PY, qz, sw + 0.06, 0.6, FL - 0.1 - PY, fx, fz, FC.GLASS, -1, 0xffffff, s.seed + 5, { floorH: FL - 0.1 - PY, skipFront: true });
    darkRoom(W, qx, qz, fx, fz, sw + 0.02, 0.56, PY, FL - 0.11);
    stairUp(W, qx, PY, qz, fx, fz, sw, 0.5, FL - 0.1 - PY);
  }
  forecourts(s, s.y + 0.024);
}

/** Elevated concourse station: the concourse hall beneath the viaduct deck, entrances towards the forecourt. */
function concourseUnderDeck(s: StationScene) {
  const { ctx, r, fx, fz, rx, rz } = s;
  if (!r.forecourt) return;
  const b = r.building;
  if (!inChunk(ctx, b.x, b.z)) return;
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const across = b.d, along = b.w;
  const [hi, lo] = groundRange(ctx, b.x, b.z, fx, fz, across, along);
  const g = hi + 0.03, bot = r.y - 0.25;
  const Hh = Math.min(0.42, bot - g - 0.04);
  if (Hh < 0.2) return;
  // front towards the forecourt
  const sd = ((r.forecourt.x - b.x) * rx + (r.forecourt.z - b.z) * rz) >= 0 ? 1 : -1;
  const ex = rx * sd, ez = rz * sd;
  W.use(WC.CONCRETE, 0xa9a59d, 1);
  W.tbox(b.x, lo - 0.06, b.z, along + 0.04, g - (lo - 0.06), across + 0.04, ex, ez, WSCALE.CONCRETE);
  fac.boxWalls(b.x, g, b.z, along, across, Hh, ex, ez, FC.GLASS, FC.LOBBY, 0xffffff, s.seed + 9, { door: FC.LOBBY, floorH: Hh, sideGround: FC.LOBBY });
  roofFlat(W, b.x, g + Hh, b.z, along + 0.04, across + 0.04, ex, ez, 0x8c8a86);
  W.use(WC.PLAIN, s.color, 1);
  W.box(b.x, g + Hh - 0.045, b.z, along + 0.05, 0.045, across + 0.05, ex, ez, false);
  boardText(D, b.x + ex * (across / 2 + 0.012), g + Hh - 0.1, b.z + ez * (across / 2 + 0.012), ex, ez, Math.min(1.0, along * 0.5), 0.06, s.color);
  forecourts(s, g - 0.004);
}

/**
 * Terminal: a grand head building across the buffer end (clock tower, slate roof), a concourse joining the
 * platform ends to it, and a train shed (arched roof on columns) over the platforms.
 */
function terminalGround(s: StationScene) {
  const { ctx, r, fx, fz, width, PY, L, headEnd } = s;
  const W = ctx.w, D = ctx.d, fac = ctx.fac;
  const p = buildingPose(r);
  const { bx, bz, ex, ez, BL, BD } = p;
  const base = PY - 0.004;
  const lo = Math.min(lowestUnder(ctx.game.world, bx, bz, Math.atan2(ex, ez), BL, BD) - 0.06, base - 0.1);
  const H = 0.95;
  W.use(WC.STONE, 0xa89e8c, 1);
  W.tbox(bx, lo, bz, BL + 0.05, base - lo, BD + 0.05, ex, ez, WSCALE.STONE);
  fac.boxWalls(bx, base, bz, BL, BD, H, ex, ez, FC.STATION, -1, 0xffffff, s.seed, { door: FC.TOWN_DOOR, floorH: H / 2 });
  roofHip(W, bx, base + H, bz, BL + 0.14, BD + 0.14, Math.min(BL, BD) * 0.2, ex, ez, 0x56606a, WC.ROOF_SLATE);
  W.use(WC.PLAIN, s.color, 1);
  W.box(bx, base + H - 0.07, bz, BL + 0.03, 0.07, BD + 0.03, ex, ez);
  boardText(D, bx + ex * (BD / 2 + 0.018), base + H - 0.035, bz + ez * (BD / 2 + 0.018), ex, ez, Math.min(1.6, BL * 0.45), 0.065, s.color);
  // clock tower over the front
  const tx = bx + ex * (BD / 2 - 0.3), tz = bz + ez * (BD / 2 - 0.3), TH = 0.75;
  fac.boxWalls(tx, base + H, tz, 0.46, 0.46, TH, ex, ez, FC.STATION, -1, 0xffffff, s.seed + 4, { floorH: TH / 2 });
  roofHip(W, tx, base + H + TH, tz, 0.54, 0.54, 0.42, ex, ez, 0x3f6b5c, WC.ROOF_SLATE);
  clockFace(D, tx + ex * 0.235, base + H + TH - 0.18, tz + ez * 0.235, ex, ez, 0.11);
  // the head concourse between the platform ends and the building
  const inner = (bx - r.x) * fx + (bz - r.z) * fz - headEnd * BD / 2;
  const a0 = headEnd * L / 2;
  const gap = Math.abs(inner - a0);
  if (gap > 0.01) {
    const [mx, mz] = s.at(0, (a0 + inner) / 2);
    W.use(WC.PLATFORM, 0xd2cec6, 0);
    W.tbox(mx, s.y - 0.1, mz, width + 0.3, PY - (s.y - 0.1), gap + 0.02, fx, fz, WSCALE.PLATFORM, false, true);
  }
  trainShed(s, inner, Math.min(L * 0.72, L - 0.6));
  forecourts(s, s.y + 0.024);
}

/** Arched train shed over the track area from the head building (`from`, along the axis) `len` outwards. */
function trainShed(s: StationScene, from: number, len: number) {
  const { ctx, fx, fz, rx, rz, width, PY, headEnd } = s;
  const W = ctx.w, D = ctx.d;
  const span = width + 0.36, half = span / 2;
  const ys = PY + 0.62, rise = Math.min(0.9, span * 0.3);
  const a1 = from, a0 = from - headEnd * len;
  const K = 12;
  const arch = (t: number): [number, number] => [-half + span * t, ys + rise * Math.sqrt(Math.max(0, 1 - (2 * t - 1) * (2 * t - 1)))];
  const P = (l: number, h: number, a: number): [number, number, number] => { const [x, z] = s.at(l, a); return [x, h, z]; };
  // roof: glazed bands between metal ones; an outer and an inner (dark) surface
  for (let k = 0; k < K; k++) {
    const [l0, h0] = arch(k / K), [l1, h1] = arch((k + 1) / K);
    const glass = k % 3 === 1;
    const p00 = P(l0, h0, a0), p01 = P(l1, h1, a0), p10 = P(l0, h0, a1), p11 = P(l1, h1, a1);
    const nl = -(h1 - h0), nh = l1 - l0, nn = Math.hypot(nl, nh) || 1;
    const nx = (rx * nl) / nn, ny = nh / nn, nz = (rz * nl) / nn;
    W.use(glass ? WC.PLAIN : WC.ROOF_FLAT, glass ? 0x8fa7b4 : 0x6b747a, 1);
    W.ttri(...p00, 0, 0, ...p01, 1, 0, ...p11, 1, 1, nx, ny, nz);
    W.ttri(...p00, 0, 0, ...p11, 1, 1, ...p10, 0, 1, nx, ny, nz);
    W.use(WC.PLAIN, glass ? 0x5b6e79 : 0x3d4448, 1);
    W.ttri(...p00, 0, 0, ...p11, 1, 1, ...p01, 1, 0, -nx, -ny, -nz);
    W.ttri(...p00, 0, 0, ...p10, 0, 1, ...p11, 1, 1, -nx, -ny, -nz);
  }
  // arched ribs, columns along both sides, eaves beams
  const n = Math.max(2, Math.round(len / 0.9));
  for (let i = 0; i <= n; i++) {
    const a = a1 - headEnd * (len * i) / n;
    for (let k = 0; k < K; k++) {
      const [l0, h0] = arch(k / K), [l1, h1] = arch((k + 1) / K);
      const q0 = P(l0, h0 - 0.045, a), q1 = P(l1, h1 - 0.045, a), q2 = P(l1, h1 - 0.005, a), q3 = P(l0, h0 - 0.005, a);
      D.use(WC.METAL, 0x4a5258);
      D.ttri(...q0, 0, 0, ...q1, 0, 0, ...q2, 0, 0, fx, 0, fz);
      D.ttri(...q0, 0, 0, ...q2, 0, 0, ...q3, 0, 0, fx, 0, fz);
      D.ttri(...q0, 0, 0, ...q2, 0, 0, ...q1, 0, 0, -fx, 0, -fz);
      D.ttri(...q0, 0, 0, ...q3, 0, 0, ...q2, 0, 0, -fx, 0, -fz);
    }
    for (const sg of [-1, 1]) {
      const [cx, cz] = s.at(sg * (half - 0.03), a);
      D.use(WC.METAL, 0x4a5258);
      D.box(cx, PY - 0.1, cz, 0.045, ys - PY + 0.1, 0.045, fx, fz);
    }
    if (i % 2 === 0) { const [lx, lz] = s.at(0, a); ctx.lights.push(lx, ys - 0.1, lz); }
  }
  W.use(WC.METAL, 0x4a5258, 1);
  for (const sg of [-1, 1]) {
    const [ex, ez] = s.at(sg * (half - 0.03), (a0 + a1) / 2);
    W.box(ex, ys - 0.05, ez, 0.06, 0.06, len, fx, fz);
  }
  // a company colour band round the open end
  W.use(WC.PLAIN, s.color, 1);
  for (let k = 0; k < K; k++) {
    const [l0, h0] = arch(k / K), [l1, h1] = arch((k + 1) / K);
    const q0 = P(l0, h0 - 0.06, a0), q1 = P(l1, h1 - 0.06, a0), q2 = P(l1, h1 + 0.01, a0), q3 = P(l0, h0 + 0.01, a0);
    W.ttri(...q0, 0, 0, ...q1, 0, 0, ...q2, 0, 0, -fx * headEnd, 0, -fz * headEnd);
    W.ttri(...q0, 0, 0, ...q2, 0, 0, ...q3, 0, 0, -fx * headEnd, 0, -fz * headEnd);
  }
}

/** A ticket machine (company colour, dark screen) facing (fx,fz). */
function ticketMachine(D: WB, x: number, y: number, z: number, fx: number, fz: number, color: number) {
  D.use(WC.PLAIN, color);
  D.box(x, y, z, 0.07, 0.13, 0.045, fx, fz);
  D.use(WC.PLAIN, 0x1c2328);
  D.box(x + fx * 0.023, y + 0.075, z + fz * 0.023, 0.045, 0.035, 0.002, fx, fz, false);
}

/** A round clock face facing (nx,nz). */
function clockFace(D: WB, x: number, y: number, z: number, nx: number, nz: number, R: number) {
  const ux = -nz, uz = nx;
  const SEG = 12;
  D.use(WC.PLAIN, 0xf3efe2, 0);
  for (let k = 0; k < SEG; k++) {
    const a0 = (k / SEG) * Math.PI * 2, a1 = ((k + 1) / SEG) * Math.PI * 2;
    D.ttri(x + nx * 0.003, y, z + nz * 0.003, 0, 0,
      x + nx * 0.003 + ux * Math.cos(a0) * R, y + Math.sin(a0) * R, z + nz * 0.003 + uz * Math.cos(a0) * R, 0, 0,
      x + nx * 0.003 + ux * Math.cos(a1) * R, y + Math.sin(a1) * R, z + nz * 0.003 + uz * Math.cos(a1) * R, 0, 0, nx, 0, nz);
  }
  D.use(WC.PLAIN, 0x1d2124, 0);
  D.box(x + nx * 0.004, y - 0.004, z + nz * 0.004, 0.008, R * 0.6, 0.002, nx, nz, false);
  D.box(x + nx * 0.004 + ux * R * 0.2, y - 0.004, z + nz * 0.004 + uz * R * 0.2, R * 0.45, 0.008, 0.002, nx, nz, false);
}

/** Stairs rising from y to y + h inside an enclosure (seen through its open front): dark treads up into the dark. */
function stairUp(W: WB, cx: number, y: number, cz: number, fx: number, fz: number, sw: number, len: number, h: number) {
  const n = 7;
  for (let k = 0; k < n; k++) {
    const b = len / 2 - (k + 1) * (len / (n + 1));
    const g = Math.round(150 - k * 16);
    W.use(WC.CONCRETE, (g << 16) | (g << 8) | g, 0);
    flatQuad(W, cx, y + 0.004 + (h * 0.8 * (k + 1)) / n, cz, fx, fz, -sw / 2 + 0.01, sw / 2 - 0.01, b - len / (n + 1) * 0.5, b);
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

// ------------------------------------------------------------------------------ added entrances (ground stations)

/** Material of a ground station's added entrances: its building's (by era without one). */
type EntranceLook = 'classic' | 'brick' | 'modern';
function entranceLook(s: StationScene): EntranceLook {
  const id = s.sty.id;
  return id === 'brick' ? 'brick' : id === 'modern' || id === 'concourse' ? 'modern' : id === 'classic' || id === 'terminal' ? 'classic' : s.modern ? 'modern' : 'classic';
}

/** Lateral offset of a point from the station axis (right positive). */
const latOf = (s: StationScene, x: number, z: number) => stationLocal(s.r, x, z).off;

/**
 * Where an entrance's stairs go on a platform near `a` (along the axis): clear of the station's own underpass
 * stairs and footbridge (platformAccess) and of the platform ends; null when the platform does not reach there.
 */
function stairSpot(s: StationScene, p: RailPart['platforms'][number], a: number, len: number): number | null {
  const [a0, a1] = platRange(s.r, p);
  const lo = a0 + len / 2 + 0.15, hi = a1 - len / 2 - 0.15;
  if (hi < lo) return null;
  const own = stationCrossings(s.r), i = s.r.platforms.indexOf(p);
  const avoid = [...own.stairs.filter((q) => q.platform === i).map((q) => q.along), ...(own.footbridge !== null ? [own.footbridge + 0.15] : [])];
  let at = Math.max(lo, Math.min(hi, a));
  for (const v of avoid) if (Math.abs(at - v) < len / 2 + 0.3) at = at >= v ? v + len / 2 + 0.32 : v - len / 2 - 0.32;
  return at >= lo && at <= hi && Math.abs(at - a) < 1.2 ? at : null;
}

/** Underpass stairs down from every platform near `a` (painted wells with railings, as the station's own). */
function platformStairwells(s: StationScene, a: number) {
  for (const p of s.r.platforms) {
    const sw = Math.min(0.2, p.w - 0.34);
    if (sw < 0.1) continue;
    const at = stairSpot(s, p, a, 0.42);
    if (at === null) continue;
    const [ux, uz] = s.at(p.off, at);
    const pose = stationPose(s.r, p.off, at);
    stairWell(s.ctx.w, s.ctx.d, ux, s.r.alignment ? pose.y + PLATFORM_Y : s.PY, uz, pose.fx, pose.fz, sw, 0.42, 0.06);
  }
}

/** A name sign on two posts beside an entrance, facing ±(nx,nz). */
function entranceSign(s: StationScene, x: number, y: number, z: number, nx: number, nz: number) {
  const D = s.ctx.d;
  D.use(WC.METAL, 0x50565b);
  for (const o of [-0.07, 0.07]) D.cylinder(x - nz * o, y, z + nx * o, 0.006, 0.27, 4);
  boardText(D, x, y + 0.22, z, nx, nz, 0.2, 0.05, s.color);
  boardText(D, x, y + 0.22, z, -nx, -nz, 0.2, 0.05, s.color);
}

/**
 * A ground station's added entrance (see stations.ts EntranceKind): a side hall beside the platforms, a footbridge
 * with stair towers down to the street on each side, an underpass with stair pavilions, or a platform-end gate;
 * stairs onto every platform where it crosses the tracks.
 */
function groundEntrance(s: StationScene, e: Entrance) {
  const k = entranceKind('ground', e);
  const a = entranceAlong(s.r, e);
  if (s.r.alignment) { const p = stationPose(s.r, 0, a); s = { ...s, fx: p.fx, fz: p.fz, rx: p.fz, rz: -p.fx, y: p.y, PY: p.y + PLATFORM_Y }; }
  const seed = s.st.id * 53 + Math.round(Math.abs(e.x * 7 + e.z * 13));
  if (k === 'footbridge') footbridgeEntrance(s, e, a, seed);
  else if (k === 'underpass') { for (const p of entranceLandings(e)) subwayStairs(s, p); platformStairwells(s, a); }
  else if (k === 'gate') gateEntrance(s, e, a);
  else { sideHall(s, e, seed); platformStairwells(s, a); }
}

/** Side hall: a small booking hall in the station's material, its door towards the street, an underpass to the platforms. */
function sideHall(s: StationScene, e: Entrance, seed: number) {
  const { ctx } = s, W = ctx.w, D = ctx.d, fac = ctx.fac;
  const T = ENTRANCE_TYPES.hall, ex = Math.sin(e.angle), ez = Math.cos(e.angle), rx = ez, rz = -ex;
  const BL = T.w - 0.04, BD = T.d - 0.04, look = entranceLook(s);
  const [hi, lo] = groundRange(ctx, e.x, e.z, ex, ez, BL + 0.04, BD + 0.04);
  const yf = hi + 0.03, H = look === 'modern' ? 0.34 : 0.38;
  W.use(look === 'modern' ? WC.CONCRETE : WC.STONE, look === 'modern' ? 0xa9a59d : 0xb4aa98, 1);
  W.tbox(e.x, lo - 0.06, e.z, BL + 0.04, yf - (lo - 0.06), BD + 0.04, ex, ez, look === 'modern' ? WSCALE.CONCRETE : WSCALE.STONE);
  if (look === 'modern') {
    fac.boxWalls(e.x, yf, e.z, BL, BD, H, ex, ez, FC.GLASS, FC.LOBBY, 0xffffff, seed, { door: FC.LOBBY, floorH: H });
    // slab roof overhanging the front, company colour fascia with the name
    const RW = BL + 0.16, RD = BD + 0.26, cx = e.x + ex * 0.08, cz = e.z + ez * 0.08;
    W.use(WC.PLAIN, s.color, 1);
    W.tbox(cx, yf + H, cz, RW, 0.045, RD, ex, ez, 1, true, false);
    W.use(WC.ROOF_FLAT, 0x8e979d, 1);
    flatQuad(W, cx, yf + H + 0.045, cz, ex, ez, -RW / 2, RW / 2, -RD / 2, RD / 2);
    W.use(WC.METAL, 0x3a4046, 1);
    for (const sg of [-1, 1]) W.box(cx + rx * sg * (RW / 2 - 0.03) + ex * (RD / 2 - 0.03), yf, cz + rz * sg * (RW / 2 - 0.03) + ez * (RD / 2 - 0.03), 0.025, H, 0.025, ex, ez);
    boardText(D, cx + ex * (RD / 2 + 0.004), yf + H + 0.022, cz + ez * (RD / 2 + 0.004), ex, ez, Math.min(0.7, RW * 0.6), 0.03, s.color);
  } else {
    const brick = look === 'brick';
    fac.boxWalls(e.x, yf, e.z, BL, BD, H, ex, ez, brick ? FC.BRICK : FC.STATION, -1, 0xffffff, seed, { door: brick ? FC.BRICK_DOOR : FC.TOWN_DOOR, floorH: H });
    W.use(WC.PLAIN, s.color, 1);
    W.box(e.x, yf + H - 0.04, e.z, BL + 0.02, 0.04, BD + 0.02, ex, ez);
    if (brick) {
      const RH = Math.min(0.26, BD * 0.4);
      roofGable(W, e.x, yf + H, e.z, BL + 0.1, BD + 0.14, RH, ex, ez, 0x4c5157, false, WC.ROOF_SLATE);
      gableWalls(W, e.x, yf + H, e.z, BL, BD, RH - 0.01, ex, ez, 0x9b5a45, false);
    } else roofHip(W, e.x, yf + H, e.z, BL + 0.1, BD + 0.1, Math.min(BL, BD) * 0.3, ex, ez, 0x5a6066, WC.ROOF_SLATE);
    // porch over the door, the name above it
    W.use(WC.ROOF_FLAT, 0x5b5f63, 1);
    W.tbox(e.x + ex * (BD / 2 + 0.07), yf + 0.29, e.z + ez * (BD / 2 + 0.07), Math.min(0.42, BL * 0.4), 0.02, 0.14, ex, ez, WSCALE.ROOF_FLAT, true, true);
    boardText(D, e.x + ex * (BD / 2 + 0.014), yf + H - 0.075, e.z + ez * (BD / 2 + 0.014), ex, ez, Math.min(0.6, BL * 0.5), 0.045, s.color);
  }
  D.use(WC.LAMP, 0xfff1c8);
  D.box(e.x + ex * (BD / 2 + 0.02), yf + 0.27, e.z + ez * (BD / 2 + 0.02), 0.05, 0.01, 0.03, ex, ez, true);
  ctx.lights.push(e.x + ex * (BD / 2 + 0.05), yf + 0.26, e.z + ez * (BD / 2 + 0.05));
  ticketMachine(D, e.x + rx * (BL / 2 - 0.12) + ex * (BD / 2 + 0.05), yf, e.z + rz * (BL / 2 - 0.12) + ez * (BD / 2 + 0.05), ex, ez, s.color);
  frontPaving(ctx, [e.x + ex * BD / 2, e.z + ez * BD / 2], ex, ez, BL + 0.08, yf - 0.004, 0.3);
}

/**
 * Footbridge: a covered deck over the tracks at the platforms' footbridge height, stair towers down to the street at
 * its landings (one side or both), glazed stair enclosures down onto every platform it passes.
 */
function footbridgeEntrance(s: StationScene, e: Entrance, a: number, seed: number) {
  const { ctx, r, PY, fx, fz, rx, rz, width } = s, W = ctx.w, D = ctx.d, fac = ctx.fac;
  const T = ENTRANCE_TYPES.footbridge, look = entranceLook(s), modern = look === 'modern';
  const FY = PY + 0.62, WH = 0.22, DW = 0.32;
  const lands = entranceLandings(e), side = latOf(s, e.x, e.z) >= 0 ? 1 : -1;
  // the deck: from this tower's inner face to the far one's (or across the whole track area)
  const l0 = latOf(s, e.x, e.z) - side * (T.d / 2 - 0.02);
  // (one side only: the deck ends just past the farthest platform)
  const reachP = r.platforms.reduce((m, p) => Math.max(m, -side * p.off + p.w / 2), -Infinity);
  const l1 = e.far ? latOf(s, e.far.x, e.far.z) + side * (T.d / 2 - 0.02) : -side * Math.min(width / 2 + 0.06, Math.max(reachP + 0.05, -width / 2 + 0.3));
  const len = Math.abs(l1 - l0), [cx, cz] = s.at((l0 + l1) / 2, a);
  W.use(WC.CONCRETE, 0xa9b0b5, 1);
  W.tbox(cx, FY - 0.07, cz, DW, 0.07, len, rx, rz, WSCALE.CONCRETE, true, false);
  for (const sg of [-1, 1]) {
    const [p0x, p0z] = s.at(l0, a + sg * (DW / 2 - 0.01)), [p1x, p1z] = s.at(l1, a + sg * (DW / 2 - 0.01));
    fac.wall(p0x, p0z, p1x, p1z, FY, FY + WH, fx * sg, fz * sg, FC.GLASS, -1, 0xffffff, seed + 1, WH);
    fac.wall(p1x, p1z, p0x, p0z, FY, FY + WH, -fx * sg, -fz * sg, FC.GLASS, -1, 0xdfe6ea, seed + 2, WH);
  }
  W.use(WC.ROOF_FLAT, modern ? 0xc3c9cd : 0x7b848a, 1);
  W.tbox(cx, FY + WH, cz, DW + 0.05, 0.025, len + 0.03, rx, rz, WSCALE.ROOF_FLAT, true, true);
  W.use(WC.PLAIN, s.color, 1);
  for (const sg of [-1, 1]) { const [qx, qz] = s.at((l0 + l1) / 2, a + sg * (DW / 2 + 0.024)); W.box(qx, FY + WH - 0.03, qz, 0.008, 0.035, len + 0.03, rx, rz, false); }
  // stair enclosures down onto each platform beside the deck (towards the longer part of the platform)
  for (const p of r.platforms) {
    const sw = Math.min(0.26, p.w - 0.16);
    if (sw < 0.12) continue;
    const [a0, a1] = platRange(r, p);
    if (a < a0 + 0.2 || a > a1 - 0.2) continue;
    const dir = a1 - a >= a - a0 ? 1 : -1, c = a + dir * (DW / 2 + 0.29);
    if (c - 0.3 < a0 + 0.12 || c + 0.3 > a1 - 0.12) continue;
    const [qx, qz] = s.at(p.off, c), H = FY + WH - PY;
    fac.boxWalls(qx, PY, qz, sw + 0.06, 0.58, H, fx * dir, fz * dir, FC.GLASS, -1, 0xffffff, seed + 5, { floorH: H, skipFront: true });
    roofFlat(W, qx, PY + H, qz, sw + 0.1, 0.62, fx * dir, fz * dir, 0x8c8a86);
    darkRoom(W, qx, qz, fx * dir, fz * dir, sw + 0.02, 0.54, PY, PY + H - 0.01);
    stairUp(W, qx, PY, qz, fx * dir, fz * dir, sw, 0.5, FY - PY);
  }
  // stair towers at the landings: from the street up to the deck, door on the street side
  for (const p of lands) {
    const ex = Math.sin(p.angle), ez = Math.cos(p.angle);
    const SW = T.w - 0.03, [hi, lo] = groundRange(ctx, p.x, p.z, ex, ez, SW + 0.04, SW + 0.04), g = hi + 0.03, top = FY + WH + 0.06;
    W.use(modern ? WC.CONCRETE : WC.STONE, modern ? 0xa9a59d : 0xa8a090, 1);
    W.tbox(p.x, lo - 0.06, p.z, SW + 0.04, g - (lo - 0.06), SW + 0.04, ex, ez, modern ? WSCALE.CONCRETE : WSCALE.STONE, false, true);
    // (stone with windows as the station building's; brick; a glazed shaft from the 1960s)
    const door = modern ? FC.LOBBY : look === 'brick' ? FC.BRICK_DOOR : FC.TOWN_DOOR;
    fac.boxWalls(p.x, g, p.z, SW, SW, top - g, ex, ez, modern ? FC.GLASS : look === 'brick' ? FC.BRICK : FC.STATION, door, 0xffffff, seed + 7, { door, floorH: Math.max(0.3, (top - g) / Math.max(1, Math.round((top - g) / 0.32))) });
    roofFlat(W, p.x, top, p.z, SW + 0.04, SW + 0.04, ex, ez, 0x7c7a76);
    W.use(WC.PLAIN, s.color, 1);
    W.box(p.x, top - 0.05, p.z, SW + 0.012, 0.05, SW + 0.012, ex, ez, false);
    boardText(D, p.x + ex * (SW / 2 + 0.01), top - 0.12, p.z + ez * (SW / 2 + 0.01), ex, ez, SW * 0.8, 0.04, s.color);
    D.use(WC.LAMP, 0xfff1c8);
    D.box(p.x + ex * (SW / 2 + 0.02), g + 0.27, p.z + ez * (SW / 2 + 0.02), 0.05, 0.01, 0.03, ex, ez, true);
    ctx.lights.push(p.x + ex * (SW / 2 + 0.05), g + 0.26, p.z + ez * (SW / 2 + 0.05));
    frontPaving(ctx, [p.x + ex * SW / 2, p.z + ez * SW / 2], ex, ez, SW + 0.06, g - 0.004, 0.3);
  }
}

/** Underpass stairs at street level: a paved well going down towards the tracks, railings, a canopy (modern) and a name sign. */
function subwayStairs(s: StationScene, p: { x: number; z: number; angle: number }) {
  const { ctx } = s, W = ctx.w, D = ctx.d;
  const T = ENTRANCE_TYPES.underpass, ex = Math.sin(p.angle), ez = Math.cos(p.angle), rx = ez, rz = -ex;
  const PW = T.w, PD = T.d, modern = entranceLook(s) === 'modern';
  const [hi, lo] = groundRange(ctx, p.x, p.z, ex, ez, PW + 0.06, PD + 0.06);
  const g = hi + 0.025;
  W.use(WC.PAVING, 0xd6d0c4, 0);
  W.tbox(p.x, lo - 0.05, p.z, PW + 0.06, g - (lo - 0.05), PD + 0.06, ex, ez, WSCALE.PAVING, false, true);
  // the well: top step at the street side, down towards the tracks; low walls round it
  const sw = PW - 0.2, sl = PD - 0.2;
  stairWell(W, D, p.x, g, p.z, ex, ez, sw, sl, 0);
  W.use(WC.STONE, modern ? 0xb3afa6 : 0xa8a090, 1);
  for (const sg of [-1, 1]) W.tbox(p.x + rx * sg * (sw / 2 + 0.03), g, p.z + rz * sg * (sw / 2 + 0.03), 0.05, 0.08, sl + 0.06, ex, ez, WSCALE.STONE);
  W.tbox(p.x - ex * (sl / 2 + 0.03), g, p.z - ez * (sl / 2 + 0.03), sw + 0.11, 0.08, 0.05, ex, ez, WSCALE.STONE);
  D.use(WC.METAL, modern ? 0x8a9298 : 0x2f3438);
  for (const sg of [-1, 1]) D.box(p.x + rx * sg * (sw / 2 + 0.03), g + 0.08, p.z + rz * sg * (sw / 2 + 0.03), 0.01, 0.06, sl + 0.04, ex, ez);
  if (modern) {
    // glass canopy on four posts, company colour fascia
    const CH = 0.3;
    D.use(WC.METAL, 0x3a4046);
    for (const [u, v] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) D.box(p.x + rx * u * (PW / 2 - 0.03) + ex * v * (PD / 2 - 0.05), g, p.z + rz * u * (PW / 2 - 0.03) + ez * v * (PD / 2 - 0.05), 0.018, CH, 0.018, ex, ez);
    W.use(WC.PLAIN, 0x9fb8c6, 1);
    W.tbox(p.x, g + CH, p.z, PW + 0.04, 0.015, PD + 0.02, ex, ez, 1, true, true);
    W.use(WC.PLAIN, s.color, 1);
    W.box(p.x, g + CH - 0.03, p.z, PW + 0.046, 0.03, PD + 0.026, ex, ez, false);
    boardText(D, p.x + ex * (PD / 2 + 0.016), g + CH + 0.003, p.z + ez * (PD / 2 + 0.016), ex, ez, PW * 0.7, 0.024, s.color);
  } else {
    // a lamp post with the name board at the front corner
    const lx = p.x + rx * (PW / 2 + 0.02) + ex * (PD / 2 - 0.04), lz = p.z + rz * (PW / 2 + 0.02) + ez * (PD / 2 - 0.04);
    D.use(WC.METAL, 0x2f3438);
    D.cylinder(lx, g, lz, 0.01, 0.42, 6);
    D.use(WC.LAMP, 0xfff1c8);
    D.box(lx, g + 0.42, lz, 0.05, 0.04, 0.05, ex, ez, true);
    ctx.lights.push(lx, g + 0.42, lz);
    boardText(D, lx + ex * 0.012, g + 0.3, lz + ez * 0.012, ex, ez, 0.22, 0.05, s.color);
  }
  frontPaving(ctx, [p.x + ex * PD / 2, p.z + ez * PD / 2], ex, ez, PW + 0.06, g - 0.004, 0.3);
}

/**
 * Platform-end gate: a paved pad beside the platform end with a gate, ticket machine and name sign; a path onto the
 * platform beside it, else an underpass to the platforms (tracks lie in between).
 */
function gateEntrance(s: StationScene, e: Entrance, a: number) {
  const { ctx, r, width } = s, W = ctx.w, D = ctx.d;
  const T = ENTRANCE_TYPES.gate, ex = Math.sin(e.angle), ez = Math.cos(e.angle), rx = ez, rz = -ex;
  const PW = T.w, PD = T.d, side = latOf(s, e.x, e.z) >= 0 ? 1 : -1;
  const [hi, lo] = groundRange(ctx, e.x, e.z, ex, ez, PW + 0.04, PD + 0.04);
  const g = hi + 0.03;
  W.use(WC.PAVING, 0xcfcac0, 0);
  W.tbox(e.x, lo - 0.05, e.z, PW, g - (lo - 0.05), PD, ex, ez, WSCALE.PAVING, false, true);
  // a platform along this side of the track area: a path across to it, else the underpass starts here
  const edge = r.platforms.find((p) => (p.off + side * p.w / 2) * side >= width / 2 - 0.35 && (a >= platRange(r, p)[0] - 0.2 && a <= platRange(r, p)[1] + 0.2));
  if (edge) {
    // a path from the pad across to the foot of the platform's end ramp
    const outer = edge.off + side * edge.w / 2, inner = latOf(s, e.x, e.z) - side * PD / 2;
    const end = (a >= 0 ? 1 : -1) * (r.length / 2 - 0.13);
    const [cx, cz] = s.at((outer + inner) / 2, end), base = Math.min(lo, r.y) - 0.05;
    W.use(WC.PAVING, 0xd2cec6, 0);
    W.tbox(cx, base, cz, 0.16, g - base, Math.abs(inner - outer) + 0.04, s.rx, s.rz, WSCALE.PAVING, false, true);
  } else {
    stairWell(W, D, e.x - ex * 0.04, g, e.z - ez * 0.04, ex, ez, Math.min(0.2, PW - 0.4), Math.min(0.3, PD - 0.12), 0.06);
    platformStairwells(s, a);
  }
  // gate posts and a low fence along the track side (open towards the platform end where a path leads on), a
  // ticket machine, the name sign
  D.use(WC.METAL, 0x40464b);
  const fy = g;
  for (const sg of [-1, 1]) D.box(e.x + rx * sg * (PW / 2 - 0.03) + ex * (PD / 2 - 0.03), fy, e.z + rz * sg * (PW / 2 - 0.03) + ez * (PD / 2 - 0.03), 0.03, 0.16, 0.03, ex, ez);
  // (the pad's own right (rx,rz) runs along the tracks: towards the platform end where it is the axis' end side)
  const toEnd = (rx * s.fx + rz * s.fz) * (a >= 0 ? 1 : -1) >= 0 ? 1 : -1, fw = edge ? PW / 2 - 0.02 : PW - 0.04;
  const fc = edge ? -toEnd * (PW / 4 - 0.01) : 0;
  for (const h of [0.08, 0.04]) D.box(e.x - ex * (PD / 2 - 0.02) + rx * fc, fy + h, e.z - ez * (PD / 2 - 0.02) + rz * fc, fw, 0.012, 0.008, ex, ez);
  ticketMachine(D, e.x + rx * (PW / 2 - 0.1) + ex * (PD / 2 - 0.1), fy, e.z + rz * (PW / 2 - 0.1) + ez * (PD / 2 - 0.1), ex, ez, s.color);
  entranceSign(s, e.x - rx * (PW / 2 - 0.12) + ex * (PD / 2 - 0.08), fy, e.z - rz * (PW / 2 - 0.12) + ez * (PD / 2 - 0.08), ex, ez);
  frontPaving(ctx, [e.x + ex * PD / 2, e.z + ez * PD / 2], ex, ez, PW + 0.04, g - 0.004, 0.3);
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
  if (ctx.drape) drapeBox(W, ctx.drape, qx, qz, width, depth, fx, fz, -0.03, 0.022, WSCALE.PAVING);
  else W.tbox(qx, fl - 0.05, qz, width, top - (fl - 0.05), depth, fx, fz, WSCALE.PAVING, false, true);
  return depth;
}

// ------------------------------------------------------------------------------ elevated stations

/**
 * Elevated station: one wide viaduct deck carrying the tracks (their per-edge bridges are not built) and
 * the platforms with canopies; parapets, name boards on the fascia, column piers clear of the streets and
 * buildings below; stair / lift towers with a ground-floor entrance hall at the entrances.
 */
function elevatedStation(ctx: ChunkCtx, st: Station, r: RailPartX, color: number, canopyKind: CanopyKind = 'classic') {
  const W = ctx.w, D = ctx.d;
  const fx = Math.sin(r.angle), fz = Math.cos(r.angle), rx = fz, rz = -fx;
  const L = r.length;
  const width = railWidth(r);
  const half = width / 2 + 0.16;
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
      const edgePlat = r.platforms.some((p) => Math.abs(p.off * sg + p.w / 2 - width / 2) < 0.35 && p.off * sg > 0);
      const pt = edgePlat ? PY + 0.11 : top + 0.12;
      const [px, pz] = at(sg * (half - 0.02), 0);
      W.use(WC.CONCRETE, 0xc4c0b8, 1);
      W.tbox(px, top, pz, 0.04, pt - top, L + 0.1, fx, fz, WSCALE.CONCRETE, false, true);
      if (edgePlat) {
        // walkway between the platform edge and the parapet
        const [wx, wz] = at(sg * (width / 2 + 0.07), 0);
        W.use(WC.PLATFORM, 0xd2cec6, 0);
        W.tbox(wx, top, wz, 0.14, PY - top, L - 0.2, fx, fz, WSCALE.PLATFORM, false, true);
      }
    }
    platformsAndCanopies(ctx, r, color, canopyKind, 0);
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
  const local = stationLocal(r, en.x, en.z), pose = stationPose(r, 0, local.along);
  const fx = pose.fx, fz = pose.fz, rx = fz, rz = -fx;
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
  const lat = local.off, al = local.along;
  const under = Math.abs(lat) < half + 0.12 && Math.abs(al) < r.length / 2 + 0.05;
  const SW = 0.32;
  const sx = en.x - efx * 0.05, sz = en.z - efz * 0.05;
  if (under) {
    // shaft up to the deck, a stair head on the platform above
    fac.boxWalls(sx, g + HH, sz, SW, SW, Math.max(0.05, bot - (g + HH)), fx, fz, FC.CONCRETE_PLAIN, -1, 0xd6d2ca, seed + 1, { floorH: 0.3 });
    const pl = r.platforms.find((p) => Math.abs(lat - p.off) < p.w / 2);
    if (pl) {
      const pt = stationPose(r, pl.off, al), kx = pt.x, kz = pt.z;
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
  const target = stationPose(r, sg * half, alc), tx = target.x, tz = target.z;
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
  if (d.level === 'underground') { undergroundDepot(ctx, d, color); return; }
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
    if (ctx.drape) drapeBox(W, ctx.drape, d.x + fx * (sz.d / 2 + 0.16), d.z + fz * (sz.d / 2 + 0.16), sz.w, 0.32, fx, fz, -0.03, -0.006, WSCALE.CONCRETE);
    else W.tbox(d.x + fx * (sz.d / 2 + 0.16), y - 0.06, d.z + fz * (sz.d / 2 + 0.16), sz.w, 0.048, 0.32, fx, fz, WSCALE.CONCRETE);
  }
}


/**
 * Underground depot: nothing at street level but its ventilation grilles and a small staff access house (stairs and
 * a lift down to the cavern), where they fit between the streets and buildings above.
 */
function undergroundDepot(ctx: ChunkCtx, d: Depot, color: number) {
  const W = ctx.w;
  const sz = depotSize(d.kind);
  const fx = Math.sin(d.angle), fz = Math.cos(d.angle), rx = fz, rz = -fx;
  const fits = (x: number, z: number, w: number, dd: number, margin: number) => {
    if (!clearOfNetwork(ctx, x, z, margin + Math.max(w, dd) / 2) || !clearOfBuildings(ctx, x, z, margin + Math.max(w, dd) / 2)) return null;
    const [hi, lo] = groundRange(ctx, x, z, fx, fz, w, dd);
    return lo < WATER_Y + 0.05 || hi - lo > 0.25 ? null : [hi, lo] as [number, number];
  };
  // ventilation grilles over the cavern
  for (const a of [-sz.d * 0.3, sz.d * 0.3]) {
    const x = d.x + fx * a, z = d.z + fz * a;
    const g = fits(x, z, 0.3, 0.5, 0.15);
    if (!g) continue;
    const [hi, lo] = g;
    W.use(WC.CONCRETE, 0xb3afa6, 0);
    W.tbox(x, lo - 0.04, z, 0.3, hi + 0.03 - (lo - 0.04), 0.5, fx, fz, WSCALE.CONCRETE, false, true);
    W.use(WC.METAL, 0x2b2e30, 0);
    flatQuad(W, x, hi + 0.032, z, fx, fz, -0.11, 0.11, -0.2, 0.2);
    W.use(WC.METAL, 0x5d6266, 0);
    for (let k = -3; k <= 3; k++) flatQuad(W, x, hi + 0.033, z, fx, fz, -0.11, 0.11, k * 0.055 - 0.006, k * 0.055 + 0.006);
  }
  // the access house: over the cavern's inner end, else beside it (the first spot with room; all drawn by the chunk
  // that owns the depot)
  const BW = 0.5, BD = 0.6, H = 0.42;
  for (const [a, l] of [[-sz.d * 0.32, 0], [0, 0], [-sz.d * 0.32, sz.w * 0.75], [-sz.d * 0.32, -sz.w * 0.75], [sz.d * 0.1, sz.w * 0.75], [sz.d * 0.1, -sz.w * 0.75]]) {
    const x = d.x + fx * a + rx * l, z = d.z + fz * a + rz * l;
    const g = fits(x, z, BW, BD, 0.2);
    if (!g) continue;
    const [hi, lo] = g, yf = hi + 0.03;
    W.use(WC.CONCRETE, 0xa8a49b, 1);
    W.tbox(x, lo - 0.06, z, BW + 0.04, yf - (lo - 0.06), BD + 0.04, fx, fz, WSCALE.CONCRETE, false, true);
    ctx.fac.boxWalls(x, yf, z, BW, BD, H, fx, fz, FC.BRICK_PLAIN, FC.BRICK_PLAIN, 0xffffff, d.id * 13 + 7, { frontCell: FC.GARAGE });
    roofFlat(W, x, yf + H, z, BW, BD, fx, fz, 0x8b8880);
    W.use(WC.PLAIN, color, 1);
    W.box(x + fx * (BD / 2 + 0.006), yf + H - 0.1, z + fz * (BD / 2 + 0.006), BW, 0.06, 0.012, fx, fz, false);
    W.use(WC.METAL, 0x5d6266, 0);
    W.box(x, yf + H, z - 0, 0.18, 0.1, 0.18, fx, fz);
    break;
  }
}

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
      if (ctx.drape) {
        const dv = (q: [number, number], u: number, vv: number) => ({ x: q[0], z: q[1], u, v: vv, h: -0.004, w: 0, py: 0 });
        ctx.drape.quad(W, dv(c[0], 0.01, 0), dv(c[1], 0.99, 0), dv(c[2], 0.99, v), dv(c[3], 0.01, v));
      } else {
        W.ttri(c[0][0], yb, c[0][1], 0.01, 0, c[1][0], yb, c[1][1], 0.99, 0, c[2][0], yb, c[2][1], 0.99, v, 0, 1, 0);
        W.ttri(c[0][0], yb, c[0][1], 0.01, 0, c[2][0], yb, c[2][1], 0.99, v, c[3][0], yb, c[3][1], 0.01, v, 0, 1, 0);
      }
    }
  }
  gableWalls(W, d.x, y - 0.02 + H, d.z, sz.w, sz.d, 0.3, fx, fz, 0x9a5a42, true);
  roofGable(W, d.x, y - 0.03 + H, d.z, sz.w + 0.12, sz.d + 0.1, 0.32, fx, fz, 0x5d646a, true, WC.ROOF_SLATE);
  W.use(WC.METAL, 0x8fb0c0, 1);
  W.box(d.x, y + H + 0.24, d.z, 0.14, 0.1, sz.d * 0.75, fx, fz);
  // concrete apron in front of the doors (the real tracks and wires are the stub edge's)
  W.use(WC.CONCRETE, 0xb5b2aa, 0);
  if (ctx.drape) drapeBox(W, ctx.drape, d.x + fx * (sz.d / 2 + 0.3), d.z + fz * (sz.d / 2 + 0.3), sz.w, 0.6, fx, fz, -0.03, -0.006, WSCALE.CONCRETE);
  else W.tbox(d.x + fx * (sz.d / 2 + 0.3), y - 0.06, d.z + fz * (sz.d / 2 + 0.3), sz.w, 0.048, 0.6, fx, fz, WSCALE.CONCRETE);
}
