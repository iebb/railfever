// Retaining walls beside rail and road formations. The planner grades a flat formation with earthwork slopes
// beside it, but stops a slope at buildings, other formations and water; the 1-unit terrain grid then shows a
// steep face right beside the formation. Where the ground within reach of the formation edge rises (cut) or
// drops (fill) more steeply than an earthwork slope, a wall stands at the low side of that face, up to the high
// ground, with a coping (and a parapet on fills); the ground it retains is laid over the steep face at the top
// level, and the wall's ends are closed. Concrete with formwork panels in towns and from the 1950s, dressed
// stone in the country before that.
import type { NEdge } from '../game/network';
import { ChunkCtx, sampleAt, Smp, EARTHWORK_TINT } from './build-common';
import { WC, WSCALE } from './textures';

const STEP = 0.5;
/** steeper than any graded earthwork slope (rail 1:2, road 1:1.5, rounded) */
const STEEP = 1.1;
/** smallest step worth a wall, tallest wall drawn */
const MIN_RISE = 0.22, MAX_RISE = 3;
const LAT = 0.15;

/** A wall at one sample on one side: wall line and far edge of the retained ground (lateral), foot and top. */
interface WallAt { cut: boolean; dWall: number; dFar: number; top: number }

export function buildRetainingWalls(ctx: ChunkCtx, e: NEdge) {
  const w = ctx.game.world, net = w.net;
  if (e.station >= 0 || e.depot >= 0) return;
  const g = net.geo(e);
  const hw = net.halfWidth(e) + (e.kind === 'rail' ? 0.15 : 0.05);
  // ground stretches clear of bridges, tunnels and busy junctions (abutments, portals and plates own those)
  const blocked: [number, number][] = e.sections.map((q) => [q.s0 - 1.2, q.s1 + 1.2]);
  for (const [nid, s] of [[e.a, 0], [e.b, e.len]] as [number, number][]) {
    const node = net.nodes.get(nid);
    if (!node) continue;
    if (node.edges.length >= 3 || node.edges.some((id) => { const f = net.edges.get(id); return !!f && f !== e && f.sections.length > 0; })) {
      const r = e.kind === 'road' ? net.junctionRadius(nid) + 1.2 : 1.2;
      blocked.push([s - r, s + r]);
    }
  }
  const x0 = ctx.x0 - 3 - 2 * STEP, x1 = ctx.x1 + 3 + 2 * STEP, z0 = ctx.z0 - 3 - 2 * STEP, z1 = ctx.z1 + 3 + 2 * STEP;
  const n = Math.max(1, Math.round(e.len / STEP));
  const S: (Smp | null)[] = [];
  let any = false;
  for (let i = 0; i <= n; i++) {
    const s = (e.len * i) / n;
    const p = sampleAt(g, s);
    const ok = p.x >= x0 && p.x <= x1 && p.z >= z0 && p.z <= z1 && !blocked.some(([a, b]) => s > a && s < b);
    S.push(ok ? p : null);
    if (ok) any = true;
  }
  if (!any) return;
  const town = e.kind === 'road' ? e.owner < 0 : false;
  const concrete = town || ctx.game.year >= 1950 || w.buildingsNear((ctx.x0 + ctx.x1) / 2, (ctx.z0 + ctx.z1) / 2, 18).length > 6;
  for (const sg of [-1, 1]) {
    const A: (WallAt | null)[] = S.map((p) => (p ? scan(ctx, p, sg, hw) : null));
    smooth(A);
    emit(ctx, S, A, sg, concrete);
  }
}

