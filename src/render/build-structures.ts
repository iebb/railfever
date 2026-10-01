// Bridges (decks, parapets, piers, abutments) and tunnel portals.
import { RAIL, ROAD_TYPES } from '../game/constants';
import type { NEdge } from '../game/network';
import { closestOnPolyline } from '../game/geom';
import { ChunkCtx, Smp, PP, sweep, sampleAt, inChunk, wallQuad } from './build-common';

const CONCRETE = 0xa7a39a;
const CONCRETE_DARK = 0x8f8b83;
const STONE = 0x9a9080;
const DARK = 0x07080a;

/** Is there a parallel edge of the same kind at ±RAIL.spacing (similar height) at arc length s? */
export function parallelSides(ctx: ChunkCtx, e: NEdge, s: number, offs = RAIL.spacing): { left: boolean; right: boolean } {
  const net = ctx.game.world.net;
  const p = sampleAt(net.geo(e), s);
  const res = { left: false, right: false };
  for (const side of [-1, 1]) {
    const qx = p.x + p.lx * side * offs, qz = p.z + p.lz * side * offs;
    const ne = net.nearestEdge(qx, qz, 0.14, e.kind, (f) => f.id !== e.id);
    if (!ne) continue;
    const q = sampleAt(net.geo(ne.edge), ne.s);
    if (Math.abs(q.tx * p.tx + q.tz * p.tz) < 0.95 || Math.abs(q.y - p.y) > 0.3) continue;
    if (side < 0) res.left = true; else res.right = true;
  }
  return res;
}

/** Deck cross-section (left to right over the top): slab with parapets and a box girder below. */
function deckProfile(wl: number, wr: number, pl: boolean, pr: boolean, top: number, depth: number, ph: number): PP[] {
  const pt = top + ph;
  const bot = top - depth, slab = top - 0.06;
  const gl = Math.max(0.08, wl * 0.55), gr = Math.max(0.08, wr * 0.55);
  const L: PP[] = [[-gl, bot], [-gl - 0.05, slab - 0.03], [-wl, slab]];
  if (pl) L.push([-wl, pt], [-wl + 0.025, pt], [-wl + 0.025, top]); else L.push([-wl, top]);
  if (pr) L.push([wr - 0.025, top], [wr - 0.025, pt], [wr, pt]); else L.push([wr, top]);
  L.push([wr, slab], [gr + 0.05, slab - 0.03], [gr, bot], [-gl, bot]);
  return L;
}

interface DeckDims { w: number; top: number; depth: number; ph: number; pierW: number; capW: number; spacing: number }

function deckDims(e: NEdge): DeckDims {
  if (e.kind === 'rail') return { w: 0.27, top: -0.05, depth: 0.26, ph: 0.11, pierW: 0.24, capW: 0.46, spacing: 4 };
  const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
  const W = rt.half + (rt.sidewalk > 0 ? rt.sidewalk : 0.06) + 0.04;
  return { w: W, top: -0.005, depth: 0.24, ph: 0.1, pierW: Math.min(0.5, W * 0.7), capW: W * 1.5, spacing: 3.5 };
}

/** Does any other edge pass below the deck within its half width + margin of (x,z)? */
function blockedBelow(ctx: ChunkCtx, e: NEdge, x: number, z: number, yDeck: number, margin: number): boolean {
  const net = ctx.game.world.net;
  for (const f of net.edgesNear(x - 1.5, z - 1.5, x + 1.5, z + 1.5)) {
    if (f.id === e.id) continue;
    const g = net.geo(f);
    const c = closestOnPolyline(x, z, g.pts, 3, g.n);
    if (c.d > net.halfWidth(f) + margin) continue;
    const y = g.pts[c.i * 3 + 1] + (g.pts[Math.min(g.n - 1, c.i + 1) * 3 + 1] - g.pts[c.i * 3 + 1]) * c.f;
    if (y < yDeck) return true;
  }
  return false;
}

/** Whether the network continues on a bridge at an edge end (no abutment needed there). */
function continuesAt(ctx: ChunkCtx, e: NEdge, nodeId: number, type: 'bridge' | 'tunnel'): boolean {
  const net = ctx.game.world.net;
  const node = net.nodes.get(nodeId);
  if (!node) return false;
  for (const id of node.edges) {
    if (id === e.id) continue;
    const f = net.edges.get(id);
    if (f && net.sectionAt(f, f.a === nodeId ? 0.01 : f.len - 0.01) === type) return true;
  }
  return false;
}

