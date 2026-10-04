// Bridges (girder, steel truss, stone viaduct, concrete arch; piers, abutments) and tunnel portals.
import { RAIL, ROAD_TYPES } from '../game/constants';
import type { NEdge } from '../game/network';
import { closestOnPolyline } from '../game/geom';
import { railUAtS, railSAtU } from '../game/rail-section-types';
import { ChunkCtx, Smp, PP, sweep, sampleAt, inChunk, EARTHWORK_TINT } from './build-common';
import { WB } from './build-mesh';
import { WC, WSCALE } from './textures';

const CONCRETE = 0xc9c5bc;
const CONCRETE_DARK = 0xaaa59c;
const STONE = 0xc4b49c;
const STONE_DARK = 0xa8987f;
const DARK = 0x07080a;
const ABUTMENT_MAX_HEIGHT = 1.5;
const ABUTMENT_FOUNDATION = 0.2;

// ------------------------------------------------------------------------------ neighbours

interface Nb { edge: NEdge; s: number; off: number }

/** Parallel edges of the same kind at k * RAIL.spacing laterally (contiguous on each side), near the same height. */
export function parallelGroup(ctx: ChunkCtx, e: NEdge, s: number, pred?: (f: NEdge, sf: number) => boolean): Nb[] {
  const out: Nb[] = [];
  if (e.kind !== 'rail') return out;
  const net = ctx.game.world.net;
  const member = ctx.game.railSections.membership(e.id);
  if (member) {
    const section = ctx.game.railSections.get(member.section)!, u = railUAtS(member.step, s), slot = section.slots.find((q) => q.id === member.slot)!;
    const structure = ctx.game.railSections.structureAt(e.id, s);
    for (const other of section.slots) {
      if (other.id === slot.id || structure && !structure.slots.includes(other.id)) continue;
      const step = other.steps.find((q) => u >= q.u0 - 1e-6 && u <= q.u1 + 1e-6); if (!step) continue;
      const edge = net.edges.get(step.edge)!, at = railSAtU(step, u);
      if (!pred || pred(edge, at)) out.push({ edge, s: at, off: (other.offset - slot.offset) * member.step.dir });
    }
    return out;
  }
  const p = sampleAt(net.geo(e), s);
  for (const side of [-1, 1]) for (let k = 1; k <= 3; k++) {
    const off = side * k * RAIL.spacing;
    const ne = net.nearestEdge(p.x + p.lx * off, p.z + p.lz * off, 0.14, 'rail', (f) => f.id !== e.id && !ctx.game.railSections.membership(f.id));
    if (!ne) break;
    const attachment = ctx.game.stations.railAttachment(e.id), otherAttachment = ctx.game.stations.railAttachment(ne.edge.id);
    if (ne.edge.owner !== e.owner || ne.edge.type !== e.type || ne.edge.station !== e.station || ne.edge.depot !== e.depot || attachment?.station !== otherAttachment?.station) break;
    const q = sampleAt(net.geo(ne.edge), ne.s);
    if (Math.abs(q.tx * p.tx + q.tz * p.tz) < 0.95 || Math.abs(q.y - p.y) > 0.3) break;
    if (pred && !pred(ne.edge, ne.s)) break;
    out.push({ edge: ne.edge, s: ne.s, off });
  }
  return out;
}

/** Is there a parallel edge directly left/right (±spacing) at arc length s? */
export function parallelSides(ctx: ChunkCtx, e: NEdge, s: number): { left: boolean; right: boolean } {
  const g = parallelGroup(ctx, e, s);
  return { left: g.some((n) => n.off < 0 && n.off > -RAIL.spacing * 1.5), right: g.some((n) => n.off > 0 && n.off < RAIL.spacing * 1.5) };
}

/** Does any other edge pass below height yDeck within its half width + margin of (x,z)? */
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

/** Does the network continue on a bridge/tunnel at an edge end (then no abutment/portal there)? */
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

/** Dead end of an underground station platform: the track ends inside the station box, no portal. */
function buriedEnd(ctx: ChunkCtx, e: NEdge, nodeId: number): boolean {
  if (ctx.stationEdges?.get(e.id) !== 'underground') return false;
  const node = ctx.game.world.net.nodes.get(nodeId);
  return !node || node.edges.length <= 1;
}

/** Lowest terrain under a footprint centred at p (half extents across/along the edge). */
function groundUnder(ctx: ChunkCtx, p: Smp, ha: number, hl: number, off = 0): number {
  const w = ctx.game.world;
  let gy = w.heightAt(p.x + p.lx * off, p.z + p.lz * off);
  for (const a of [-ha, ha]) for (const l of [-hl, hl]) gy = Math.min(gy, w.heightAt(p.x + p.lx * (off + a) + p.tx * l, p.z + p.lz * (off + a) + p.tz * l));
  return gy;
}

// ------------------------------------------------------------------------------ bridges

export type BridgeStyle = 'girder' | 'truss' | 'viaduct' | 'arch' | 'tiedarch';

interface Dims { w: number; top: number; depth: number; ph: number; pierW: number; capW: number }

function dims(e: NEdge): Dims {
  if (e.kind === 'rail') return { w: 0.27, top: -0.05, depth: 0.26, ph: 0.11, pierW: 0.22, capW: 0.5 };
  const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
  const W = rt.half + (rt.sidewalk > 0 ? rt.sidewalk : 0.06) + 0.04;
  return { w: W, top: -0.005, depth: 0.24, ph: 0.1, pierW: Math.min(0.5, W * 0.7), capW: W * 1.6 };
}

const styleCache = new Map<string, BridgeStyle>();
const bridgeSigs = new Map<string, string>();

function spanFor(style: BridgeStyle, e: NEdge): number {
  return style === 'truss' ? 9 : style === 'viaduct' ? 2.4 : style === 'arch' ? 6 : style === 'tiedarch' ? 12 : e.kind === 'rail' ? 4 : 3.5;
}

/** Bridge style of a section, decided on the group leader so parallel tracks match. */
export function bridgeStyle(ctx: ChunkCtx, e: NEdge, s0: number, s1: number): BridgeStyle {
  const net = ctx.game.world.net;
  const mid = (s0 + s1) / 2;
  let le = e, ls0 = s0, ls1 = s1;
  for (const nb of parallelGroup(ctx, e, mid, (f, sf) => net.sectionAt(f, sf) === 'bridge')) {
    if (nb.edge.id >= le.id) continue;
    const sec = nb.edge.sections.find((q) => q.type === 'bridge' && nb.s >= q.s0 - 0.01 && nb.s <= q.s1 + 0.01);
    if (sec) { le = nb.edge; ls0 = sec.s0; ls1 = sec.s1; }
  }
  const key = le.id + ':' + le.version + ':' + ls0.toFixed(2) + ':' + net.version;
  let st = styleCache.get(key);
  if (st) return st;
  st = computeStyle(ctx, le, ls0, ls1);
  if (styleCache.size > 4000) styleCache.clear();
  styleCache.set(key, st);
  return st;
}

function computeStyle(ctx: ChunkCtx, e: NEdge, s0: number, s1: number): BridgeStyle {
  const w = ctx.game.world;
  const g = ctx.game.world.net.geo(e);
  const D = dims(e);
  const L = s1 - s0;
  const hs: number[] = [];
  let water = false;
  for (let k = 1; k < 20; k++) {
    const p = sampleAt(g, s0 + (L * k) / 20);
    const gy = w.heightAt(p.x, p.z);
    if (gy < 0) water = true;
    if (k >= 3 && k <= 17) hs.push(p.y + D.top - D.depth - gy);
  }
  hs.sort((a, b) => a - b);
  const med = hs.length ? hs[Math.floor(hs.length / 2)] : 0;
  let st: BridgeStyle = 'girder';
  if (e.kind === 'rail') {
    if (water && L >= 9) st = 'truss';
    else if (L >= 8 && med >= 2.0) st = 'viaduct';
  } else if (water) st = L >= 10 ? 'tiedarch' : 'viaduct';
  else if (L >= 12 && med >= 2.4) st = 'arch';
  if (st === 'viaduct' || st === 'arch') {
    // arches need every pier: fall back to girders if any support would stand on another edge
    const n = Math.max(1, Math.round(L / spanFor(st, e)));
    for (let k = 1; k < n; k++) {
      const p = sampleAt(g, s0 + (k * L) / n);
      if (blockedBelow(ctx, e, p.x, p.z, p.y - 0.3, D.w + 0.15)) return 'girder';
    }
  }
  return st;
}