/** Terrain profile beside the formation at a sample: the steep step next to it, if any. */
function scan(ctx: ChunkCtx, p: Smp, sg: number, hw: number): WallAt | null {
  const w = ctx.game.world;
  const lx = p.lx * sg, lz = p.lz * sg;
  const h = (d: number) => w.heightAt(p.x + lx * d, p.z + lz * d);
  const base = h(hw);
  // quick test: nothing far from the formation level within reach
  const q1 = h(hw + 1.2) - base, q2 = h(hw + 2.6) - base;
  if (Math.abs(q1) < MIN_RISE && Math.abs(q2) < MIN_RISE) return null;
  // the first steep stretch outwards
  let prev = base, d = hw, start = -1, sign = 0;
  const end = hw + 3.2;
  let k0 = 0, k1 = 0, h0 = 0, h1 = 0;
  for (let dd = hw + LAT; dd <= end + 1e-6; dd += LAT) {
    const hh = h(dd);
    const sl = (hh - prev) / LAT;
    if (start < 0) {
      if (Math.abs(sl) > STEEP && dd <= hw + 2.4) { start = d; sign = Math.sign(sl); k0 = d; h0 = prev; k1 = dd; h1 = hh; }
    } else {
      if (Math.sign(sl) === sign && Math.abs(sl) > 0.5) { k1 = dd; h1 = hh; } else break;
    }
    prev = hh; d = dd;
  }
  if (start < 0) return null;
  const rise = h1 - h0;
  if (Math.abs(rise) < MIN_RISE || Math.abs(rise) > MAX_RISE) return null;
  if (rise > 0) return { cut: true, dWall: k0, dFar: k1, top: h1 };
  // a fill: not where the low ground is another formation (that one's cut wall is drawn from below)
  const lockAt = (dist: number) => {
    const x = Math.round(p.x + lx * dist), z = Math.round(p.z + lz * dist);
    if (x < 0 || z < 0 || x > w.size || z > w.size) return 0;
    return w.lock[z * (w.size + 1) + x];
  };
  if (lockAt(k1 + 0.4) & 1) return null;
  return { cut: false, dWall: k1, dFar: k0, top: h0 };
}

/**
 * Even out the wall line along a run (the steep faces follow the terrain grid): cuts keep the wall at the
 * nearest foot and the retained ground to the farthest crest of their neighbours, fills the other way round.
 */
function smooth(A: (WallAt | null)[]) {
  const out = A.map((a) => (a ? { ...a } : null));
  for (let i = 0; i < A.length; i++) {
    const a = A[i];
    if (!a) continue;
    for (let j = Math.max(0, i - 2); j <= Math.min(A.length - 1, i + 2); j++) {
      const b = A[j];
      if (!b || b.cut !== a.cut) continue;
      const o = out[i]!;
      if (a.cut) { o.dWall = Math.min(o.dWall, b.dWall); o.dFar = Math.max(o.dFar, b.dFar); }
      else { o.dWall = Math.max(o.dWall, b.dWall); o.dFar = Math.min(o.dFar, b.dFar); }
    }
  }
  // lone samples make no wall
  for (let i = 0; i < A.length; i++) {
    const o = out[i];
    if (!o) continue;
    const prev = i > 0 ? out[i - 1] : null, next = i + 1 < out.length ? out[i + 1] : null;
    if (!(prev && prev.cut === o.cut) && !(next && next.cut === o.cut)) out[i] = null;
  }
  for (let i = 0; i < A.length; i++) A[i] = out[i];
}