/** Deck, piers and abutments for the bridge section [s0,s1] of edge e (runs: chunk-local pieces of the section). */
export function buildBridge(ctx: ChunkCtx, e: NEdge, s0: number, s1: number, runs: Smp[][]) {
  const net = ctx.game.world.net;
  const w = ctx.game.world;
  const g = net.geo(e);
  const D = deckDims(e);
  const m = ctx.matte;
  for (const run of runs) {
    const mid = run[Math.floor(run.length / 2)];
    const ps = e.kind === 'rail' ? parallelSides(ctx, e, mid.s) : { left: false, right: false };
    const wl = ps.left ? RAIL.spacing / 2 + 0.012 : D.w, wr = ps.right ? RAIL.spacing / 2 + 0.012 : D.w;
    m.color(CONCRETE);
    sweep(m, run, deckProfile(wl, wr, !ps.left, !ps.right, D.top, D.depth, D.ph));
  }
  // piers
  const L = s1 - s0;
  const n = Math.max(1, Math.round(L / D.spacing));
  for (let k = 1; k < n; k++) {
    const p = sampleAt(g, s0 + (k * L) / n);
    if (!inChunk(ctx, p.x, p.z)) continue;
    const yb = p.y + D.top - D.depth + 0.02;
    const gy = w.heightAt(p.x, p.z);
    if (yb - gy < 0.4) continue;
    if (blockedBelow(ctx, e, p.x, p.z, yb - 0.1, D.pierW / 2 + 0.1)) continue;
    const base = gy - 0.4;
    m.color(CONCRETE_DARK);
    const taper = Math.min(0.06, (yb - base) * 0.006);
    m.box(p.x, base, p.z, D.pierW + taper * 2, yb - 0.07 - base, 0.14 + taper, p.tx, p.tz);
    m.color(CONCRETE);
    m.box(p.x, yb - 0.08, p.z, D.capW, 0.08, 0.2, p.tx, p.tz, false);
  }
  // abutments where the bridge meets the ground
  for (const [s, dir] of [[s0, -1], [s1, 1]] as [number, number][]) {
    const atEnd = dir < 0 ? s <= 0.05 : s >= e.len - 0.05;
    if (atEnd && continuesAt(ctx, e, dir < 0 ? e.a : e.b, 'bridge')) continue;
    const p = sampleAt(g, s);
    if (!inChunk(ctx, p.x, p.z)) continue;
    const gy = Math.min(w.heightAt(p.x, p.z), p.y - 0.2);
    const cx = p.x + p.tx * dir * 0.1, cz = p.z + p.tz * dir * 0.1;
    m.color(STONE);
    m.box(cx, gy - 0.5, cz, D.w * 2 + 0.12, p.y + D.top - (gy - 0.5), 0.36, p.tx, p.tz);
  }
}

// ------------------------------------------------------------------------------ tunnels

/** Portals at the ends of tunnel sections (one facade per group of parallel tracks). */
export function buildPortals(ctx: ChunkCtx, e: NEdge) {
  const net = ctx.game.world.net;
  for (const sec of e.sections) {
    if (sec.type !== 'tunnel') continue;
    for (const [s, out] of [[sec.s0, -1], [sec.s1, 1]] as [number, number][]) {
      const atEnd = out < 0 ? s <= 0.05 : s >= e.len - 0.05;
      if (atEnd && continuesAt(ctx, e, out < 0 ? e.a : e.b, 'tunnel')) continue;
      const p = sampleAt(net.geo(e), s);
      if (!inChunk(ctx, p.x, p.z)) continue;
      // parallel group: offsets of neighbouring tunnel tracks
      const offs = [0];
      let leader = true;
      if (e.kind === 'rail') {
        for (const side of [-1, 1]) for (let k = 1; k <= 3; k++) {
          const qx = p.x + p.lx * side * k * RAIL.spacing, qz = p.z + p.lz * side * k * RAIL.spacing;
          const ne = net.nearestEdge(qx, qz, 0.14, 'rail', (f) => f.id !== e.id);
          if (!ne || !nearTunnel(ne.edge, ne.s)) break;
          const q = sampleAt(net.geo(ne.edge), ne.s);
          if (Math.abs(q.tx * p.tx + q.tz * p.tz) < 0.95 || Math.abs(q.y - p.y) > 0.3) break;
          offs.push(side * k * RAIL.spacing);
          if (ne.edge.id < e.id) leader = false;
        }
      }
      if (!leader) continue;
      buildPortal(ctx, e, p, out, offs);
    }
  }
}

/** Inside a tunnel section of f or close to one of its ends. */
function nearTunnel(f: NEdge, s: number): boolean {
  for (const q of f.sections) if (q.type === 'tunnel' && s > q.s0 - 0.4 && s < q.s1 + 0.4) return true;
  return false;
}