/** Deck cross-section (left to right over the top): slab with parapets and a girder below. */
function deckProfile(wl: number, wr: number, pl: boolean, pr: boolean, top: number, depth: number, ph: number, girder: boolean): PP[] {
  const pt = top + ph;
  const bot = top - depth, slab = top - 0.06;
  const gl = Math.max(0.08, wl * 0.55), gr = Math.max(0.08, wr * 0.55);
  const L: PP[] = girder ? [[-gl, bot], [-gl - 0.05, slab - 0.03], [-wl, slab]] : [[-wl, slab]];
  if (pl) L.push([-wl, pt], [-wl + 0.025, pt], [-wl + 0.025, top]); else L.push([-wl, top]);
  if (pr) L.push([wr - 0.025, top], [wr - 0.025, pt], [wr, pt]); else L.push([wr, top]);
  L.push([wr, slab]);
  if (girder) L.push([gr + 0.05, slab - 0.03], [gr, bot], [-gl, bot]); else L.push([-wl, slab]);
  // u = lateral distance (concrete cell scale)
  return L.map(([l, h]) => [l, h, (l + h) / WSCALE.CONCRETE]);
}

/** Deck, supports and abutments for the bridge section [s0,s1] of edge e (runs: chunk-local pieces). */
export function buildBridge(ctx: ChunkCtx, e: NEdge, s0: number, s1: number, runs: Smp[][]) {
  const net = ctx.game.world.net;
  const g = net.geo(e);
  const D = dims(e);
  const W = ctx.w;
  const style = bridgeStyle(ctx, e, s0, s1);
  const mid = sampleAt(g, (s0 + s1) / 2);
  const ps = e.kind === 'rail' ? parallelSides(ctx, e, mid.s) : { left: false, right: false };
  const half = RAIL.spacing / 2;
  const wl = ps.left ? half : D.w, wr = ps.right ? half : D.w;
  // deck
  W.cast = 1;
  for (const run of runs) {
    if (style === 'truss') {
      W.use(WC.METAL, 0x4f5559);
      sweep(W, run, deckProfile(wl, wr, false, false, D.top, 0.16, 0, false));
    } else if (style === 'viaduct') {
      W.use(WC.STONE, STONE);
      sweep(W, run, deckProfile(wl, wr, !ps.left, !ps.right, D.top, 0.12, D.ph, false).map(([l, h]) => [l, h, (l + h) / WSCALE.STONE] as PP));
    } else if (style === 'tiedarch') {
      W.use(WC.CONCRETE, CONCRETE);
      sweep(W, run, deckProfile(wl, wr, !ps.left, !ps.right, D.top, 0.16, D.ph * 0.8, false));
    } else {
      W.use(WC.CONCRETE, CONCRETE);
      sweep(W, run, deckProfile(wl, wr, !ps.left, !ps.right, D.top, style === 'arch' ? 0.14 : D.depth, D.ph, style === 'girder'));
    }
  }
  const L = s1 - s0;
  const n = Math.max(1, Math.round(L / spanFor(style, e)));
  const pierS: number[] = [];
  for (let k = 1; k < n; k++) pierS.push(s0 + (k * L) / n);
  let supports = [s0, ...pierS, s1];
  if (style === 'girder' || style === 'truss' || style === 'tiedarch') {
    const depth = style === 'girder' ? D.depth : 0.16;
    supports = [s0];
    for (const s of pierS) { const ps2 = pier(ctx, e, s, D, depth, wl, wr, style === 'girder' ? 1.0 : 1.6); if (ps2 !== null) supports.push(ps2); }
    supports.push(s1);
    if (style === 'truss') for (let i = 0; i < supports.length - 1; i++) truss(ctx, e, supports[i], supports[i + 1], D, ps);
    if (style === 'tiedarch') for (let i = 0; i < supports.length - 1; i++) tiedArch(ctx, e, supports[i], supports[i + 1], D, ps);
  } else if (style === 'viaduct') viaduct(ctx, e, s0, s1, supports, D, wl, wr, ps);
  else arches(ctx, e, supports, D, wl, wr);
  // a bridge spans several chunks: if its style or supports changed (e.g. a line was built underneath),
  // make sure every chunk of it is rebuilt so the pieces stay consistent
  const key = e.id + ':' + s0.toFixed(2);
  const sig = style + ':' + supports.map((v) => v.toFixed(2)).join(',');
  const prev = bridgeSigs.get(key);
  if (prev !== sig) {
    bridgeSigs.set(key, sig);
    if (bridgeSigs.size > 20000) bridgeSigs.clear();
    const b = net.grid.box(e.id);
    if (prev !== undefined && b) ctx.game.world.markObjArea(b[0], b[1], b[2], b[3]);
  }
  // abutments where the bridge meets the ground
  for (const [s, gd] of [[s0, -1], [s1, 1]] as [number, number][]) {
    const atEnd = gd < 0 ? s <= 0.05 : s >= e.len - 0.05;
    if (atEnd && continuesAt(ctx, e, gd < 0 ? e.a : e.b, 'bridge')) continue;
    const p = sampleAt(g, s);
    if (p.y + D.top - groundUnder(ctx, p, (wl + wr) / 2, 0.12, (wr - wl) / 2) > ABUTMENT_MAX_HEIGHT) {
      // Section boundaries are not always the bank: support an exposed deck end with a column,
      // and put the retaining wall farther back where the approach actually reaches the terrain.
      const depth = style === 'viaduct' ? 0.12 : style === 'arch' ? 0.14 : style === 'girder' ? D.depth : 0.16;
      pier(ctx, e, s, D, depth, wl, wr, 1, [s0, s1]);
    }
    abutment(ctx, e, s, gd, D, wl, wr, style);
  }
}

/** Pier under the deck at s (shifted along the bridge if another edge passes below). Returns the used s or null. */
function pier(ctx: ChunkCtx, e: NEdge, s: number, D: Dims, depth: number, wl: number, wr: number, scale: number, endSpan?: [number, number]): number | null {
  const w = ctx.game.world;
  const g = ctx.game.world.net.geo(e);
  for (const dsh of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
    const sp = s + dsh * scale;
    if (endSpan ? sp < endSpan[0] || sp > endSpan[1] : sp <= 0.3 || sp >= e.len - 0.3) continue;
    const p = sampleAt(g, sp);
    const yb = p.y + D.top - depth + 0.02;
    const gy = w.heightAt(p.x, p.z);
    if (yb - gy < 0.4) return dsh === 0 ? null : null;
    if (blockedBelow(ctx, e, p.x, p.z, yb - 0.1, D.pierW / 2 + 0.12)) continue;
    if (!inChunk(ctx, p.x, p.z)) return sp;
    const W = ctx.w;
    W.cast = 1;
    const base = Math.min(gy, groundUnder(ctx, p, D.pierW / 2 + 0.05, 0.12 * scale, (wr - wl) / 2)) - 0.4;
    const h = yb - 0.08 - base;
    const taper = Math.min(0.08, h * 0.008);
    // keep caps of parallel decks flush: centre the column under this deck's own width
    const off = (wr - wl) / 2;
    const cx = p.x + p.lx * off, cz = p.z + p.lz * off;
    W.use(WC.CONCRETE, CONCRETE_DARK);
    W.tbox(cx, base, cz, D.pierW + taper * 2, h, 0.15 * scale + taper, p.tx, p.tz, WSCALE.CONCRETE);
    W.use(WC.CONCRETE, CONCRETE);
    W.tbox(cx, yb - 0.09, cz, Math.min(D.capW, wl + wr), 0.09, 0.22 * scale, p.tx, p.tz, WSCALE.CONCRETE, true);
    if (gy < 0) { // footing at the waterline
      W.use(WC.CONCRETE, CONCRETE_DARK);
      W.tbox(cx, gy - 0.2, cz, D.pierW + 0.16, -gy + 0.2 + 0.08, 0.15 * scale + 0.16, p.tx, p.tz, WSCALE.CONCRETE);
    }
    return sp;
  }
  return null;
}

