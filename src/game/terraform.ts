// Earthworks along network edges, formation locks and terraform brushes.
import type { World } from './world';
import type { NEdge } from './network';
import { WATER_Y } from './constants';

/** Depth of the formation (terrain surface) below the edge's running height. */
export function formationDepth(e: NEdge) { return e.kind === 'rail' ? 0.1 : 0.04; }

interface Stamp { d: number; target: number; core: number; ext: number }

/** Collect the per-vertex earthwork targets for the ground sections of an edge. */
function stampEdge(w: World, e: NEdge, out: Map<number, Stamp>, coreOnly = false) {
  const net = w.net;
  const g = net.geo(e);
  const hw = net.halfWidth(e);
  const core = hw + 0.45;
  const fd = formationDepth(e);
  const s1 = w.size + 1;
  const tunnels = e.sections.filter((sec) => sec.type === 'tunnel');
  let lastS = -1;
  for (let i = 0; i < g.n; i++) {
    const s = g.cum[i];
    if (i > 0 && i < g.n - 1 && s - lastS < 0.45) continue;
    lastS = s;
    if (net.sectionAt(e, s) !== 'ground') continue;
    const px = g.pts[i * 3], py = g.pts[i * 3 + 1], pz = g.pts[i * 3 + 2];
    const tx = g.tan[i * 2], tz = g.tan[i * 2 + 1];
    const target = py - fd;
    const terr = w.heightAt(px, pz);
    const ext = coreOnly ? 0 : Math.min(6, Math.abs(target - terr) * 1.7 + 0.8);
    const R = core + ext;
    // grading stops at tunnel portals so the hillside behind them stays intact
    const nearTunnel = tunnels.some((t) => s > t.s0 - R - 0.5 && s < t.s1 + R + 0.5);
    for (let z = Math.max(0, Math.floor(pz - R)); z <= Math.min(w.size, Math.ceil(pz + R)); z++) {
      for (let x = Math.max(0, Math.floor(px - R)); x <= Math.min(w.size, Math.ceil(px + R)); x++) {
        const d = Math.hypot(x - px, z - pz);
        if (d > R) continue;
        if (nearTunnel) {
          const sv = s + (x - px) * tx + (z - pz) * tz;
          if (tunnels.some((t) => sv > t.s0 && sv < t.s1)) continue;
        }
        const k = z * s1 + x;
        const cur = out.get(k);
        if (!cur || d < cur.d) out.set(k, { d, target, core, ext });
      }
    }
  }
}

/** Shape terrain under new edges. Returns the earth volume moved (vertex-height sum). */
export function applyEarthworks(w: World, edges: NEdge[], dryRun = false): number {
  const stamps = new Map<number, Stamp>();
  for (const e of edges) stampEdge(w, e, stamps);
  let vol = 0;
  const s1 = w.size + 1;
  const changes: [number, number][] = [];
  for (const [k, st] of stamps) {
    if (w.lock[k]) continue;
    const x = k % s1, z = (k / s1) | 0;
    if (x === 0 || z === 0 || x === w.size || z === w.size) continue;
    const cur = w.h[k];
    let wgt = 1;
    if (st.d > st.core) {
      const f = (st.d - st.core) / Math.max(0.01, st.ext);
      wgt = f >= 1 ? 0 : 1 - f * f * (3 - 2 * f);
    }
    if (wgt <= 0) continue;
    let nv = cur + (st.target - cur) * wgt;
    // never pull dry land below the water surface next to a formation
    if (cur >= WATER_Y && nv < WATER_Y + 0.05 && st.target >= WATER_Y) nv = Math.max(nv, WATER_Y + 0.05);
    if (Math.abs(nv - cur) < 0.005) continue;
    vol += Math.abs(nv - cur);
    changes.push([k, nv]);
  }
  if (!dryRun) {
    for (const [k, v] of changes) w.setVertex(k % s1, (k / s1) | 0, v);
    for (const e of edges) lockEdge(w, e);
  }
  return vol;
}

/** Lock the formation vertices of an edge so later works don't disturb it. */
export function lockEdge(w: World, e: NEdge) {
  const stamps = new Map<number, Stamp>();
  stampEdge(w, e, stamps, true);
  for (const [k, st] of stamps) if (st.d <= st.core - 0.15) w.lock[k] |= 1;
}

/** Recompute network locks in an area (after removing edges or converting sections). */
export function recomputeLocks(w: World, x0: number, z0: number, x1: number, z1: number) {
  const s1 = w.size + 1;
  for (let z = Math.max(0, Math.floor(z0)); z <= Math.min(w.size, Math.ceil(z1)); z++)
    for (let x = Math.max(0, Math.floor(x0)); x <= Math.min(w.size, Math.ceil(x1)); x++) w.lock[z * s1 + x] &= ~1;
  for (const e of w.net.edgesNear(x0 - 2, z0 - 2, x1 + 2, z1 + 2)) lockEdge(w, e);
}

/** Raise/lower/flatten terrain with a circular brush. Returns the volume moved. */
export function brush(w: World, cx: number, cz: number, radius: number, mode: 'raise' | 'lower' | 'level', amount: number, level = 0, dryRun = false): number {
  let vol = 0;
  for (let z = Math.max(1, Math.floor(cz - radius)); z <= Math.min(w.size - 1, Math.ceil(cz + radius)); z++) {
    for (let x = Math.max(1, Math.floor(cx - radius)); x <= Math.min(w.size - 1, Math.ceil(cx + radius)); x++) {
      const d = Math.hypot(x - cx, z - cz);
      if (d > radius) continue;
      const k = w.vi(x, z);
      if (w.lock[k]) continue;
      const f = 1 - d / radius;
      const wgt = f * f * (3 - 2 * f);
      const cur = w.h[k];
      let nv = cur;
      if (mode === 'raise') nv = cur + amount * wgt;
      else if (mode === 'lower') nv = cur - amount * wgt;
      else nv = cur + (level - cur) * Math.min(1, wgt * 1.5);
      nv = Math.max(-6, Math.min(80, nv));
      vol += Math.abs(nv - cur);
      if (!dryRun) w.setVertex(x, z, nv);
    }
  }
  return vol;
}
