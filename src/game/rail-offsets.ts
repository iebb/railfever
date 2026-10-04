// Pure parallel geometry and reference/physical distance correspondence. No game, graph or allocators.
import { arcTable, bezPoint, bezDeriv, bezOffset, bezSplit, bezMinRadius, tAtS, segIntersect, type Bez } from './geom';
import { PSTEP } from './constants';
import { SpatialGrid } from './spatial';
import { railUAtS, type RailAlignment, type RailAlignmentPiece, type RailKnot } from './rail-section-types';

export const RAIL_OFFSET_ERROR = 0.03;
const MAX_DEPTH = 10;
export interface RailOffsetPiece { bez: Bez; len: number; prof: Float32Array; u0: number; u1: number; knots: RailKnot[] }

export function sAtT(tab: ReturnType<typeof arcTable>, t: number): number {
  const ts = tab.t, ss = tab.s;
  let lo = 0, hi = ts.length - 1;
  while (hi - lo > 1) { const m = (hi + lo) >> 1; if (ts[m] <= t) lo = m; else hi = m; }
  return ss[lo] + (ss[hi] - ss[lo]) * (t - ts[lo]) / Math.max(1e-12, ts[hi] - ts[lo]);
}

/** Deterministic closest parameter; callers verify tangent, lateral error and monotonicity. */
export function closestRailT(b: Bez, x: number, z: number): number {
  const distance = (t: number) => { const p = bezPoint(b, t); return (p.x - x) ** 2 + (p.z - z) ** 2; };
  let best = 0, score = Infinity;
  for (let i = 0; i <= 32; i++) { const d = distance(i / 32); if (d < score) { score = d; best = i; } }
  let lo = Math.max(0, (best - 1) / 32), hi = Math.min(1, (best + 1) / 32);
  for (let i = 0; i < 32; i++) {
    const a = lo + (hi - lo) / 3, c = hi - (hi - lo) / 3;
    if (distance(a) <= distance(c)) hi = c; else lo = a;
  }
  const t = (lo + hi) / 2;
  if (distance(0) <= distance(t)) return 0;
  if (distance(1) <= distance(t)) return 1;
  return t;
}

export function alignmentHeight(a: RailAlignment, u: number): number {
  const p = a.pieces.find((p) => u <= p.u1 + 1e-8) ?? a.pieces[a.pieces.length - 1];
  const len = p.u1 - p.u0, s = Math.max(0, Math.min(len, u - p.u0));
  const i = Math.min(p.prof.length - 2, Math.floor(s / PSTEP));
  const f = (s - i * PSTEP) / Math.max(1e-12, Math.min(len, (i + 1) * PSTEP) - i * PSTEP);
  return p.prof[i] + (p.prof[i + 1] - p.prof[i]) * f;
}

function exactOffset(b: Bez, t: number, off: number) {
  const p = bezPoint(b, t), d = bezDeriv(b, t), l = Math.hypot(d.x, d.z);
  if (l < 1e-8) throw new Error('Folded alignment');
  return { x: p.x - d.z / l * off, z: p.z + d.x / l * off, tx: d.x / l, tz: d.z / l };
}

/** Ordered adaptive subdivision, <=0.03 lateral fit error, per-member radius/grade checks. */
export function offsetRailAlignment(a: RailAlignment, off: number, minRadius: number, maxGrade: number): RailOffsetPiece[] {
  if (!Number.isFinite(off) || !Number.isFinite(a.length) || a.length <= 0 || !a.pieces.length) throw new Error('Invalid alignment');
  const out: RailOffsetPiece[] = [];
  for (const piece of a.pieces) {
    const refTab = arcTable(piece.bez);
    const visit = (b: Bez, t0: number, t1: number, depth: number) => {
      const fit = bezOffset(b, off), tab = arcTable(fit), knots: RailKnot[] = [];
      let lastS = -Infinity, bad = false;
      const n = Math.max(32, Math.min(512, Math.ceil(tab.len / 0.5)));
      for (let i = 0; i <= n; i++) {
        const t = i / n, refT = t0 + (t1 - t0) * t;
        const p = exactOffset(piece.bez, refT, off);
        const ft = i === 0 ? 0 : i === n ? 1 : off === 0 ? t : closestRailT(fit, p.x, p.z);
        const q = bezPoint(fit, ft), d = bezDeriv(fit, ft), dl = Math.hypot(d.x, d.z);
        const s = sAtT(tab, ft);
        if (Math.hypot(q.x - p.x, q.z - p.z) > RAIL_OFFSET_ERROR || dl < 1e-8 || (d.x * p.tx + d.z * p.tz) / dl < 0.995 || s <= lastS) bad = true;
        // The true offset must continue forwards; a radius crossing folds its parameterization.
        const eps = 1e-5, l = Math.max(0, refT - eps), r = Math.min(1, refT + eps);
        const p0 = exactOffset(piece.bez, l, off), p1 = exactOffset(piece.bez, r, off);
        if ((p1.x - p0.x) * p.tx + (p1.z - p0.z) * p.tz <= 0) throw new Error('Folded offset');
        knots.push([piece.u0 + sAtT(refTab, refT), s]); lastS = s;
      }
      if (bad) {
        if (depth >= MAX_DEPTH || tab.len < 0.1) throw new Error('Offset fit failed');
        const [left, right] = bezSplit(b, 0.5), tm = (t0 + t1) / 2;
        visit(left, t0, tm, depth + 1); visit(right, tm, t1, depth + 1); return;
      }
      if (bezMinRadius(fit, 128) < minRadius - 1e-6) throw new Error('Inner radius too small');
      const u0 = knots[0][0], u1 = knots[knots.length - 1][0];
      const step = { edge: 0, dir: 1 as const, u0, u1, knots };
      const prof = new Float32Array(Math.max(2, Math.ceil(tab.len / PSTEP) + 1));
      for (let i = 0; i < prof.length; i++) prof[i] = alignmentHeight(a, railUAtS(step, Math.min(tab.len, i * PSTEP)));
      for (let i = 1; i < prof.length; i++) {
        const ds = Math.min(tab.len, i * PSTEP) - (i - 1) * PSTEP;
        if (Math.abs(prof[i] - prof[i - 1]) / ds > maxGrade + 1e-6) throw new Error('Member grade too steep');
      }
      out.push({ bez: fit, len: tab.len, prof, u0, u1, knots });
    };
    visit(piece.bez, 0, 1, 0);
  }
  // Sampled non-adjacent intersections also catch folds across piece boundaries.
  const pts: { x: number; z: number }[] = [];
  for (const p of out) {
    const n = Math.max(8, Math.ceil(p.len / 0.25));
    for (let i = pts.length ? 1 : 0; i <= n; i++) pts.push(bezPoint(p.bez, i / n));
  }
  const grid = new SpatialGrid(4);
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], bounds = [Math.min(a.x, b.x), Math.min(a.z, b.z), Math.max(a.x, b.x), Math.max(a.z, b.z)] as const;
    for (const j of grid.query(...bounds)) if (j < i - 1 && segIntersect(a.x, a.z, b.x, b.z, pts[j - 1].x, pts[j - 1].z, pts[j].x, pts[j].z)) throw new Error('Self-intersecting offset');
    grid.insert(i, ...bounds);
  }
  return out;
}

export function alignmentOf(bez: Bez, prof: ArrayLike<number>): RailAlignment {
  const length = arcTable(bez).len;
  const piece: RailAlignmentPiece = { u0: 0, u1: length, bez: { ...bez }, prof: Array.from(prof) };
  return { length, pieces: [piece] };
}