/** Steel through truss on the outer sides of one span [sa,sb]. */
function truss(ctx: ChunkCtx, e: NEdge, sa: number, sb: number, D: Dims, ps: { left: boolean; right: boolean }) {
  const g = ctx.game.world.net.geo(e);
  const midp = sampleAt(g, (sa + sb) / 2);
  if (!inChunk(ctx, midp.x, midp.z)) return;
  const W = ctx.w;
  W.cast = 1;
  const col = [0x4b5d52, 0x7a4234, 0x5f676d][e.id % 3];
  W.use(WC.METAL, col);
  const m = Math.max(2, Math.round((sb - sa) / 1.0));
  const TH = 0.84, r = 0.016;
  const P = (i: number) => sampleAt(g, sa + ((sb - sa) * i) / m);
  const pts = Array.from({ length: m + 1 }, (_, i) => P(i));
  const sides: number[] = [];
  if (!ps.left) sides.push(-1);
  if (!ps.right) sides.push(1);
  const y0 = D.top + 0.02;
  for (const sd of sides) {
    const off = sd * (D.w - 0.01);
    const B = (i: number) => { const p = pts[i]; return [p.x + p.lx * off, p.y + y0, p.z + p.lz * off]; };
    const T = (i: number) => { const p = pts[i]; return [p.x + p.lx * off, p.y + y0 + TH, p.z + p.lz * off]; };
    for (let i = 0; i < m; i++) {
      const b0 = B(i), b1 = B(i + 1);
      W.tube(b0[0], b0[1], b0[2], b1[0], b1[1], b1[2], r * 1.3, 4);
      if (i >= 1 && i < m - 1) { const t0 = T(i), t1 = T(i + 1); W.tube(t0[0], t0[1], t0[2], t1[0], t1[1], t1[2], r * 1.3, 4); }
    }
    // end posts
    { const b = B(0), t = T(1); W.tube(b[0], b[1], b[2], t[0], t[1], t[2], r * 1.3, 4); }
    { const b = B(m), t = T(m - 1); W.tube(b[0], b[1], b[2], t[0], t[1], t[2], r * 1.3, 4); }
    for (let i = 1; i < m; i++) {
      const b = B(i), t = T(i);
      W.tube(b[0], b[1], b[2], t[0], t[1], t[2], r * 0.8, 4);
      // Pratt diagonals sloping down towards the middle
      const j = i < m / 2 ? i + 1 : i - 1;
      if (j >= 1 && j <= m - 1 && i !== j) { const bj = B(j); W.tube(t[0], t[1], t[2], bj[0], bj[1], bj[2], r * 0.7, 4); }
    }
  }
  // top bracing between both trusses of a single track
  if (sides.length === 2) {
    for (let i = 1; i < m; i++) {
      const p = pts[i];
      const yy = p.y + y0 + TH;
      W.tube(p.x - p.lx * (D.w - 0.01), yy, p.z - p.lz * (D.w - 0.01), p.x + p.lx * (D.w - 0.01), yy, p.z + p.lz * (D.w - 0.01), r * 0.7, 4);
    }
  }
}

/** Steel tied arch (bowstring) over one span: arch ribs on the outer sides, hangers, top bracing. */
function tiedArch(ctx: ChunkCtx, e: NEdge, sa: number, sb: number, D: Dims, ps: { left: boolean; right: boolean }) {
  const g = ctx.game.world.net.geo(e);
  const mid = sampleAt(g, (sa + sb) / 2);
  if (!inChunk(ctx, mid.x, mid.z)) return;
  const W = ctx.w;
  W.cast = 1;
  W.use(WC.METAL, 0xd3d7da);
  const span = sb - sa;
  const rise = Math.max(1.0, Math.min(2.2, span * 0.18));
  const K = Math.max(10, Math.round(span / 0.45));
  const pts = Array.from({ length: K + 1 }, (_, k) => sampleAt(g, sa + (span * k) / K));
  const y0 = D.top + 0.05;
  const hy = (k: number) => { const t = k / K; return y0 + rise * 4 * t * (1 - t); };
  const sides: number[] = [];
  if (!ps.left) sides.push(-1);
  if (!ps.right) sides.push(1);
  for (const sd of sides) {
    const off = sd * (D.w - 0.03);
    const A = (k: number): [number, number, number] => { const p = pts[k]; return [p.x + p.lx * off, p.y + hy(k), p.z + p.lz * off]; };
    for (let k = 0; k < K; k++) { const a = A(k), b = A(k + 1); W.tube(a[0], a[1], a[2], b[0], b[1], b[2], 0.045, 4); }
    // hangers from the arch down to the deck edge
    for (let k = 2; k < K - 1; k += 2) {
      const a = A(k), p = pts[k];
      W.tube(a[0], a[1], a[2], p.x + p.lx * off, p.y + y0, p.z + p.lz * off, 0.008, 3);
    }
  }
  // wind bracing between the two arches where they are high enough above the road
  if (sides.length === 2) {
    for (let k = 2; k < K - 1; k += 2) {
      if (hy(k) - y0 < 0.95) continue;
      const p = pts[k], yy = p.y + hy(k);
      W.tube(p.x - p.lx * (D.w - 0.03), yy, p.z - p.lz * (D.w - 0.03), p.x + p.lx * (D.w - 0.03), yy, p.z + p.lz * (D.w - 0.03), 0.02, 4);
    }
  }
}

/** Stone arch viaduct: spandrel walls on the outer sides, barrel vault soffits and pier faces. */
function viaduct(ctx: ChunkCtx, e: NEdge, s0: number, s1: number, sup: number[], D: Dims, wl: number, wr: number, ps: { left: boolean; right: boolean }) {
  const w = ctx.game.world;
  const g = ctx.game.world.net.geo(e);
  const W = ctx.w;
  W.cast = 1;
  const PW = 0.5; // pier thickness along the bridge
  const crownT = 0.12; // stone above the crown
  const yDeck = (p: Smp) => p.y + D.top - 0.12;
  for (let i = 0; i < sup.length - 1; i++) {
    const a = sup[i] + (i === 0 ? 0 : PW / 2), b = sup[i + 1] - (i === sup.length - 2 ? 0 : PW / 2);
    const c = b - a;
    const pm = sampleAt(g, (a + b) / 2);
    if (!inChunk(ctx, pm.x, pm.z)) continue;
    // rise limited by the ground under the span
    let gmax = -1e9;
    for (let k = 0; k <= 6; k++) { const p = sampleAt(g, a + (c * k) / 6); gmax = Math.max(gmax, w.heightAt(p.x, p.z)); }
    const crown = yDeck(pm) - crownT;
    const rise = Math.max(0.15, Math.min(c / 2, crown - gmax - 0.2));
    const R = (rise * rise + (c / 2) * (c / 2)) / (2 * rise);
    const yc = crown - R; // circle centre height (relative to the crown at the span middle)
    const steps = Math.max(6, Math.round(c / 0.18));
    const samp: { p: Smp; y: number }[] = [];
    for (let k = 0; k <= steps; k++) {
      const s = a + (c * k) / steps;
      const p = sampleAt(g, s);
      const dx = s - (a + c / 2);
      const yy = yc + Math.sqrt(Math.max(0, R * R - dx * dx)) + (p.y - pm.y);
      samp.push({ p, y: yy });
    }
    // soffit (facing down) across this deck's width
    W.use(WC.STONE, STONE_DARK);
    for (let k = 0; k < steps; k++) {
      const A = samp[k], B = samp[k + 1];
      const ax0 = A.p.x - A.p.lx * wl, az0 = A.p.z - A.p.lz * wl, ax1 = A.p.x + A.p.lx * wr, az1 = A.p.z + A.p.lz * wr;
      const bx0 = B.p.x - B.p.lx * wl, bz0 = B.p.z - B.p.lz * wl, bx1 = B.p.x + B.p.lx * wr, bz1 = B.p.z + B.p.lz * wr;
      const u0 = A.p.s / WSCALE.STONE, u1 = B.p.s / WSCALE.STONE;
      const wx = 0, wy = -1, wz = 0;
      W.ttri(ax0, A.y, az0, u0, 0, ax1, A.y, az1, u0, (wl + wr) / WSCALE.STONE, bx1, B.y, bz1, u1, (wl + wr) / WSCALE.STONE, wx, wy, wz);
      W.ttri(ax0, A.y, az0, u0, 0, bx1, B.y, bz1, u1, (wl + wr) / WSCALE.STONE, bx0, B.y, bz0, u1, 0, wx, wy, wz);
    }
    // spandrel walls on the outer sides: from the deck slab down to the arch (and down the pier halves)
    W.use(WC.STONE, STONE);
    for (const [sd, wd, has] of [[-1, wl, !ps.left], [1, wr, !ps.right]] as [number, number, boolean][]) {
      if (!has) continue;
      for (let k = 0; k < steps; k++) {
        const A = samp[k], B = samp[k + 1];
        const ax = A.p.x + A.p.lx * sd * wd, az = A.p.z + A.p.lz * sd * wd, bx = B.p.x + B.p.lx * sd * wd, bz = B.p.z + B.p.lz * sd * wd;
        W.twall(ax, az, bx, bz, A.y, yDeck(A.p) + 0.06, B.y, yDeck(B.p) + 0.06, A.p.lx * sd, A.p.lz * sd, WSCALE.STONE, A.p.s);
      }
    }
  }
  // piers: outer faces and the faces towards both arches, from the springing down to the ground
  for (let i = 1; i < sup.length - 1; i++) {
    const p = sampleAt(g, sup[i]);
    if (!inChunk(ctx, p.x, p.z)) continue;
    const gy = groundUnder(ctx, p, (wl + wr) / 2 + 0.05, PW / 2 + 0.04, (wr - wl) / 2) - 0.4;
    const top = yDeck(p);
    W.use(WC.STONE, STONE);
    const off = (wr - wl) / 2;
    const cx = p.x + p.lx * off, cz = p.z + p.lz * off;
    // a full-width block up to the deck; arch soffits/spandrels of the spans meet its faces
    W.tbox(cx, gy, cz, wl + wr + (ps.left ? 0 : 0.03) + (ps.right ? 0 : 0.03), top + 0.05 - gy, PW, p.tx, p.tz, WSCALE.STONE, false, false);
    // cutwater ledge
    W.use(WC.STONE, STONE_DARK);
    W.tbox(cx, gy, cz, wl + wr + 0.1, Math.min(top - gy, 0.6), PW + 0.08, p.tx, p.tz, WSCALE.STONE);
  }
  void s0; void s1;
}