function emit(ctx: ChunkCtx, S: (Smp | null)[], A: (WallAt | null)[], sg: number, concrete: boolean) {
  const W = ctx.w, w = ctx.game.world;
  const cell = concrete ? WC.CONCRETE : WC.STONE, sc = concrete ? WSCALE.CONCRETE : WSCALE.STONE;
  const tone = concrete ? 0xc2bdb3 : 0xb9ad98, dark = concrete ? 0xa29e95 : 0x968a77;
  const mine = (x: number, z: number) => x >= ctx.x0 && x < ctx.x1 && z >= ctx.z0 && z < ctx.z1;
  const pt = (p: Smp, d: number): [number, number] => [p.x + p.lx * sg * d, p.z + p.lz * sg * d];
  const T = 0.1, CW = 0.15, CH = 0.035;
  W.cast = 1;
  for (let i = 0; i + 1 < S.length; i++) {
    const pa = S[i], pb = S[i + 1], a = A[i], b = A[i + 1];
    if (!pa || !pb || !a || !b || a.cut !== b.cut) continue;
    const [wax, waz] = pt(pa, a.dWall), [wbx, wbz] = pt(pb, b.dWall);
    if (!mine((wax + wbx) / 2, (waz + wbz) / 2)) continue;
    const [fax, faz] = pt(pa, a.dFar), [fbx, fbz] = pt(pb, b.dFar);
    // the face looks towards the low side: the track for cuts, away from it for fills
    const fs = a.cut ? -1 : 1;
    const nx = (pa.lx + pb.lx) / 2 * sg * fs, nz = (pa.lz + pb.lz) / 2 * sg * fs;
    // the foot: the ground just in front of the face (the low side)
    const footA = w.heightAt(wax + nx * 0.05, waz + nz * 0.05) - 0.08, footB = w.heightAt(wbx + nx * 0.05, wbz + nz * 0.05) - 0.08;
    const ta = Math.max(a.top, footA + 0.15), tb = Math.max(b.top, footB + 0.15);
    W.use(cell, tone, 1);
    W.twall(wax, waz, wbx, wbz, Math.min(footA, ta - 0.1), ta, Math.min(footB, tb - 0.1), tb, nx, nz, sc, i * STEP);
    // the retained ground over the steep face, at the top level (from the wall's back to the far edge)
    const bax = wax - nx * T, baz = waz - nz * T, bbx = wbx - nx * T, bbz = wbz - nz * T;
    W.use(WC.GRASS, EARTHWORK_TINT, 0);
    const gs = WSCALE.GRASS;
    W.ttri(bax, ta + 0.004, baz, bax / gs, baz / gs, bbx, tb + 0.004, bbz, bbx / gs, bbz / gs, fbx, tb + 0.004, fbz, fbx / gs, fbz / gs, 0, 1, 0);
    W.ttri(bax, ta + 0.004, baz, bax / gs, baz / gs, fbx, tb + 0.004, fbz, fbx / gs, fbz / gs, fax, ta + 0.004, faz, fax / gs, faz / gs, 0, 1, 0);
    // coping (fills: a parapet above the top level)
    const ph = a.cut ? CH : 0.09;
    const lax = wax + nx * 0.025, laz = waz + nz * 0.025, lbx = wbx + nx * 0.025, lbz = wbz + nz * 0.025;
    const kax = wax - nx * (CW - 0.025), kaz = waz - nz * (CW - 0.025), kbx = wbx - nx * (CW - 0.025), kbz = wbz - nz * (CW - 0.025);
    W.use(cell, dark, 1);
    W.twall(lax, laz, lbx, lbz, ta - 0.02, ta + ph, tb - 0.02, tb + ph, nx, nz, sc, i * STEP);
    W.twall(kax, kaz, kbx, kbz, ta, ta + ph, tb, tb + ph, -nx, -nz, sc, i * STEP);
    W.ttri(lax, ta + ph, laz, 0, 0, lbx, tb + ph, lbz, STEP / sc, 0, kbx, tb + ph, kbz, STEP / sc, CW / sc, 0, 1, 0);
    W.ttri(lax, ta + ph, laz, 0, 0, kbx, tb + ph, kbz, STEP / sc, CW / sc, kax, ta + ph, kaz, 0, CW / sc, 0, 1, 0);
  }
  // end returns: close the retained ground where a wall run starts or ends
  for (let i = 0; i < S.length; i++) {
    const p = S[i], a = A[i];
    if (!p || !a) continue;
    const prevOn = i > 0 && A[i - 1] && S[i - 1] && A[i - 1]!.cut === a.cut;
    const nextOn = i + 1 < A.length && A[i + 1] && S[i + 1] && A[i + 1]!.cut === a.cut;
    if (prevOn && nextOn) continue;
    if (!prevOn && !nextOn) continue;
    const [wx, wz] = pt(p, a.dWall), [fx, fz] = pt(p, a.dFar);
    if (!mine(wx, wz)) continue;
    const dir = prevOn ? 1 : -1; // outwards along the edge
    const ox = p.tx * dir, oz = p.tz * dir;
    const fw = w.heightAt(wx, wz) - 0.08, ff = w.heightAt(fx, fz) - 0.08;
    W.use(cell, tone, 1);
    W.twall(wx, wz, fx, fz, Math.min(fw, a.top - 0.1), a.top + 0.004, Math.min(ff, a.top - 0.1), a.top + 0.004, ox, oz, sc);
  }
}
