// Bridges (girder, steel truss, stone viaduct, concrete arch; piers, abutments) and tunnel portals.
import { RAIL, ROAD_TYPES, TRACK_TYPES } from '../game/constants';
import type { NEdge } from '../game/network';
import { closestOnPolyline } from '../game/geom';
import { ChunkCtx, Smp, PP, sweep, sampleAt, inChunk } from './build-common';
import { WB } from './build-mesh';
import { WC, WSCALE } from './textures';

const CONCRETE = 0xc9c5bc;
const CONCRETE_DARK = 0xaaa59c;
const STONE = 0xc4b49c;
const STONE_DARK = 0xa8987f;
const DARK = 0x07080a;

// ------------------------------------------------------------------------------ neighbours

interface Nb { edge: NEdge; s: number; off: number }

/** Parallel edges of the same kind at k * RAIL.spacing laterally (contiguous on each side), near the same height. */
export function parallelGroup(ctx: ChunkCtx, e: NEdge, s: number, pred?: (f: NEdge, sf: number) => boolean): Nb[] {
  const out: Nb[] = [];
  if (e.kind !== 'rail') return out;
  const net = ctx.game.world.net;
  const p = sampleAt(net.geo(e), s);
  for (const side of [-1, 1]) for (let k = 1; k <= 3; k++) {
    const off = side * k * RAIL.spacing;
    const ne = net.nearestEdge(p.x + p.lx * off, p.z + p.lz * off, 0.14, 'rail', (f) => f.id !== e.id);
    if (!ne) break;
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
    else if (L >= 8 && med >= 2.0) st = (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).electrified ? 'arch' : 'viaduct';
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
    abutment(ctx, e, s, gd, D, wl, wr, style);
  }
}