function buildPortal(ctx: ChunkCtx, e: NEdge, p: Smp, out: number, offs: number[]) {
  const m = ctx.matte;
  const rail = e.kind === 'rail';
  const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
  const ow = rail ? 0.29 : rt.half + rt.sidewalk * 0.5 + 0.06;
  const oh = rail ? 0.76 : 0.64;
  const Hf = oh + 0.42;
  const lo = Math.min(...offs) - ow - 0.55, hi = Math.max(...offs) + ow + 0.55;
  // frame: o = outward along the track, l = lateral (edge right)
  const ox = p.tx * out, oz = p.tz * out;
  const lx = p.lx, lz = p.lz;
  const y = p.y;
  const at = (l: number, f: number): [number, number] => [p.x + lx * l + ox * f, p.z + lz * l + oz * f];
  const T = 0.16; // facade thickness, front face at f = 0.04
  const ff = 0.04, fb = ff - T;
  const yb = y - 0.35;
  // openings sorted
  const ops = offs.slice().sort((a, b) => a - b).map((c) => [c - ow, c + ow]);
  // facade pieces between openings (front face, back hidden in the hill)
  const piece = (l0: number, l1: number, y0: number, y1: number) => {
    if (l1 - l0 < 1e-3) return;
    const [cx, cz] = at((l0 + l1) / 2, (ff + fb) / 2);
    m.box(cx, y0, cz, l1 - l0, y1 - y0, T, ox, oz);
  };
  m.color(STONE);
  let cur = lo;
  for (const [a, b] of ops) { piece(cur, a, yb, y + oh); cur = b; }
  piece(cur, hi, yb, y + oh);
  piece(lo, hi, y + oh, y + Hf);
  // coping on top and a darker arch band over the openings
  m.color(0x7d7468);
  {
    const [cx, cz] = at((lo + hi) / 2, ff - T / 2 + 0.02);
    m.box(cx, y + Hf, cz, hi - lo + 0.08, 0.05, T + 0.06, ox, oz);
  }
  for (const [a, b] of ops) {
    const [cx, cz] = at((a + b) / 2, ff + 0.012);
    m.box(cx, y + oh, cz, b - a + 0.1, 0.07, 0.03, ox, oz);
  }
  // dark gallery interior behind each opening (faces pointing inwards) and its concrete shell
  const depth = 1.6;
  for (const [a, b] of ops) {
    const [ax, az] = at(a, fb), [bx, bz] = at(b, fb);
    const [ax2, az2] = at(a, fb - depth), [bx2, bz2] = at(b, fb - depth);
    m.color(DARK);
    wallQuad(m, ax, az, ax2, az2, y - 0.1, y + oh, y - 0.1, y + oh, lx, lz);     // left wall faces right
    wallQuad(m, bx, bz, bx2, bz2, y - 0.1, y + oh, y - 0.1, y + oh, -lx, -lz);   // right wall faces left
    wallQuad(m, ax2, az2, bx2, bz2, y - 0.1, y + oh, y - 0.1, y + oh, ox, oz);   // end wall faces out
    // ceiling (facing down) and floor (facing up)
    m.quad(ax, y + oh, az, ax2, y + oh, az2, bx2, y + oh, bz2, bx, y + oh, bz);
    fixDown(m);
    m.quad(ax, y - 0.02, az, bx, y - 0.02, bz, bx2, y - 0.02, bz2, ax2, y - 0.02, az2);
    fixUp(m);
  }
  m.color(CONCRETE_DARK);
  {
    const [cx, cz] = at((lo + hi) / 2, fb - depth / 2);
    m.box(cx, yb, cz, ops[ops.length - 1][1] - ops[0][0] + 0.2, y + oh + 0.14 - yb, depth, ox, oz);
  }
}

/** Make sure the last quad added faces down / up (flip winding if needed). */
function fixDown(m: ChunkCtx['matte']) { fixLast(m, -1); }
function fixUp(m: ChunkCtx['matte']) { fixLast(m, 1); }
function fixLast(m: ChunkCtx['matte'], want: number) {
  const n = m.nrm.length;
  const ny = m.nrm[n - 2]; // normal y of the last vertex
  if (ny * want >= 0) return;
  const I = m.idx, k = I.length - 6;
  // reverse both triangles
  [I[k + 1], I[k + 2]] = [I[k + 2], I[k + 1]];
  [I[k + 4], I[k + 5]] = [I[k + 5], I[k + 4]];
  for (let i = n - 12; i < n; i += 3) { m.nrm[i] = -m.nrm[i]; m.nrm[i + 1] = -m.nrm[i + 1]; m.nrm[i + 2] = -m.nrm[i + 2]; }
}