/** Concrete open-spandrel arches: one rib per span springing from the pier footings, columns up to the deck. */
function arches(ctx: ChunkCtx, e: NEdge, sup: number[], D: Dims, wl: number, wr: number) {
  const w = ctx.game.world;
  const g = ctx.game.world.net.geo(e);
  const W = ctx.w;
  W.cast = 1;
  const bw = Math.min(wl + wr, D.w * 1.6) * 0.75; // rib width
  const off = (wr - wl) / 2;
  const deckB = (p: Smp) => p.y + D.top - 0.14;
  for (let i = 0; i < sup.length - 1; i++) {
    const a = sup[i], b = sup[i + 1], c = b - a;
    const pa = sampleAt(g, a), pb = sampleAt(g, b), pm = sampleAt(g, (a + b) / 2);
    const ya = w.heightAt(pa.x, pa.z) + 0.05, yb = w.heightAt(pb.x, pb.z) + 0.05;
    const spring = Math.max(ya, yb, Math.min(pa.y, pb.y) - 6);
    const crown = deckB(pm) - 0.04;
    const rise = crown - spring;
    const ribHere = inChunk(ctx, pm.x, pm.z);
    if (rise < 0.8) {
      // too low for an arch: plain column in the middle
      if (ribHere) {
        const gy = w.heightAt(pm.x, pm.z) - 0.3;
        W.use(WC.CONCRETE, CONCRETE_DARK);
        W.tbox(pm.x + pm.lx * off, gy, pm.z + pm.lz * off, D.pierW, deckB(pm) - gy, 0.16, pm.tx, pm.tz, WSCALE.CONCRETE);
      }
      continue;
    }
    const steps = Math.max(8, Math.round(c / 0.35));
    const ribY = (k: number) => { const t = k / steps; return spring + rise * 4 * t * (1 - t); };
    if (ribHere) {
      // rib: box section swept along the parabola
      W.use(WC.CONCRETE, CONCRETE);
      const T = 0.16;
      const pts: { p: Smp; y: number }[] = [];
      for (let k = 0; k <= steps; k++) pts.push({ p: sampleAt(g, a + (c * k) / steps), y: ribY(k) });
      for (const [l0, l1, h0, h1] of [[-bw / 2, bw / 2, T, T], [bw / 2, bw / 2, T, 0], [bw / 2, -bw / 2, 0, 0], [-bw / 2, -bw / 2, 0, T]] as [number, number, number, number][]) {
        for (let k = 0; k < steps; k++) {
          const A = pts[k], B = pts[k + 1];
          const ax0 = A.p.x + A.p.lx * (off + l0), az0 = A.p.z + A.p.lz * (off + l0), ax1 = A.p.x + A.p.lx * (off + l1), az1 = A.p.z + A.p.lz * (off + l1);
          const bx0 = B.p.x + B.p.lx * (off + l0), bz0 = B.p.z + B.p.lz * (off + l0), bx1 = B.p.x + B.p.lx * (off + l1), bz1 = B.p.z + B.p.lz * (off + l1);
          // outward direction of this face
          const mx = (A.p.lx * (l0 + l1) / 2) * (l0 === l1 ? 1 : 0), mz = (A.p.lz * (l0 + l1) / 2) * (l0 === l1 ? 1 : 0);
          const my = l0 === l1 ? 0 : (h0 > 0 ? 1 : -1);
          const u0 = A.p.s / WSCALE.CONCRETE, u1 = B.p.s / WSCALE.CONCRETE;
          W.ttri(ax0, A.y + h0, az0, u0, 0, ax1, A.y + h1, az1, u0, 0.2, bx1, B.y + h1, bz1, u1, 0.2, mx, my, mz);
          W.ttri(ax0, A.y + h0, az0, u0, 0, bx1, B.y + h1, bz1, u1, 0.2, bx0, B.y + h0, bz0, u1, 0, mx, my, mz);
        }
      }
      // spandrel columns from the rib to the deck
      const nc = Math.max(1, Math.round(c / 0.8));
      W.use(WC.CONCRETE, CONCRETE_DARK);
      for (let k = 1; k < nc; k++) {
        const t = k / nc;
        const kk = t * steps;
        const y0 = ribY(kk) + 0.16;
        const p = sampleAt(g, a + c * t);
        const y1 = deckB(p);
        if (y1 - y0 < 0.12) continue;
        for (const sd of [-1, 1]) {
          const lo = off + sd * bw * 0.3;
          W.tbox(p.x + p.lx * lo, y0 - 0.02, p.z + p.lz * lo, 0.07, y1 - y0 + 0.02, 0.07, p.tx, p.tz, WSCALE.CONCRETE);
        }
      }
    }
  }
  // main piers at the supports (footings the ribs spring from, and columns up to the deck)
  for (let i = 1; i < sup.length - 1; i++) {
    const p = sampleAt(g, sup[i]);
    if (!inChunk(ctx, p.x, p.z)) continue;
    const gy = groundUnder(ctx, p, bw / 2 + 0.06, 0.25, off) - 0.4;
    W.use(WC.CONCRETE, CONCRETE_DARK);
    W.tbox(p.x + p.lx * off, gy, p.z + p.lz * off, bw + 0.12, Math.max(0.65, w.heightAt(p.x, p.z) - gy + 0.25), 0.5, p.tx, p.tz, WSCALE.CONCRETE);
    W.use(WC.CONCRETE, CONCRETE);
    W.tbox(p.x + p.lx * off, gy, p.z + p.lz * off, bw * 0.8, deckB(p) - gy, 0.2, p.tx, p.tz, WSCALE.CONCRETE);
  }
}

/** Find the bank behind an exposed section end, following only the ground approach (including a joined edge). */
function abutmentSite(ctx: ChunkCtx, e: NEdge, s: number, gd: number, D: Dims, wl: number, wr: number): { p: Smp; edge: NEdge } | null {
  const w = ctx.game.world;
  const net = w.net;
  const end = sampleAt(net.geo(e), s);
  const gap = (p: Smp) => p.y + D.top - groundUnder(ctx, p, (wl + wr) / 2, 0.12, (wr - wl) / 2);
  const site = (f: NEdge, p: Smp, dir: number) => {
    const align = dir * gd;
    return { p: { ...p, tx: p.tx * align, tz: p.tz * align, lx: p.lx * align, lz: p.lz * align }, edge: f };
  };
  if (gap(end) <= ABUTMENT_MAX_HEIGHT) return site(e, end, gd);
  let f = e, at = s, dir = gd, remaining = 4;
  for (let hop = 0; hop < 3 && remaining > 0; hop++) {
    const reach = Math.min(remaining, dir > 0 ? f.len - at : at);
    const steps = Math.ceil(reach / 0.2);
    for (let k = 1; k <= steps; k++) {
      const p = sampleAt(net.geo(f), at + dir * reach * k / steps);
      if (net.sectionAt(f, Math.max(0, Math.min(f.len, p.s + dir * 0.01))) !== 'ground') return null;
      const bank = site(f, p, dir);
      if (gap(bank.p) <= 0.6) return bank;
    }
    remaining -= reach;
    const nodeId = dir > 0 ? f.b : f.a;
    const node = net.nodes.get(nodeId);
    let next: NEdge | undefined, best = 0.8;
    for (const id of node?.edges ?? []) {
      const q = net.edges.get(id);
      if (!q || q.id === f.id || q.kind !== e.kind) continue;
      const qs = q.a === nodeId ? 0.01 : q.len - 0.01;
      if (net.sectionAt(q, qs) !== 'ground') continue;
      const t = net.leaveDir(q, nodeId);
      const dot = (t.x * end.tx + t.z * end.tz) * gd;
      if (dot > best) { next = q; best = dot; }
    }
    if (!next) break; // a free end in mid-air has a pier, but no invented earthworks or floating wall
    f = next; dir = f.a === nodeId ? 1 : -1; at = dir > 0 ? 0 : f.len;
  }
  return null;
}