/** Pier under the deck at s (shifted along the bridge if another edge passes below). Returns the used s or null. */
function pier(ctx: ChunkCtx, e: NEdge, s: number, D: Dims, depth: number, wl: number, wr: number, scale: number): number | null {
  const w = ctx.game.world;
  const g = ctx.game.world.net.geo(e);
  for (const dsh of [0, 0.5, -0.5, 1, -1, 1.5, -1.5]) {
    const sp = s + dsh * scale;
    if (sp <= 0.3 || sp >= e.len - 0.3) continue;
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

/**
 * Abutment at a bridge end: a bearing block under the deck end and a back block reaching into the
 * embankment just below the track formation (so the embankment, not concrete, shows beside the track).
 */
function abutment(ctx: ChunkCtx, e: NEdge, s: number, gd: number, D: Dims, wl: number, wr: number, style: BridgeStyle) {
  const w = ctx.game.world;
  const g = ctx.game.world.net.geo(e);
  const p = sampleAt(g, s);
  if (!inChunk(ctx, p.x, p.z)) return;
  const W = ctx.w;
  W.cast = 1;
  const stone = style === 'viaduct';
  const cell = stone ? WC.STONE : WC.CONCRETE, sc = stone ? WSCALE.STONE : WSCALE.CONCRETE;
  const block = (a0: number, a1: number, l: number, r: number, top: number, tone: number) => {
    const along = gd * (a0 + a1) / 2, off = (r - l) / 2;
    const cx = p.x + p.tx * along + p.lx * off, cz = p.z + p.tz * along + p.lz * off;
    let gy = top;
    for (const t of [a0, a1]) for (const o of [-l, r]) gy = Math.min(gy, w.heightAt(p.x + p.tx * gd * t + p.lx * o, p.z + p.tz * gd * t + p.lz * o));
    gy -= 0.5;
    W.use(cell, tone);
    W.tbox(cx, gy, cz, l + r, top - gy, a1 - a0, p.tx, p.tz, sc);
  };
  // bearing block: as wide as the deck, top just under the deck
  block(-0.15, 0.22, wl, wr, p.y + D.top - 0.012, stone ? STONE : CONCRETE_DARK);
  // back block into the embankment, hidden under the formation
  const half = RAIL.spacing / 2;
  const bw = e.kind === 'rail' ? 0.39 : D.w - 0.03;
  const l = wl < D.w ? half : bw, r = wr < D.w ? half : bw;
  block(0.22, 0.85, l, r, p.y + (e.kind === 'rail' ? -0.11 : -0.05), stone ? STONE_DARK : CONCRETE_DARK);
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
    for (const [s, out] of [[sec.s0, -1], [sec.s1, 1]] as [number, number][]) {
      const atEnd = out < 0 ? s <= 0.05 : s >= e.len - 0.05;
      if (atEnd && (continuesAt(ctx, e, out < 0 ? e.a : e.b, 'tunnel') || buriedEnd(ctx, e, out < 0 ? e.a : e.b))) continue;
      const p = sampleAt(net.geo(e), s);
      if (!inChunk(ctx, p.x, p.z)) continue;
      const grp = parallelGroup(ctx, e, s, (f, sf) => nearTunnel(f, sf));
      if (grp.some((nb) => nb.edge.id < e.id)) continue;
      buildPortal(ctx, e, p, out, [0, ...grp.map((nb) => nb.off)], s);
    }
  }
}

/** Opening dimensions of a portal for an edge. */
function portalDims(e: NEdge) {
  const rail = e.kind === 'rail';
  const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
  const ow = rail ? 0.3 : rt.half + rt.sidewalk * 0.5 + 0.08;
  const oh = rail ? 0.78 : 0.66;
  return { ow, oh };
}

/** Oriented keep-out box around a portal (facade, wing walls, gallery) where no trees are drawn. */
export interface Keepout { x: number; z: number; ox: number; oz: number; lx: number; lz: number; f0: number; f1: number; l0: number; l1: number }

export function portalKeepouts(ctx: ChunkCtx, e: NEdge, out: Keepout[]) {
  const net = ctx.game.world.net;
  for (const sec of e.sections) {
    if (sec.type !== 'tunnel' || sec.s1 - sec.s0 < 0.05) continue;
    for (const [s, o] of [[sec.s0, -1], [sec.s1, 1]] as [number, number][]) {
      const atEnd = o < 0 ? s <= 0.05 : s >= e.len - 0.05;
      if (atEnd && (continuesAt(ctx, e, o < 0 ? e.a : e.b, 'tunnel') || buriedEnd(ctx, e, o < 0 ? e.a : e.b))) continue;
      const p = sampleAt(net.geo(e), s);
      const { ow, oh } = portalDims(e);
      const gl = galleryLength(ctx, e, s, o, oh + 0.1);
      out.push({ x: p.x, z: p.z, ox: p.tx * o, oz: p.tz * o, lx: p.lx, lz: p.lz, f0: -(gl + 1.0), f1: 2.3, l0: -(ow + 1.9), l1: ow + 1.9 });
    }
  }
}

export function inKeepout(k: Keepout, x: number, z: number): boolean {
  const dx = x - k.x, dz = z - k.z;
  const f = dx * k.ox + dz * k.oz, l = dx * k.lx + dz * k.lz;
  return f >= k.f0 && f <= k.f1 && l >= k.l0 && l <= k.l1;
}

function buildPortal(ctx: ChunkCtx, e: NEdge, p: Smp, out: number, offs: number[], sb: number) {
  const w = ctx.game.world;
  const W = ctx.w;
  W.cast = 1;
  const rail = e.kind === 'rail';
  const { ow, oh } = portalDims(e);
  const archH = ow * 0.75;
  const ys = oh - archH; // springing height (relative to the profile)
  const Hf = oh + 0.4;   // tallest facade
  const lo = Math.min(...offs) - ow - 0.5, hi = Math.max(...offs) + ow + 0.5;
  const ox = p.tx * out, oz = p.tz * out; // outward
  const lx = p.lx, lz = p.lz;
  const y = p.y;
  const modern = !rail || (TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).electrified;
  const cell = modern ? WC.CONCRETE : WC.STONE, sc = modern ? WSCALE.CONCRETE : WSCALE.STONE;
  const tone = modern ? CONCRETE : STONE, dark = modern ? CONCRETE_DARK : STONE_DARK;
  const at = (l: number, f: number): [number, number] => [p.x + lx * l + ox * f, p.z + lz * l + oz * f];
  const T = 0.2, ff = 0.06, fb = ff - T;
  const yb = y - 0.35;
  const ops = offs.slice().sort((a, b) => a - b).map((c) => [c - ow, c + ow] as [number, number]);
  const archY = (l: number) => {
    for (const [a, b] of ops) if (l >= a - 1e-6 && l <= b + 1e-6) { const c = (a + b) / 2, r = (b - a) / 2; return y + ys + archH * Math.sqrt(Math.max(0, 1 - ((l - c) / r) ** 2)); }
    return yb;
  };
  // facade top follows the hillside behind it (never floating above it), but always frames the arches
  const opDist = (l: number) => { let d = Infinity; for (const [a, b] of ops) d = Math.min(d, l < a ? a - l : l > b ? l - b : 0); return d; };
  const behind = (l: number) => { const [ax, az] = at(l, fb - 0.15), [bx, bz] = at(l, fb - 0.6); return Math.max(w.heightAt(ax, az), w.heightAt(bx, bz)); };
  const topAt = (l: number) => {
    const k = Math.min(1, Math.max(0, (opDist(l) - 0.08) / 0.4));
    const minTop = y + oh + 0.14 - (oh - 0.2) * k * k * (3 - 2 * k);
    return Math.min(y + Hf, Math.max(behind(l) + 0.06, minTop));
  };
  // lateral breakpoints: regular columns plus the opening edges
  const cols: number[] = [];
  for (let l = lo; l < hi - 1e-6; l += 0.1) cols.push(l);
  cols.push(hi);
  for (const [a, b] of ops) cols.push(a, b);
  cols.sort((u, v) => u - v);
  const L: number[] = [];
  for (const l of cols) if (!L.length || l - L[L.length - 1] > 1e-4) L.push(l);
  const TOP = L.map(topAt);
  for (let i = 0; i < L.length - 1; i++) {
    const l0 = L[i], l1 = L[i + 1], m = (l0 + l1) / 2;
    const inside = ops.some(([a, b]) => m > a && m < b);
    const b0 = inside ? archY(l0) : yb, b1 = inside ? archY(l1) : yb;
    const t0 = TOP[i], t1 = TOP[i + 1];
    const [fx0, fz0] = at(l0, ff), [fx1, fz1] = at(l1, ff), [bx0, bz0] = at(l0, fb), [bx1, bz1] = at(l1, fb);
    W.use(cell, tone);
    W.twall(fx0, fz0, fx1, fz1, b0, t0, b1, t1, ox, oz, sc, l0);
    W.twall(bx0, bz0, bx1, bz1, b0, t0, b1, t1, -ox, -oz, sc, l0);
    W.use(cell, dark);
    W.ttri(fx0, t0, fz0, 0, 0, fx1, t1, fz1, (l1 - l0) / sc, 0, bx1, t1, bz1, (l1 - l0) / sc, T / sc, 0, 1, 0);
    W.ttri(fx0, t0, fz0, 0, 0, bx1, t1, bz1, (l1 - l0) / sc, T / sc, bx0, t0, bz0, 0, T / sc, 0, 1, 0);
  }
  // facade ends
  W.use(cell, tone);
  {
    const [ax, az] = at(lo, ff), [bx, bz] = at(lo, fb), [cx, cz] = at(hi, ff), [dx, dz] = at(hi, fb);
    W.twall(ax, az, bx, bz, yb, TOP[0], yb, TOP[0], -lx, -lz, sc);
    W.twall(cx, cz, dx, dz, yb, TOP[TOP.length - 1], yb, TOP[TOP.length - 1], lx, lz, sc);
  }
  // --- opening reveals (jambs and arch soffit) and the dark gallery behind
  const gl = galleryLength(ctx, e, sb, out, oh + 0.1);
  const run = tunnelRun(e, ctx, sb - out * (T - ff), out, gl);
  for (const [a, b] of ops) {
    const c = (a + b) / 2, r = (b - a) / 2;
    W.use(cell, dark);
    const [a0x, a0z] = at(a, ff), [a1x, a1z] = at(a, fb), [b0x, b0z] = at(b, ff), [b1x, b1z] = at(b, fb);
    W.twall(a0x, a0z, a1x, a1z, y - 0.05, y + ys, y - 0.05, y + ys, lx, lz, sc);
    W.twall(b0x, b0z, b1x, b1z, y - 0.05, y + ys, y - 0.05, y + ys, -lx, -lz, sc);
    const K = 10;
    for (let k = 0; k < K; k++) {
      const l0 = a + (b - a) * (k / K), l1 = a + (b - a) * ((k + 1) / K);
      const h0 = y + ys + archH * Math.sqrt(Math.max(0, 1 - ((l0 - c) / r) ** 2)), h1 = y + ys + archH * Math.sqrt(Math.max(0, 1 - ((l1 - c) / r) ** 2));
      const [p0x, p0z] = at(l0, ff), [p1x, p1z] = at(l1, ff), [q0x, q0z] = at(l0, fb), [q1x, q1z] = at(l1, fb);
      const mx = (c - (l0 + l1) / 2) * lx, mz = (c - (l0 + l1) / 2) * lz;
      W.ttri(p0x, h0, p0z, 0, 0, p1x, h1, p1z, 0.2, 0, q1x, h1, q1z, 0.2, 0.2, mx, -1, mz);
      W.ttri(p0x, h0, p0z, 0, 0, q1x, h1, q1z, 0.2, 0.2, q0x, h0, q0z, 0, 0.2, mx, -1, mz);
    }
    // dark interior along the tunnel curve: walls and ceiling facing inwards, floor facing up
    W.use(WC.PLAIN, DARK);
    sweep(W, run, [[b, -0.05], [b, oh], [a, oh], [a, -0.05]]);
    sweep(W, run, [[a, 0.004], [b, 0.004]]);
    const pe = out > 0 ? run[0] : run[run.length - 1];
    const ex = pe.tx * out, ez = pe.tz * out;
    W.twall(pe.x + pe.lx * a, pe.z + pe.lz * a, pe.x + pe.lx * b, pe.z + pe.lz * b, pe.y - 0.05, pe.y + oh, pe.y - 0.05, pe.y + oh, ex, ez);
  }
  // cut-and-cover gallery behind the facade, earthed over like the hillside it re-creates
  {
    const a0 = ops[0][0] - 0.1, b0 = ops[ops.length - 1][1] + 0.1, top = oh + 0.1, sl = top + 0.35;
    W.use(WC.GRAVEL, 0x9a8f78);
    sweep(W, run, [[a0 - sl, -0.35, 0], [a0, top, sl * 1.41 / 0.5]], 0.5);
    sweep(W, run, [[b0, top, 0], [b0 + sl, -0.35, sl * 1.41 / 0.5]], 0.5);
    W.use(WC.GRAVEL, 0x86905e);
    sweep(W, run, [[a0, top, 0], [b0, top, (b0 - a0) / 0.5]], 0.5);
    // close the mound's front ends beside the facade
    const p0 = out > 0 ? run[run.length - 1] : run[0];
    const P = (l: number, h: number): [number, number, number] => [p0.x + p0.lx * l, p0.y + h, p0.z + p0.lz * l];
    W.use(WC.GRAVEL, 0x9a8f78);
    W.ttri(...P(a0 - sl, -0.35), 0, 0, ...P(a0, top), 1, 1, ...P(a0, -0.35), 1, 0, ox, 0, oz);
    W.ttri(...P(b0 + sl, -0.35), 0, 0, ...P(b0, top), 1, 1, ...P(b0, -0.35), 1, 0, ox, 0, oz);
  }
  // wing walls retaining the cutting: nearly parallel to the track, tops on the retained ground,
  // ending where the cutting gets shallow (omitted entirely in shallow cuttings)
  const T2 = 0.15;
  for (const sd of [-1, 1]) {
    const lEdge = sd < 0 ? lo : hi;
    const [sx, sz] = at(lEdge - sd * T2, ff);
    const ang = 0.22;
    const dx = ox * Math.cos(ang) + lx * sd * Math.sin(ang), dz = oz * Math.cos(ang) + lz * sd * Math.sin(ang);
    let nx = -dz * sd, nz = dx * sd; // away from the track
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl; nz /= nl;
    const pts: { x: number; z: number; t: number }[] = [];
    for (let k = 0; k <= 8; k++) {
      const t = k * 0.25;
      const qx = sx + dx * t, qz = sz + dz * t;
      const terr = Math.max(w.heightAt(qx + nx * (T2 + 0.15), qz + nz * (T2 + 0.15)), w.heightAt(qx + nx * (T2 + 0.5), qz + nz * (T2 + 0.5)));
      const top = Math.min(y + Hf, terr + 0.04);
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
      W.use(cell, dark);
      W.ttri(A.x, A.t, A.z, 0, 0, B.x, B.t, B.z, 0.25 / sc, 0, box2, B.t, boz, 0.25 / sc, T2 / sc, 0, 1, 0);
      W.ttri(A.x, A.t, A.z, 0, 0, box2, B.t, boz, 0.25 / sc, T2 / sc, aox, A.t, aoz, 0, T2 / sc, 0, 1, 0);
    }
    const E = pts[pts.length - 1];
    W.use(cell, tone);
    W.twall(E.x, E.z, E.x + nx * T2, E.z + nz * T2, yb, E.t, yb, E.t, dx, dz, sc);
  }
}

/** Gallery length behind a portal: until the terrain over the tunnel rises `rel` above the track (1..3 units). */
function galleryLength(ctx: ChunkCtx, e: NEdge, sb: number, out: number, rel: number): number {
  const w = ctx.game.world;
  const g = w.net.geo(e);
  for (let d = 0.5; d <= 3; d += 0.5) {
    const s = sb - out * d;
    if (s < 0 || s > e.len) return Math.max(1, d - 0.5);
    const p = sampleAt(g, s);
    if (w.heightAt(p.x, p.z) > p.y + rel + 0.1) return Math.max(1, d);
  }
  return 3;
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
