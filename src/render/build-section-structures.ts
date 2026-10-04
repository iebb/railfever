// One saved civil envelope per span, independently of member edge splits or the chunk's selected edge.
import type { RailSection, RailStructure, RailAlignment } from '../game/rail-section-types';
import { formationAt } from '../game/rail-structures';
import { ChunkCtx, Smp, PP, sweep, inChunk } from './build-common';
import { WC, WSCALE } from './textures';
import type { Keepout } from './build-structures';

/** Chunk clipping uses the same reference samples on both sides of every border. */
export function formationRuns(ctx: Pick<ChunkCtx, 'x0' | 'z0' | 'x1' | 'z1'>, a: RailAlignment, u0: number, u1: number): Smp[][] {
  const cuts = [u0, u1];
  for (const piece of a.pieces) {
    if (piece.u0 > u0 && piece.u0 < u1) cuts.push(piece.u0);
    const n = Math.max(1, Math.ceil((piece.u1 - piece.u0) / 0.5));
    for (let i = 0; i <= n; i++) { const u = piece.u0 + (piece.u1 - piece.u0) * i / n; if (u > u0 && u < u1) cuts.push(u); }
  }
  cuts.sort((a, b) => a - b);
  const pts = [...new Set(cuts)].map((u) => formationAt(a, u)), out: Smp[][] = [];
  let run: Smp[] | null = null;
  for (let i = 1; i < pts.length; i++) {
    const p = pts[i - 1], q = pts[i], dx = q.x - p.x, dz = q.z - p.z;
    let lo = 0, hi = 1;
    for (const [v, delta, min, max] of [[p.x, dx, ctx.x0, ctx.x1], [p.z, dz, ctx.z0, ctx.z1]]) {
      if (Math.abs(delta) < 1e-12) { if (v < min || v >= max) hi = -1; }
      else { const t0 = (min - v) / delta, t1 = (max - v) / delta; lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1)); }
    }
    if (hi <= lo + 1e-9) { run = null; continue; }
    const sample = (t: number): Smp => {
      const point = {} as Smp;
      for (const key of ['s', 'x', 'y', 'z', 'tx', 'tz', 'lx', 'lz'] as const) point[key] = p[key] + (q[key] - p[key]) * t;
      const len = Math.hypot(point.tx, point.tz) || 1; point.tx /= len; point.tz /= len; point.lx = -point.tz; point.lz = point.tx;
      return point;
    };
    const first = sample(lo), last = sample(hi);
    if (!run || Math.abs(run.at(-1)!.s - first.s) > 1e-6) { run = [first]; out.push(run); }
    run.push(last); if (hi < 1 - 1e-9) run = null;
  }
  return out;
}

/** Stable render leader is the structure ID; no member edge owns the deck, supports or portals. */
export function buildSectionStructures(ctx: ChunkCtx) {
  for (const st of ctx.game.railSections.structuresNear(ctx.x0 - 1, ctx.z0 - 1, ctx.x1 + 1, ctx.z1 + 1)) {
    const section = ctx.game.railSections.get(st.section)!;
    const runs = formationRuns(ctx, section.alignment, st.u0, st.u1), W = ctx.w;
    W.cast = st.type === 'bridge' ? 1 : 0;
    W.use(WC.CONCRETE, 0xc9c5bc);
    if (st.type === 'bridge') {
      const top = -0.05, bottom = -st.clearance.below, lo = st.lo, hi = st.hi;
      const profile: PP[] = [[lo, bottom], [lo, top + 0.11], [lo + 0.025, top + 0.11], [lo + 0.025, top], [hi - 0.025, top], [hi - 0.025, top + 0.11], [hi, top + 0.11], [hi, bottom], [lo, bottom]];
      for (const run of runs) sweep(W, run, profile.map(([l, h]) => [l, h, (l + h) / WSCALE.CONCRETE]), WSCALE.CONCRETE);
      for (const support of st.supports) {
        const p = formationAt(section.alignment, support.u, support.offset);
        if (!inChunk(ctx, p.x, p.z)) continue;
        const gy = ctx.game.world.heightAt(p.x, p.z), base = gy - 0.4, yb = p.y - st.clearance.below;
        W.use(WC.CONCRETE, 0xaaa59c);
        const width = support.kind === 'pier' ? Math.min(0.38, (hi - lo) * 0.35) : hi - lo;
        W.tbox(p.x, base, p.z, width, Math.max(0.1, yb - base), 0.25, p.tx, p.tz, WSCALE.CONCRETE);
        W.use(WC.CONCRETE, 0xc9c5bc);
        W.tbox(p.x, yb - 0.09, p.z, hi - lo - 0.04, 0.09, 0.35, p.tx, p.tz, WSCALE.CONCRETE, true);
      }
    } else {
      // Continuous lining and floor; the terrain hides buried stretches, including underground terminals.
      const lo = st.lo, hi = st.hi, top = st.clearance.above;
      for (const run of runs) {
        sweep(W, run, [[lo, -0.2], [lo, top], [hi, top], [hi, -0.2], [hi - 0.1, -0.2], [hi - 0.1, top - 0.14], [lo + 0.1, top - 0.14], [lo + 0.1, -0.2]]);
        W.use(WC.CONCRETE, 0x777976); sweep(W, run, [[lo + 0.1, -0.08], [hi - 0.1, -0.08]]); W.use(WC.CONCRETE, 0xc9c5bc);
      }
      for (const end of [0, 1] as const) if (st.portals[end]) portal(ctx, section, st, end);
    }
  }
}

function portal(ctx: ChunkCtx, section: RailSection, st: RailStructure, end: 0 | 1) {
  const u = end ? st.u1 : st.u0, p = formationAt(section.alignment, u), W = ctx.w;
  if (!inChunk(ctx, p.x, p.z)) return;
  const mid = (st.lo + st.hi) / 2, top = st.clearance.above;
  W.cast = 1; W.use(WC.CONCRETE, 0xc9c5bc);
  for (const off of [st.lo, st.hi]) W.tbox(p.x + p.lx * off, p.y - 0.15, p.z + p.lz * off, 0.24, top + 0.35, 0.3, p.tx, p.tz, WSCALE.CONCRETE);
  W.tbox(p.x + p.lx * mid, p.y + top - 0.12, p.z + p.lz * mid, st.hi - st.lo + 0.35, 0.28, 0.36, p.tx, p.tz, WSCALE.CONCRETE, true);
  W.use(WC.PLAIN, 0x07080a);
  const inward = end ? -1 : 1;
  W.tbox(p.x + p.lx * mid + p.tx * inward * 0.55, p.y - 0.08, p.z + p.lz * mid + p.tz * inward * 0.55, st.hi - st.lo - 0.2, top - 0.1, 0.025, p.tx, p.tz, 1);
}

export function sectionPortalKeepouts(ctx: ChunkCtx, out: Keepout[]) {
  for (const st of ctx.game.railSections.structuresNear(ctx.x0 - 8, ctx.z0 - 8, ctx.x1 + 8, ctx.z1 + 8)) {
    if (st.type !== 'tunnel') continue;
    const s = ctx.game.railSections.get(st.section)!;
    for (const end of [0, 1] as const) if (st.portals[end]) {
      const p = formationAt(s.alignment, end ? st.u1 : st.u0), dir = end ? 1 : -1;
      out.push({ x: p.x, z: p.z, ox: p.tx * dir, oz: p.tz * dir, lx: p.lx, lz: p.lz, f0: -1.2, f1: 2.3, l0: st.lo - 1.4, l1: st.hi + 1.4 });
    }
  }
}