/** Thin bank wall, bearing shelf, ballast backwall and splayed wings, founded on their own terrain samples. */
function abutment(ctx: ChunkCtx, e: NEdge, s: number, gd: number, D: Dims, wl: number, wr: number, style: BridgeStyle) {
  const w = ctx.game.world;
  const end = sampleAt(w.net.geo(e), s);
  // Own the whole assembly in the section end's chunk, even if the bank is across its boundary.
  if (!inChunk(ctx, end.x, end.z)) return;
  const bank = abutmentSite(ctx, e, s, gd, D, wl, wr);
  if (!bank) return;
  const { p } = bank;
  const g = w.net.geo(bank.edge);
  const W = ctx.w;
  W.cast = 1;
  const rt = e.kind === 'road' ? ROAD_TYPES[e.type] ?? ROAD_TYPES.road : null;
  const stone = ctx.game.year < 1950 && !(rt && (rt.speed >= 80 || rt.lanes >= 4));
  const cell = stone ? WC.STONE : WC.CONCRETE, sc = stone ? WSCALE.STONE : WSCALE.CONCRETE;
  const depth = style === 'viaduct' ? 0.12 : style === 'arch' ? 0.14 : style === 'girder' ? D.depth : 0.16;
  const deck = (x: number, z: number) => {
    const c = closestOnPolyline(x, z, g.pts, 3, g.n);
    return g.pts[c.i * 3 + 1] + (g.pts[Math.min(g.n - 1, c.i + 1) * 3 + 1] - g.pts[c.i * 3 + 1]) * c.f + D.top;
  };
  const bearing = (deckY: number) => deckY - depth + 0.018;
  // Each strip is sampled across both faces: a hillside must not turn the low corner's foundation
  // into a deep solid block under the high corner. Buried panels are omitted, rather than inverted.
  const strip = (a0: number, l0: number, a1: number, l1: number, thick: number,
    topAt: (deckY: number, t: number, ground: number) => number, tone: number, bottomAt?: (deckY: number) => number) => {
    const len = Math.hypot(a1 - a0, l1 - l0);
    if (len < 0.01) return;
    const nx = -(l1 - l0) / len, nz = (a1 - a0) / len;
    const steps = Math.max(1, Math.ceil(len / 0.35));
    const point = (t: number, side: number) => {
      const a = a0 + (a1 - a0) * t + nx * side * thick / 2;
      const l = l0 + (l1 - l0) * t + nz * side * thick / 2;
      const x = p.x + p.tx * gd * a + p.lx * l, z = p.z + p.tz * gd * a + p.lz * l;
      const gy = w.heightAt(x, z), deckY = deck(x, z);
      const top = Math.min(deckY - 0.025, topAt(deckY, t, gy));
      const bottom = Math.max(gy - ABUTMENT_FOUNDATION, bottomAt ? bottomAt(deckY) : -Infinity);
      return { x, z, top, bottom };
    };
    const ox = p.tx * gd * nx + p.lx * nz, oz = p.tz * gd * nx + p.lz * nz;
    const fx = p.tx * gd * (a1 - a0) / len + p.lx * (l1 - l0) / len;
    const fz = p.tz * gd * (a1 - a0) / len + p.lz * (l1 - l0) / len;
    W.use(cell, tone);
    let open = false;
    for (let k = 0; k < steps; k++) {
      const A = point(k / steps, -1), B = point(k / steps, 1);
      const C = point((k + 1) / steps, -1), E = point((k + 1) / steps, 1);
      const visible = (v: typeof A) => v.top - v.bottom > 0.006 && v.top - v.bottom <= ABUTMENT_MAX_HEIGHT + ABUTMENT_FOUNDATION;
      const here = [A, B, C, E].every(visible);
      const face = (a: typeof A, b: typeof A, dx: number, dz: number) =>
        W.twall(a.x, a.z, b.x, b.z, a.bottom, a.top, b.bottom, b.top, dx, dz, sc, k * len / steps);
      if (!here) { open = false; continue; }
      if (!open) face(A, B, -fx, -fz);
      face(A, C, -ox, -oz); face(B, E, ox, oz);
      W.ttri(A.x, A.top, A.z, A.x / sc, A.z / sc, B.x, B.top, B.z, B.x / sc, B.z / sc, E.x, E.top, E.z, E.x / sc, E.z / sc, 0, 1, 0);
      W.ttri(A.x, A.top, A.z, A.x / sc, A.z / sc, E.x, E.top, E.z, E.x / sc, E.z / sc, C.x, C.top, C.z, C.x / sc, C.z / sc, 0, 1, 0);
      const next = k + 1 < steps && [point((k + 2) / steps, -1), point((k + 2) / steps, 1)].every(visible);
      if (!next) face(C, E, fx, fz);
      open = next;
    }
  };
  strip(0.07, -wl, 0.07, wr, 0.22, (dy) => bearing(dy) - 0.09, stone ? STONE : CONCRETE_DARK);
  strip(0, -wl, 0, wr, 0.36, (dy) => bearing(dy), stone ? STONE_DARK : CONCRETE, (dy) => bearing(dy) - 0.1);
  strip(0.2, -wl, 0.2, wr, 0.12, (dy) => dy - 0.035, stone ? STONE : CONCRETE_DARK, (dy) => bearing(dy) - 0.1);
  for (const [side, width] of [[-1, wl], [1, wr]]) {
    if (width < D.w - 0.01) continue; // no wing between parallel decks
    strip(0.11, side * width, 1.25, side * (width + 0.42), 0.1,
      (dy, t, gy) => Math.min(dy - 0.04, gy + 0.04 + (1 - t) * Math.min(1, Math.max(0, dy - gy))), stone ? STONE : CONCRETE_DARK);
  }
}

// ------------------------------------------------------------------------------ tunnels

/** Inside a tunnel section of f or close to one of its ends. */
function nearTunnel(f: NEdge, s: number): boolean {
  for (const q of f.sections) if (q.type === 'tunnel' && s > q.s0 - 0.4 && s < q.s1 + 0.4) return true;
  return false;
}

/** Portals at the ends of tunnel sections (one facade per group of parallel tracks). */
export function buildPortals(ctx: ChunkCtx, e: NEdge) {
  const net = ctx.game.world.net;
  for (const sec of e.sections) {
    if (sec.type !== 'tunnel' || sec.s1 - sec.s0 < 0.05) continue;
    if (ctx.game.railSections.structureAt(e.id, (sec.s0 + sec.s1) / 2)) continue;
    for (const [s, out] of [[sec.s0, -1], [sec.s1, 1]] as [number, number][]) {
      const atEnd = out < 0 ? s <= 0.05 : s >= e.len - 0.05;
      if (atEnd && (continuesAt(ctx, e, out < 0 ? e.a : e.b, 'tunnel') || buriedEnd(ctx, e, out < 0 ? e.a : e.b))) continue;
      const p = sampleAt(net.geo(e), s);
      if (!inChunk(ctx, p.x, p.z)) continue;
      const grp = parallelGroup(ctx, e, s, (f, sf) => nearTunnel(f, sf));
      if (grp.some((nb) => nb.edge.id < e.id)) continue;
      const offs = [0, ...grp.map((nb) => nb.off)];
      const { sF, depth } = portalPlace(ctx, e, s, out, portalOpenings(e, offs));
      buildPortal(ctx, e, sampleAt(net.geo(e), sF), out, offs, sF, depth);
    }
  }
}

/**
 * Where the facade stands and how deep the opening stays clear behind it. The terrain is a grid: the cut
 * face behind a tunnel boundary is a ramp about one unit long, so the facade goes to the toe of that ramp
 * (on the graded approach) and the opening ends in a dark curtain where the ground rises inside.
 */
function portalPlace(ctx: ChunkCtx, e: NEdge, s: number, out: number, ops: Opening[]): { sF: number; depth: number } {
  const w = ctx.game.world;
  const g = w.net.geo(e);
  const lat = [ops[0].c - ops[0].hw + 0.05, ...ops.map((o) => o.c), ops[ops.length - 1].c + ops[ops.length - 1].hw - 0.05];
  const rise = (t: number) => {
    const q = sampleAt(g, Math.max(0, Math.min(e.len, s + out * t)));
    let m = -Infinity;
    for (const l of lat) m = Math.max(m, w.heightAt(q.x + q.lx * l, q.z + q.lz * l) - q.y);
    return m;
  };
  let toe = 0;
  for (let t = 0; t <= 2 + 1e-6; t += 0.1) if (rise(t) <= 0.06) { toe = t; break; }
  const tF = Math.min(toe + 0.32, out > 0 ? e.len - s : s);
  // the dark interior stays shallow: deeper than this it would show above the ground behind the facade
  let depth = 0.6;
  for (let t = 0.26; t <= 0.6 + 1e-6; t += 0.04) if (rise(tF - t) > 0.06) { depth = t; break; }
  return { sF: s + out * tF, depth };
}

