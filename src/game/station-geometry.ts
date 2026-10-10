// Station surfaces follow their physical rail, including bends and unequal track arc lengths.
// Geometry is saved as ordinary numbers; arc tables are disposable and do not affect decisions.
import { arcTable, bezPoint, bezDeriv, tAtS } from './geom';
import type { Bez, ArcTable } from './geom';
import { PSTEP } from './constants';
import type { Rect } from './stations';

export interface RailTrackStep { edge: number; dir: 1 | -1 }
export interface RailTrackGroup {
  /** Stable physical-track identity, initially its first committed edge id. */
  id: number;
  through: boolean;
  offset: number;
  /** Ordered back to front; split callbacks preserve this order and id. */
  steps: RailTrackStep[];
  back: number; front: number;
  length: number;
}
export interface RailGeometryPiece { curve: Bez; length: number; profile: number[] }
export interface RailGeometryTrack {
  offset: number;
  pieces: RailGeometryPiece[];
  length: number;
  /** Reference arc coordinate -> this track's actual arc coordinate. */
  knots: { u: number; s: number }[];
}
export interface RailStationAlignment { tracks: RailGeometryTrack[] }
export interface StationGeometry {
  x: number; z: number; y: number; angle: number; length: number;
  alignment?: RailStationAlignment;
}

/** Facility platform length: inherited curved tracks use real arcs; legacy tariff remains exactly unchanged. */
export function stationPlatformLength(r: StationGeometry & { tracks: number; trackOffsets: number[] }): number {
  return r.alignment ? r.alignment.tracks.filter((t) => r.trackOffsets.includes(t.offset)).reduce((n, t) => n + t.length, 0) : r.tracks * r.length;
}
export interface StationPose { x: number; z: number; y: number; fx: number; fz: number; angle: number }

const tables = new WeakMap<RailGeometryPiece, ArcTable>();
function table(p: RailGeometryPiece) {
  let t = tables.get(p);
  if (!t) { t = arcTable(p.curve); tables.set(p, t); }
  return t;
}

/** True point/tangent at a physical track's arc coordinate. */
export function railGeometryPoint(track: RailGeometryTrack, s: number): StationPose {
  s = Math.max(0, Math.min(track.length, s));
  let p = track.pieces[track.pieces.length - 1];
  for (const q of track.pieces) {
    p = q;
    if (s <= q.length) break;
    s -= q.length;
  }
  const tab = table(p), u = tAtS(tab, s * tab.len / Math.max(1e-9, p.length));
  const pos = bezPoint(p.curve, u), d = bezDeriv(p.curve, u), l = Math.hypot(d.x, d.z) || 1;
  const i = Math.min(p.profile.length - 1, Math.floor(s / PSTEP)), j = Math.min(p.profile.length - 1, i + 1);
  const f = Math.max(0, Math.min(1, (s - i * PSTEP) / Math.max(1e-9, Math.min(p.length, j * PSTEP) - i * PSTEP)));
  return { x: pos.x, z: pos.z, y: p.profile[i] + (p.profile[j] - p.profile[i]) * f, fx: d.x / l, fz: d.z / l, angle: Math.atan2(d.x, d.z) };
}

function physicalArc(track: RailGeometryTrack, u: number): number {
  const k = track.knots;
  if (!k.length) return u;
  if (u <= k[0].u) return k[0].s;
  for (let i = 1; i < k.length; i++) if (u <= k[i].u) {
    const a = k[i - 1], b = k[i];
    return a.s + (b.s - a.s) * (u - a.u) / Math.max(1e-9, b.u - a.u);
  }
  return k[k.length - 1].s;
}

/** Local right offset and reference distance from the station centre; old straight parts keep their frame. */
export function stationPose(r: StationGeometry, off = 0, along = 0): StationPose {
  const tracks = r.alignment?.tracks;
  if (!tracks?.length) {
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
    return { x: r.x + fz * off + fx * along, z: r.z - fx * off + fz * along, y: r.y, fx, fz, angle: r.angle };
  }
  let track = tracks[0];
  for (const t of tracks) if (Math.abs(t.offset - off) < Math.abs(track.offset - off)) track = t;
  const u = Math.max(0, Math.min(r.length, along + r.length / 2));
  const p = railGeometryPoint(track, physicalArc(track, u));
  const beyond = along + r.length / 2 - u;
  p.x += p.fx * beyond; p.z += p.fz * beyond;
  const delta = off - track.offset;
  return { ...p, x: p.x + p.fz * delta, z: p.z - p.fx * delta };
}

interface CoarseProjection {
  track: RailGeometryTrack | undefined; pieces: RailGeometryPiece[]; inputs: number[]; xy: Float64Array;
}
const projections = new WeakMap<StationGeometry, CoarseProjection>();