/** One arched opening of a portal: centre offset, half width, springing height and rise above the profile. */
interface Opening { c: number; hw: number; ys: number; rise: number }

/**
 * Openings of a portal for a group of parallel tracks (lateral offsets `offs`): one arch for one or two
 * tracks (about 5 m / 9.5 m wide, springing at 4.5-5 m), twin arches with a central pier for wider groups.
 */
function portalOpenings(e: NEdge, offs: number[]): Opening[] {
  if (e.kind !== 'rail') {
    const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
    const hw = rt.half + rt.sidewalk * 0.5 + 0.08;
    return [{ c: 0, hw, ys: 0.42, rise: Math.min(0.34, hw * 0.55) }];
  }
  const o = offs.slice().sort((a, b) => a - b);
  const CW = 0.26; // track centre to the wall at springing height
  const group = (list: number[]): Opening => {
    const a = list[0] - CW, b = list[list.length - 1] + CW, hw = (b - a) / 2;
    return { c: (a + b) / 2, hw, ys: list.length > 1 ? 0.5 : 0.45, rise: list.length > 1 ? hw * 0.82 : hw };
  };
  if (o.length <= 2) return [group(o)];
  // twin arches with a central pier where the middle tracks are far enough apart, else one wide flat arch
  const k = Math.ceil(o.length / 2);
  if (o[k] - o[k - 1] >= 2 * CW + 0.14) return [group(o.slice(0, k)), group(o.slice(k))];
  const one = group(o);
  return [{ ...one, ys: 0.48, rise: Math.min(one.hw * 0.55, 0.62) }];
}

/** Height of an opening's soffit above the profile at lateral offset l (null outside it). */
function soffit(op: Opening, l: number): number | null {
  const u = (l - op.c) / op.hw;
  if (u < -1 - 1e-6 || u > 1 + 1e-6) return null;
  return op.ys + op.rise * Math.sqrt(Math.max(0, 1 - u * u));
}

/** Portal openings and outer extent (for keep-outs and covers). */
function portalSpan(ctx: ChunkCtx, e: NEdge, s: number): { ops: Opening[]; lo: number; hi: number } {
  const grp = parallelGroup(ctx, e, s, (f, sf) => nearTunnel(f, sf));
  const ops = portalOpenings(e, [0, ...grp.map((nb) => nb.off)]);
  return { ops, lo: ops[0].c - ops[0].hw - 0.45, hi: ops[ops.length - 1].c + ops[ops.length - 1].hw + 0.45 };
}

/** Oriented keep-out box around a portal (facade, wing walls, cover mound) where no trees are drawn. */
export interface Keepout { x: number; z: number; ox: number; oz: number; lx: number; lz: number; f0: number; f1: number; l0: number; l1: number }

export function portalKeepouts(ctx: ChunkCtx, e: NEdge, out: Keepout[]) {
  const net = ctx.game.world.net;
  for (const sec of e.sections) {
    if (sec.type !== 'tunnel' || sec.s1 - sec.s0 < 0.05) continue;
    if (ctx.game.railSections.structureAt(e.id, (sec.s0 + sec.s1) / 2)) continue;
    for (const [s, o] of [[sec.s0, -1], [sec.s1, 1]] as [number, number][]) {
      const atEnd = o < 0 ? s <= 0.05 : s >= e.len - 0.05;
      if (atEnd && (continuesAt(ctx, e, o < 0 ? e.a : e.b, 'tunnel') || buriedEnd(ctx, e, o < 0 ? e.a : e.b))) continue;
      const p = sampleAt(net.geo(e), s);
      const { ops, lo, hi } = portalSpan(ctx, e, s);
      const gl = uncoveredLength(ctx, e, s, o, ops);
      out.push({ x: p.x, z: p.z, ox: p.tx * o, oz: p.tz * o, lx: p.lx, lz: p.lz, f0: -(gl + 0.9), f1: 2.3, l0: lo - 1.4, l1: hi + 1.4 });
    }
  }
}

export function inKeepout(k: Keepout, x: number, z: number): boolean {
  const dx = x - k.x, dz = z - k.z;
  const f = dx * k.ox + dz * k.oz, l = dx * k.lx + dz * k.lz;
  return f >= k.f0 && f <= k.f1 && l >= k.l0 && l <= k.l1;
}

/** Lining top above the profile (crown plus lining thickness). */
const liningTop = (ops: Opening[]) => Math.max(...ops.map((o) => o.ys + o.rise)) + 0.14;

/**
 * Length behind a portal (from its back face) where the ground does not yet cover the lining; 0 once the
 * hillside (backfilled by the planner) reaches over it.
 */
function uncoveredLength(ctx: ChunkCtx, e: NEdge, sb: number, out: number, ops: Opening[]): number {
  const w = ctx.game.world;
  const g = w.net.geo(e);
  const a = ops[0].c - ops[0].hw - 0.12, b = ops[ops.length - 1].c + ops[ops.length - 1].hw + 0.12;
  const top = liningTop(ops);
  let last = 0;
  for (let d = 0.25; d <= 4; d += 0.25) {
    const s = sb - out * (0.14 + d);
    if (s < 0 || s > e.len) break;
    const p = sampleAt(g, s);
    let ground = Infinity;
    for (const l of [a, (a + b) / 2, b]) ground = Math.min(ground, w.heightAt(p.x + p.lx * l, p.z + p.lz * l));
    if (ground < p.y + top - 0.02) last = d;
  }
  return last;
}

/**
 * Tunnel portal for a group of parallel tracks: a dressed-stone (or, on electrified lines and roads,
 * concrete) facade with pilasters, plinth course and coping, voussoir rings with keystones round the
 * arches, a dark arched lining fading into the hill, wing walls retaining the cutting, and a grassed cover
 * only where the hill does not yet cover the lining.
 */
function buildPortal(ctx: ChunkCtx, e: NEdge, p: Smp, out: number, offs: number[], sb: number, clear: number) {
  const w = ctx.game.world;
  const W = ctx.w;
  W.cast = 1;
  const rail = e.kind === 'rail';
  const ops = portalOpenings(e, offs);
  const crown = Math.max(...ops.map((o) => o.ys + o.rise));
  const Hf = crown + 0.55; // tallest facade
  const lo = ops[0].c - ops[0].hw - 0.45, hi = ops[ops.length - 1].c + ops[ops.length - 1].hw + 0.45;
  const ox = p.tx * out, oz = p.tz * out; // outward
  const lx = p.lx, lz = p.lz;
  const y = p.y;
  const modern = !rail;
  const cell = modern ? WC.CONCRETE : WC.STONE, sc = modern ? WSCALE.CONCRETE : WSCALE.STONE;
  const tone = modern ? CONCRETE : STONE, dark = modern ? CONCRETE_DARK : STONE_DARK;
  const light = modern ? 0xd6d2ca : 0xd2c4ad;
  const at = (l: number, f: number): [number, number] => [p.x + lx * l + ox * f, p.z + lz * l + oz * f];
  const P3 = (l: number, f: number, yy: number): [number, number, number] => [p.x + lx * l + ox * f, yy, p.z + lz * l + oz * f];
  const T = 0.24, ff = 0.06, fb = ff - T;
  const yb = y - 0.35;
  const soff = (l: number) => { for (const o of ops) { const h = soffit(o, l); if (h !== null) return y + h; } return null; };
  // facade top follows the hillside behind it (never floating above it), but always frames the arches
  const opDist = (l: number) => { let d = Infinity; for (const o of ops) d = Math.min(d, Math.max(0, Math.abs(l - o.c) - o.hw)); return d; };
  const behind = (l: number) => { const [ax, az] = at(l, fb - 0.15), [bx, bz] = at(l, fb - 0.6); return Math.max(w.heightAt(ax, az), w.heightAt(bx, bz)); };
  const topAt = (l: number) => {
    const k = Math.min(1, Math.max(0, (opDist(l) - 0.1) / 0.45));
    const minTop = y + crown + 0.2 - (crown - 0.15) * k * k * (3 - 2 * k);
    return Math.min(y + Hf, Math.max(behind(l) + 0.06, minTop));
  };
  // lateral breakpoints: regular columns plus the opening edges
  const cols: number[] = [];
  for (let l = lo; l < hi - 1e-6; l += 0.08) cols.push(l);
  cols.push(hi);
  for (const o of ops) cols.push(o.c - o.hw, o.c + o.hw);
  cols.sort((u, v) => u - v);
  const L: number[] = [];
  for (const l of cols) if (!L.length || l - L[L.length - 1] > 1e-4) L.push(l);
  const TOP = L.map(topAt);
  for (let i = 0; i < L.length - 1; i++) {
    const l0 = L[i], l1 = L[i + 1];
    const s0 = soff((l0 + l1) / 2) !== null;
    const b0 = s0 ? soff(l0)! : yb, b1 = s0 ? soff(l1)! : yb;
    const t0 = TOP[i], t1 = TOP[i + 1];
    const [fx0, fz0] = at(l0, ff), [fx1, fz1] = at(l1, ff), [bx0, bz0] = at(l0, fb), [bx1, bz1] = at(l1, fb);
    W.use(cell, tone);
    W.twall(fx0, fz0, fx1, fz1, b0, t0, b1, t1, ox, oz, sc, l0);
    W.twall(bx0, bz0, bx1, bz1, b0, t0, b1, t1, -ox, -oz, sc, l0);
    // coping: a cap over the facade top, overhanging the front
    W.use(cell, dark);
    const c0 = t0 + 0.04, c1 = t1 + 0.04;
    const [gx0, gz0] = at(l0, ff + 0.03), [gx1, gz1] = at(l1, ff + 0.03);
    W.twall(gx0, gz0, gx1, gz1, t0 - 0.015, c0, t1 - 0.015, c1, ox, oz, sc, l0);
    W.ttri(gx0, c0, gz0, 0, 0, gx1, c1, gz1, (l1 - l0) / sc, 0, bx1, c1, bz1, (l1 - l0) / sc, T / sc, 0, 1, 0);
    W.ttri(gx0, c0, gz0, 0, 0, bx1, c1, bz1, (l1 - l0) / sc, T / sc, bx0, c0, bz0, 0, T / sc, 0, 1, 0);
    W.twall(bx0, bz0, bx1, bz1, t0, c0, t1, c1, -ox, -oz, sc, l0);
    // plinth course along the foot (between the openings)
    if (!s0) {
      W.use(cell, dark);
      const [px0, pz0] = at(l0, ff + 0.02), [px1, pz1] = at(l1, ff + 0.02);
      W.twall(px0, pz0, px1, pz1, yb, y + 0.13, yb, y + 0.13, ox, oz, sc, l0);
      W.ttri(px0, y + 0.13, pz0, 0, 0, px1, y + 0.13, pz1, 0.1, 0, fx1, y + 0.13, fz1, 0.1, 0.05, 0, 1, 0);
      W.ttri(px0, y + 0.13, pz0, 0, 0, fx1, y + 0.13, fz1, 0.1, 0.05, fx0, y + 0.13, fz0, 0, 0.05, 0, 1, 0);
    }
  }
  // facade ends, pilasters (stone)
  W.use(cell, tone);
  {
    const [ax, az] = at(lo, ff), [bx, bz] = at(lo, fb), [cx, cz] = at(hi, ff), [dx, dz] = at(hi, fb);
    W.twall(ax, az, bx, bz, yb, TOP[0], yb, TOP[0], -lx, -lz, sc);
    W.twall(cx, cz, dx, dz, yb, TOP[TOP.length - 1], yb, TOP[TOP.length - 1], lx, lz, sc);
  }
  if (!modern) {
    for (const [a, b] of [[lo, lo + 0.16], [hi - 0.16, hi]]) {
      const top = Math.min(topAt(a), topAt(b)) - 0.01;
      W.use(cell, light);
      W.tbox((at((a + b) / 2, ff)[0]), yb, (at((a + b) / 2, ff)[1]), b - a, top - yb, 0.05, ox, oz, sc, false, false);
    }
  }
  // voussoir rings with keystones round each arch, impost blocks at the springing
  for (const o of ops) {
    const K = 13, RW = 0.085;
    for (let k = 0; k < K; k++) {
      const th0 = Math.PI * (1 - k / K), th1 = Math.PI * (1 - (k + 1) / K);
      const key = k === (K - 1) / 2;
      const out1 = RW + (key ? 0.03 : 0), pr = key ? 0.04 : 0.022;
      const ring = (th: number, ext: number): [number, number] => [o.c + Math.cos(th) * (o.hw + ext), y + o.ys + Math.sin(th) * (o.rise + ext)];
      const [i0l, i0y] = ring(th0, 0), [i1l, i1y] = ring(th1, 0), [o0l, o0y] = ring(th0, out1), [o1l, o1y] = ring(th1, out1);
      const tint = modern ? tone : (k & 1 ? light : tone);
      W.use(cell, key && !modern ? light : tint);
      const f1 = ff + pr;
      // front face
      W.ttri(...P3(i0l, f1, i0y), 0, 0, ...P3(i1l, f1, i1y), 0.1, 0, ...P3(o1l, f1, o1y), 0.1, 0.1, ox, 0, oz);
      W.ttri(...P3(i0l, f1, i0y), 0, 0, ...P3(o1l, f1, o1y), 0.1, 0.1, ...P3(o0l, f1, o0y), 0, 0.1, ox, 0, oz);
      // outer rim and soffit edge
      const mo = ((o0l + o1l) / 2 - o.c), my = (o0y + o1y) / 2 - (y + o.ys);
      W.ttri(...P3(o0l, ff, o0y), 0, 0, ...P3(o1l, ff, o1y), 0.1, 0, ...P3(o1l, f1, o1y), 0.1, 0.03, lx * mo, my, lz * mo);
      W.ttri(...P3(o0l, ff, o0y), 0, 0, ...P3(o1l, f1, o1y), 0.1, 0.03, ...P3(o0l, f1, o0y), 0, 0.03, lx * mo, my, lz * mo);
      W.use(cell, dark);
      W.ttri(...P3(i0l, ff, i0y), 0, 0, ...P3(i1l, ff, i1y), 0.1, 0, ...P3(i1l, f1, i1y), 0.1, 0.03, -lx * mo, -my, -lz * mo);
      W.ttri(...P3(i0l, ff, i0y), 0, 0, ...P3(i1l, f1, i1y), 0.1, 0.03, ...P3(i0l, f1, i0y), 0, 0.03, -lx * mo, -my, -lz * mo);
    }
    for (const sg of [-1, 1]) {
      const l0 = o.c + sg * o.hw, l1 = l0 + sg * 0.11;
      const [cx, cz] = at((l0 + l1) / 2, ff + 0.015);
      W.use(cell, modern ? tone : light);
      W.tbox(cx, y + o.ys - 0.05, cz, 0.11, 0.07, 0.03, ox, oz, sc, false, true);
    }
  }
  // dark arched lining inside (as deep as the opening stays clear), fading into a dark curtain
  const D0 = T - ff, D1 = Math.max(D0 + 0.08, clear);
  const RINGS = Math.max(1, Math.round((D1 - D0) / 0.35));
  const ringAt = (k: number) => sampleAt(w.net.geo(e), Math.max(0, Math.min(e.len, sb - out * (D0 + ((D1 - D0) * k) / RINGS))));
  const shade = (f: number) => { const v = Math.round(46 * (1 - f) * (1 - f) + 10); return (v << 16) | (v << 8) | Math.round(v * 0.92); };
  const Q = (S: Smp, l: number, h: number): [number, number, number] => [S.x + S.lx * l, S.y + h, S.z + S.lz * l];
  for (const o of ops) {
    const prof: [number, number][] = [[o.c - o.hw, -0.05], [o.c - o.hw, o.ys]];
    for (let j = 1; j < 10; j++) { const th = Math.PI * (1 - j / 10); prof.push([o.c + Math.cos(th) * o.hw, o.ys + Math.sin(th) * o.rise]); }
    prof.push([o.c + o.hw, o.ys], [o.c + o.hw, -0.05]);
    for (let k = 0; k < RINGS; k++) {
      const A = ringAt(k), B = ringAt(k + 1);
      const fm = (k + 0.5) / RINGS * Math.min(1, (D1 - D0) / 1.6);
      for (let j = 0; j < prof.length - 1; j++) {
        const [l0, h0] = prof[j], [l1, h1] = prof[j + 1];
        const nl = -(h1 - h0), nh = l1 - l0; // inward normal (towards the axis)
        W.use(WC.PLAIN, shade(fm), 0);
        W.ttri(...Q(A, l0, h0), 0, 0, ...Q(B, l0, h0), 0, 0, ...Q(B, l1, h1), 0, 0, A.lx * nl, nh, A.lz * nl);
        W.ttri(...Q(A, l0, h0), 0, 0, ...Q(B, l1, h1), 0, 0, ...Q(A, l1, h1), 0, 0, A.lx * nl, nh, A.lz * nl);
      }
      W.use(WC.PLAIN, shade(fm), 0);
      W.ttri(...Q(A, o.c - o.hw, 0.004), 0, 0, ...Q(B, o.c - o.hw, 0.004), 0, 0, ...Q(B, o.c + o.hw, 0.004), 0, 0, 0, 1, 0);
      W.ttri(...Q(A, o.c - o.hw, 0.004), 0, 0, ...Q(B, o.c + o.hw, 0.004), 0, 0, ...Q(A, o.c + o.hw, 0.004), 0, 0, 0, 1, 0);
    }
    // curtain: an arch-shaped fan, dark at the rim and black in the middle (reads as depth)
    const E = ringAt(RINGS);
    const ex = E.tx * out, ez = E.tz * out;
    const mid = Q(E, o.c, (o.ys + o.rise) * 0.45);
    const rimC = shade(Math.min(1, (D1 - D0) / 1.6));
    for (let j = 0; j < prof.length - 1; j++) {
      const a = Q(E, prof[j][0], prof[j][1]), b = Q(E, prof[j + 1][0], prof[j + 1][1]);
      const va = W.use(WC.PLAIN, rimC, 0);
      void va;
      const nx = ex, nz = ez;
      const i0 = W.vertex(a[0], a[1], a[2], nx, 0, nz), i1 = W.vertex(b[0], b[1], b[2], nx, 0, nz);
      W.color(0x050505);
      const i2 = W.vertex(mid[0], mid[1], mid[2], nx, 0, nz);
      // wind towards the opening (seen from outside)
      const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = mid[0] - a[0], vy = mid[1] - a[1], vz = mid[2] - a[2];
      const cx = uy * vz - uz * vy, cz = ux * vy - uy * vx;
      if (cx * nx + cz * nz >= 0) W.idx.push(i0, i1, i2); else W.idx.push(i0, i2, i1);
    }
    // the bottom edge of the fan (floor line)
    const fl = Q(E, o.c - o.hw, -0.05), fr = Q(E, o.c + o.hw, -0.05);
    W.use(WC.PLAIN, rimC, 0);
    const j0 = W.vertex(fl[0], fl[1], fl[2], ex, 0, ez), j1 = W.vertex(fr[0], fr[1], fr[2], ex, 0, ez);
    W.color(0x050505);
    const j2 = W.vertex(mid[0], mid[1], mid[2], ex, 0, ez);
    {
      const ux = fr[0] - fl[0], uy = fr[1] - fl[1], uz = fr[2] - fl[2], vx = mid[0] - fl[0], vy = mid[1] - fl[1], vz = mid[2] - fl[2];
      const cx = uy * vz - uz * vy, cz = ux * vy - uy * vx;
      if (cx * ex + cz * ez >= 0) W.idx.push(j0, j1, j2); else W.idx.push(j0, j2, j1);
    }
  }
  // the portal block behind the facade, as deep as the interior (buried in the hillside, it closes the view into
  // the opening from above): stone / concrete side walls like the facade, a grassed roof in the terrain's
  // earthwork colour (where the hill does not cover it yet it reads as the portal's earth cover, not a box)
  {
    const bl = lo + 0.08, br = hi - 0.08, dB = Math.max(D1 + 0.06, D0 + 0.1);
    const B0 = sampleAt(w.net.geo(e), Math.max(0, Math.min(e.len, sb - out * D0)));
    const B1 = sampleAt(w.net.geo(e), Math.max(0, Math.min(e.len, sb - out * dB)));
    const roof = (S: Smp) => S.y + crown + 0.16;
    const Q2 = (S: Smp, l: number, h: number): [number, number, number] => [S.x + S.lx * l, h, S.z + S.lz * l];
    const gs = WSCALE.GRASS;
    W.use(WC.GRASS, EARTHWORK_TINT, 1);
    const r00 = Q2(B0, bl, roof(B0)), r01 = Q2(B0, br, roof(B0)), r10 = Q2(B1, bl, roof(B1)), r11 = Q2(B1, br, roof(B1));
    W.ttri(...r00, r00[0] / gs, r00[2] / gs, ...r01, r01[0] / gs, r01[2] / gs, ...r11, r11[0] / gs, r11[2] / gs, 0, 1, 0);
    W.ttri(...r00, r00[0] / gs, r00[2] / gs, ...r11, r11[0] / gs, r11[2] / gs, ...r10, r10[0] / gs, r10[2] / gs, 0, 1, 0);
    W.use(cell, dark, 1);
    for (const [l, sg] of [[bl, -1], [br, 1]] as [number, number][]) {
      const a = Q2(B0, l, 0), b = Q2(B1, l, 0);
      W.twall(a[0], a[2], b[0], b[2], B0.y - 0.35, roof(B0), B1.y - 0.35, roof(B1), B0.lx * sg, B0.lz * sg, sc);
    }
    // back of the block (seen only where the hill behind is low)
    W.twall(r10[0], r10[2], r11[0], r11[2], B1.y - 0.35, roof(B1), B1.y - 0.35, roof(B1), -ox, -oz, sc);
  }
  // wing walls retaining the cutting: nearly parallel to the track, tops on the retained ground with a
  // coping, ending where the cutting gets shallow (omitted entirely in shallow cuttings)
  const T2 = 0.16;
  for (const sd of [-1, 1]) {
    const lEdge = sd < 0 ? lo : hi;
    const [sx, sz] = at(lEdge - sd * T2, ff);
    const ang = 0.22;
    const dx = ox * Math.cos(ang) + lx * sd * Math.sin(ang), dz = oz * Math.cos(ang) + lz * sd * Math.sin(ang);
    let nx = -dz * sd, nz = dx * sd; // away from the track
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    const pts: { x: number; z: number; t: number }[] = [];
    for (let k = 0; k <= 10; k++) {
      const t = k * 0.25;
      const qx = sx + dx * t, qz = sz + dz * t;
      const terr = Math.max(w.heightAt(qx + nx * (T2 + 0.15), qz + nz * (T2 + 0.15)), w.heightAt(qx + nx * (T2 + 0.5), qz + nz * (T2 + 0.5)));
      const top = Math.min(y + Hf, terr + 0.05);
      if (top < y + 0.3) break;
      pts.push({ x: qx, z: qz, t: top });
    }
    if (pts.length < 2) continue;
    for (let k = 0; k < pts.length - 1; k++) {
      const A = pts[k], B = pts[k + 1];
      const aox = A.x + nx * T2, aoz = A.z + nz * T2, box2 = B.x + nx * T2, boz = B.z + nz * T2;
      W.use(cell, tone);
      W.twall(A.x, A.z, B.x, B.z, yb, A.t, yb, B.t, -nx, -nz, sc, k * 0.25);
      W.twall(aox, aoz, box2, boz, yb, A.t, yb, B.t, nx, nz, sc, k * 0.25);
      // coping
      W.use(cell, dark);
      const cA = A.t + 0.035, cB = B.t + 0.035;
      const ix0 = A.x - nx * 0.025, iz0 = A.z - nz * 0.025, ix1 = B.x - nx * 0.025, iz1 = B.z - nz * 0.025;
      const ex0 = aox + nx * 0.025, ez0 = aoz + nz * 0.025, ex1 = box2 + nx * 0.025, ez1 = boz + nz * 0.025;
      W.twall(ix0, iz0, ix1, iz1, A.t - 0.01, cA, B.t - 0.01, cB, -nx, -nz, sc, k * 0.25);
      W.twall(ex0, ez0, ex1, ez1, A.t - 0.01, cA, B.t - 0.01, cB, nx, nz, sc, k * 0.25);
      W.ttri(ix0, cA, iz0, 0, 0, ix1, cB, iz1, 0.25 / sc, 0, ex1, cB, ez1, 0.25 / sc, T2 / sc, 0, 1, 0);
      W.ttri(ix0, cA, iz0, 0, 0, ex1, cB, ez1, 0.25 / sc, T2 / sc, ex0, cA, ez0, 0, T2 / sc, 0, 1, 0);
    }
    const E = pts[pts.length - 1];
    W.use(cell, tone);
    W.twall(E.x - nx * 0.025, E.z - nz * 0.025, E.x + nx * (T2 + 0.025), E.z + nz * (T2 + 0.025), yb, E.t + 0.035, yb, E.t + 0.035, dx, dz, sc);
  }
}

/** Samples along the tunnel from the portal inwards, ordered by increasing s (for sweeps). */
function tunnelRun(e: NEdge, ctx: ChunkCtx, sb: number, out: number, len: number): Smp[] {
  const g = ctx.game.world.net.geo(e);
  const n = Math.max(2, Math.ceil(len / 0.5) + 1);
  const run: Smp[] = [];
  for (let k = 0; k < n; k++) run.push(sampleAt(g, Math.max(0, Math.min(e.len, sb - out * (len * k) / (n - 1)))));
  run.sort((a, b) => a.s - b.s);
  return run;
}

export { WB };