/** Every mutable input used by stationPose's zero-offset XY grid; profiles affect only its unused Y. */
function projectionInputs(r: StationGeometry, track: RailGeometryTrack | undefined, visit: (value: number) => void) {
  visit(r.length);
  if (!track) { visit(r.x); visit(r.y); visit(r.z); visit(r.angle); return; }
  visit(track.offset); visit(track.length); visit(track.pieces.length);
  for (const p of track.pieces) {
    const c = p.curve;
    visit(p.length); visit(c.x0); visit(c.z0); visit(c.x1); visit(c.z1);
    visit(c.x2); visit(c.z2); visit(c.x3); visit(c.z3);
  }
  visit(track.knots.length);
  for (const k of track.knots) { visit(k.u); visit(k.s); }
}

function projectionSamples(r: StationGeometry, n: number): Float64Array {
  const tracks = r.alignment?.tracks;
  let track = tracks?.[0];
  if (track) for (const t of tracks!) if (Math.abs(t.offset - 0) < Math.abs(track.offset - 0)) track = t;
  const old = projections.get(r);
  let same = !!old && old.track === track && old.pieces.length === (track?.pieces.length ?? 0)
    && old.pieces.every((p, i) => p === track!.pieces[i]);
  let at = 0;
  if (same) {
    projectionInputs(r, track, value => { if (!Object.is(old!.inputs[at++], value)) same = false; });
    same &&= at === old!.inputs.length;
  }
  if (same) return old!.xy;
  const inputs: number[] = []; projectionInputs(r, track, value => inputs.push(value));
  const xy = new Float64Array((n + 1) * 2);
  for (let i = 0; i <= n; i++) {
    const a = -r.length / 2 + r.length * i / n, p = stationPose(r, 0, a);
    xy[i * 2] = p.x; xy[i * 2 + 1] = p.z;
  }
  projections.set(r, { track, pieces: track?.pieces.slice() ?? [], inputs, xy });
  return xy;
}

/** Closest reference coordinate and local offset (entrance attachment and picking). */
export function stationLocal(r: StationGeometry, x: number, z: number): { along: number; off: number } {
  if (!r.alignment) {
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
    return { along: (x - r.x) * fx + (z - r.z) * fz, off: (x - r.x) * fz - (z - r.z) * fx };
  }
  let best = Infinity, along = 0;
  const n = Math.max(1, Math.ceil(r.length / 0.25));
  const xy = projectionSamples(r, n);
  for (let i = 0; i <= n; i++) {
    const a = -r.length / 2 + r.length * i / n;
    const d = (x - xy[i * 2]) ** 2 + (z - xy[i * 2 + 1]) ** 2;
    if (d < best) { best = d; along = a; }
  }
  // Refine inside the sampled interval, then preserve longitudinal distance beyond either terminus.
  let lo = Math.max(-r.length / 2, along - r.length / n), hi = Math.min(r.length / 2, along + r.length / n);
  const dist = (a: number) => { const p = stationPose(r, 0, a); return (x - p.x) ** 2 + (z - p.z) ** 2; };
  for (let i = 0; i < 16; i++) { const a = (2 * lo + hi) / 3, b = (lo + 2 * hi) / 3; if (dist(a) < dist(b)) hi = b; else lo = a; }
  along = (lo + hi) / 2;
  const p = stationPose(r, 0, along), tangent = (x - p.x) * p.fx + (z - p.z) * p.fz;
  if (along < -r.length / 2 + 0.001 && tangent < 0 || along > r.length / 2 - 0.001 && tangent > 0) along += tangent;
  return { along, off: (x - p.x) * p.fz - (z - p.z) * p.fx };
}

/** Conservative small rectangles covering the actual swept strip; no tangent-line substitute over a bend. */
export function stationStripRects(r: StationGeometry, off: number, width: number, from = -r.length / 2, to = r.length / 2): Rect[] {
  if (!r.alignment) {
    const p = stationPose(r, off, (from + to) / 2);
    return [{ x: p.x, z: p.z, angle: p.angle, w: width, d: to - from }];
  }
  const out: Rect[] = [], n = Math.max(1, Math.ceil((to - from) / 0.4));
  for (let i = 0; i < n; i++) {
    const a = from + (to - from) * i / n, b = from + (to - from) * (i + 1) / n;
    const p = stationPose(r, off, a), q = stationPose(r, off, b), m = stationPose(r, off, (a + b) / 2);
    const angle = Math.atan2(q.x - p.x, q.z - p.z), d = Math.hypot(q.x - p.x, q.z - p.z);
    const sag = Math.hypot(m.x - (p.x + q.x) / 2, m.z - (p.z + q.z) / 2);
    out.push({ x: (p.x + q.x) / 2, z: (p.z + q.z) / 2, angle, w: width + 2 * sag + 0.012, d: d + 0.012 });
  }
  return out;
}

/** Samples for curved paving, decks, coping, canopies and screen doors. */
export function stationStripSamples(r: StationGeometry, off: number, from: number, to: number, step = 0.35): StationPose[] {
  const n = Math.max(1, Math.ceil((to - from) / step));
  return Array.from({ length: n + 1 }, (_, i) => stationPose(r, off, from + (to - from) * i / n));
}
