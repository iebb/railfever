// Rail track geometry: ballast bed with sleepers (textured, rails painted in for distance), steel rails,
// catenary, buffer stops and signals. Bed = world layer (no shadows); rails and furniture = detail layer.
import { RAIL, TRACK_TYPES } from '../game/constants';
import type { NEdge, NNode } from '../game/network';
import { ChunkCtx, Smp, edgeRuns, splitBySections, sweep, sampleAt, inChunk, mitre, PP, EARTHWORK_TINT } from './build-common';
import type { WB } from './build-mesh';
import { hash2 } from '../game/rng';
import { WC, WSCALE, BALLAST_PERIOD } from './textures';
import { buildBridge, buildPortals, parallelSides } from './build-structures';
import { buildRetainingWalls } from './build-walls';

/** Height of the rail head above the edge profile (`prof` = top of ballast/sleepers). */
export const RAIL_TOP_Y = RAIL.railTop - RAIL.bedHeight;
/** Lateral offset of the rail head centres. */
export const RAIL_HEAD_OFF = RAIL.gauge / 2 + 0.0075;
/** Contact wire height above the profile on electrified track. */
export const WIRE_Y = RAIL_TOP_Y + 0.55;

const BALLAST = 0xc4bdb2;
/** cess beside the ballast (gravel cell tinted to the terrain's earthwork soil, ≈ #6b5a45) */
const CESS = 0xd9c2a3;
const RAIL_SIDE = 0x6e5f52;
const RAIL_HEAD = 0xd4d0c8;

/** Small per-edge height offset so overlapping beds at switches don't z-fight. */
export function bedOffset(e: NEdge) { return (e.id % 3) * 0.0022; }

const G = WSCALE.GRAVEL;

/** Track (ballast bed + rails) along a run. `bridge`: narrower bed without the embankment skirt. */
export function trackRun(ctx: ChunkCtx, e: NEdge, run: Smp[], bridge: boolean) {
  const yo = bedOffset(e);
  const conc = e.type === 'highspeed';
  const T = RAIL.bedTop, top = -0.004;
  const W = ctx.w;
  W.cast = 0;
  W.use(conc ? WC.BALLAST_CONC : WC.BALLAST_WOOD, 0xffffff);
  sweep(W, run, [[-T, top, 0.01], [T, top, 0.99]], BALLAST_PERIOD, yo);
  W.use(WC.GRAVEL, BALLAST);
  if (bridge) {
    sweep(W, run, [[-0.235, -0.05, 0], [-T, top, 0.16]], G, yo);
    sweep(W, run, [[T, top, 0], [0.235, -0.05, 0.16]], G, yo);
  } else {
    const B = RAIL.bedBottom;
    // ballast shoulders with an irregular toe (spilled ballast), then the cess and the formation slope in
    // the terrain's earthwork colours (no dark bands)
    ballastShoulder(W, run, -1, T, top, B, yo);
    ballastShoulder(W, run, 1, T, top, B, yo);
    W.use(WC.GRAVEL, CESS);
    sweep(W, run, [[-0.38, -0.1, 0], [-B, -0.05, 0.2]], G, yo);
    sweep(W, run, [[B, -0.05, 0], [0.38, -0.1, 0.2]], G, yo);
    W.use(WC.GRASS, EARTHWORK_TINT);
    sweep(W, run, [[-0.4, -0.28, 0], [-0.38, -0.1, 0.25]], WSCALE.GRASS, yo);
    sweep(W, run, [[0.38, -0.1, 0], [0.4, -0.28, 0.25]], WSCALE.GRASS, yo);
  }
  // rails (detail layer)
  const D = ctx.d;
  const H = RAIL_TOP_Y;
  for (const c of [-RAIL_HEAD_OFF, RAIL_HEAD_OFF]) {
    D.use(WC.METAL, RAIL_SIDE);
    sweep(D, run, [[c - 0.011, top - 0.004], [c - 0.0075, H]], 1, yo);
    sweep(D, run, [[c + 0.0075, H], [c + 0.011, top - 0.004]], 1, yo);
    D.use(WC.METAL, RAIL_HEAD);
    sweep(D, run, [[c - 0.0075, H], [c + 0.0075, H]], 1, yo);
  }
}

/**
 * One ballast shoulder (side sg = -1 left / +1 right) from the sleeper ends (lateral T, height top) down to
 * the toe at B, densified to ~0.3 units with the toe pushed out by up to 0.035 (hashed on the world position,
 * so runs that meet at a chunk border agree) and dipping slightly: an irregular, spilled edge.
 */
function ballastShoulder(W: WB, run: Smp[], sg: number, T: number, top: number, B: number, yo: number) {
  const n = run.length;
  if (n < 2) return;
  const base = W.vertexCount;
  let cnt = 0;
  const emit = (x: number, y: number, z: number, lx: number, lz: number, s: number) => {
    const j = hash2(Math.round(x * 8), Math.round(z * 8), 911);
    const toe = B + 0.035 * j, dip = -0.05 - 0.012 * j;
    const ax = x + lx * T * sg, az = z + lz * T * sg, bx = x + lx * toe * sg, bz = z + lz * toe * sg;
    // face normal: up and outwards (as sweep's dl*up - dh*right)
    const dl = toe - T, dh = dip - top, el = Math.hypot(dl, dh) || 1;
    const nu = dl / el, nr = -dh / el * sg;
    const nx = lx * nr, nz = lz * nr, nl = Math.hypot(nx, nu, nz) || 1;
    const v = s / G;
    if (sg > 0) { W.vertex(ax, y + top + yo, az, nx / nl, nu / nl, nz / nl, 0, v); W.vertex(bx, y + dip + yo, bz, nx / nl, nu / nl, nz / nl, 0.3, v); }
    else { W.vertex(bx, y + dip + yo, bz, nx / nl, nu / nl, nz / nl, 0, v); W.vertex(ax, y + top + yo, az, nx / nl, nu / nl, nz / nl, 0.3, v); }
    cnt++;
  };
  for (let i = 0; i < n - 1; i++) {
    const A = run[i], C = run[i + 1];
    const k = Math.max(1, Math.ceil(Math.abs(C.s - A.s) / 0.3));
    for (let q = 0; q < k; q++) {
      const t = q / k;
      const lx = A.lx + (C.lx - A.lx) * t, lz = A.lz + (C.lz - A.lz) * t;
      emit(A.x + (C.x - A.x) * t, A.y + (C.y - A.y) * t, A.z + (C.z - A.z) * t, lx, lz, A.s + (C.s - A.s) * t);
    }
  }
  const L = run[n - 1];
  emit(L.x, L.y, L.z, L.lx, L.lz, L.s);
  // quads between consecutive samples: (a_i, b_i, b_i+1, a_i+1) as in sweep
  for (let i = 0; i < cnt - 1; i++) {
    const a = base + i * 2;
    W.idx.push(a, a + 1, a + 3, a, a + 3, a + 2);
  }
}

/** All geometry of one rail edge that falls into the chunk. */
export function buildRailEdge(ctx: ChunkCtx, e: NEdge) {
  const net = ctx.game.world.net;
  const ma = mitre(net, e, e.a), mb = mitre(net, e, e.b);
  for (const part of splitBySections(net, e, 0, e.len)) {
    if (part.type === 'tunnel') continue;
    const runs = edgeRuns(ctx, e, part.s0, part.s1, ma, mb);
    for (const run of runs) trackRun(ctx, e, run, part.type === 'bridge');
    // elevated station platforms sit on the station's own viaduct
    if (part.type === 'bridge' && ctx.stationEdges?.get(e.id) !== 'elevated') buildBridge(ctx, e, part.s0, part.s1, runs);
  }
  buildPortals(ctx, e);
  buildRetainingWalls(ctx, e);
  if ((TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).electrified) buildCatenary(ctx, e);
}

// ------------------------------------------------------------------------------ catenary

const MAST = 0x7d858b;
const WIRE = 0x3a3d3f;

function buildCatenary(ctx: ChunkCtx, e: NEdge) {
  const net = ctx.game.world.net;
  const g = net.geo(e);
  const R = isFinite(g.minRadius) ? g.minRadius : 1e9;
  const span = Math.max(1.5, Math.min(5, Math.sqrt(8 * R * 0.03)));
  const n = Math.max(1, Math.round(e.len / span));
  const step = e.len / n;
  // support points: masts at the middle of each step, wire ends at the edge ends
  const sup: number[] = [0];
  for (let k = 0; k < n; k++) sup.push((k + 0.5) * step);
  sup.push(e.len);
  const yo = bedOffset(e);
  const D = ctx.d;
  const pts = sup.map((s) => sampleAt(g, s));
  const inTunnel = (s: number) => net.sectionAt(e, s) === 'tunnel';
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0 && i < pts.length - 1 && !inTunnel(p.s) && inChunk(ctx, p.x, p.z)) {
      const sides = parallelSides(ctx, e, p.s);
      const side = !sides.right ? 1 : !sides.left ? -1 : 0;
      if (side !== 0) {
        const mx = p.x + p.lx * side * 0.36, mz = p.z + p.lz * side * 0.36;
        const bridge = net.sectionAt(e, p.s) === 'bridge';
        const base = p.y + yo - (bridge ? 0.06 : 0.12);
        D.use(WC.METAL, MAST);
        D.box(mx, base, mz, 0.03, p.y + yo + 0.74 - base, 0.03, p.tx, p.tz, false);
        D.use(WC.CONCRETE, 0xb8b4ac);
        if (!bridge) D.box(mx, base - 0.02, mz, 0.06, 0.06, 0.06, p.tx, p.tz);
        // cantilever arm and stay over the track
        D.use(WC.METAL, MAST);
        const ax = p.x - p.lx * side * 0.02, az = p.z - p.lz * side * 0.02;
        D.tube(mx, p.y + yo + 0.7, mz, ax, p.y + yo + 0.66, az, 0.006, 4);
        D.tube(mx, p.y + yo + 0.56, mz, ax, p.y + yo + WIRE_Y + 0.01, az, 0.005, 4);
      }
    }
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      if (inTunnel((p.s + q.s) / 2) || !inChunk(ctx, (p.x + q.x) / 2, (p.z + q.z) / 2)) continue;
      // contact wire (zig-zag stagger at the masts) and messenger wire
      const st = (k: number) => (k > 0 && k < pts.length - 1 ? ((k & 1) ? 0.02 : -0.02) : 0);
      const sa = st(i), sb = st(i + 1);
      D.use(WC.METAL, WIRE);
      D.tube(p.x + p.lx * sa, p.y + yo + WIRE_Y, p.z + p.lz * sa, q.x + q.lx * sb, q.y + yo + WIRE_Y, q.z + q.lz * sb, 0.004, 3);
      const mid = sampleAt(g, (p.s + q.s) / 2);
      const hA = i > 0 ? 0.66 : WIRE_Y + 0.02, hB = i + 1 < pts.length - 1 ? 0.66 : WIRE_Y + 0.02;
      const hM = WIRE_Y + 0.025;
      D.tube(p.x, p.y + yo + hA, p.z, mid.x, mid.y + yo + hM, mid.z, 0.003, 3);
      D.tube(mid.x, mid.y + yo + hM, mid.z, q.x, q.y + yo + hB, q.z, 0.003, 3);
    }
  }
}

// ------------------------------------------------------------------------------ nodes

/** Buffer stops at dead ends and signals. */
export function buildRailNode(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  if (node.edges.length === 1) {
    const e = net.edges.get(node.edges[0]);
    if (!e || e.depot >= 0 || net.sectionAt(e, e.a === node.id ? 0 : e.len) === 'tunnel') return;
    const d = net.leaveDir(e, node.id);
    const yo = bedOffset(e);
    const x = node.x + d.x * 0.08, z = node.z + d.z * 0.08, y = node.y + yo;
    const D = ctx.d;
    D.use(WC.CONCRETE, 0xa8a49c);
    D.box(x + d.x * 0.03, y - 0.004, z + d.z * 0.03, 0.2, 0.035, 0.07, d.x, d.z);
    D.use(WC.PLAIN, 0xb8382a);
    D.box(x, y + 0.012, z, 0.24, 0.05, 0.035, d.x, d.z);
    D.use(WC.PLAIN, 0xf2f2f0);
    D.box(x, y + 0.062, z, 0.24, 0.012, 0.036, d.x, d.z);
    D.use(WC.METAL, 0x2d2f31);
    for (const o of [-0.08, 0.08]) {
      const bx = x - d.z * o, bz = z + d.x * o;
      D.tube(bx - d.x * 0.02, y + 0.04, bz - d.z * 0.02, bx + d.x * 0.045, y + 0.04, bz + d.z * 0.045, 0.012, 6);
    }
    return;
  }
  if (node.signal && node.edges.length === 2) buildSignals(ctx, node);
}

/**
 * Signals at a node, one per direction a train may leave in (a red no-entry board where it may not).
 * Path signals (junctions, station entries, starters): two-lens head with a white diamond plate;
 * block signals (open line): one-lens head with a white plate with a black band; one-way signals passable
 * from behind carry a small yellow plate; starters (leaving a platform) a route indicator above the head.
 */
function buildSignals(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  const block = node.signalKind === 'block';
  for (const side of [1, -1]) {
    const sf = net.signalFor(node, side);
    if (!sf) continue;
    let out: NEdge | null = null, other: NEdge | null = null;
    for (const id of node.edges) {
      const e = net.edges.get(id);
      if (!e) continue;
      if (net.sideAt(e, node.id) === side) out = e; else other = e;
    }
    if (!out) continue;
    const d = net.leaveDir(out, node.id);
    // right-hand side of a train travelling along d
    const rx = -d.z, rz = d.x;
    const x = node.x + rx * 0.3 - d.x * 0.05, z = node.z + rz * 0.3 - d.z * 0.05;
    const y = node.y + bedOffset(out);
    const D = ctx.d;
    const fx = -d.x, fz = -d.z; // faces the train
    if (sf > 0) {
      const starter = !block && !!other && other.station >= 0 && out.station < 0;
      D.use(WC.METAL, 0x5a6064);
      D.cylinder(x, y - 0.1, z, 0.009, starter ? 0.72 : 0.62, 6);
      const top = y + 0.52;
      D.use(WC.PLAIN, 0x1c1e20);
      if (block) {
        D.box(x, top - 0.08, z, 0.05, 0.08, 0.04, fx, fz, false);
        D.box(x + fx * 0.02, top - 0.005, z + fz * 0.02, 0.046, 0.007, 0.03, fx, fz, false);
        ctx.sigLamps.push({ x: x + fx * 0.022, y: top - 0.04, z: z + fz * 0.022, edge: out.id });
        // white plate with a black band (automatic block signal)
        D.use(WC.PLAIN, 0xf2f2ee);
        D.box(x + fx * 0.012, top - 0.16, z + fz * 0.012, 0.05, 0.04, 0.004, fx, fz, false);
        D.use(WC.PLAIN, 0x1c1e20);
        D.box(x + fx * 0.015, top - 0.145, z + fz * 0.015, 0.052, 0.01, 0.003, fx, fz, false);
      } else {
        D.box(x, top - 0.13, z, 0.055, 0.13, 0.04, fx, fz, false);
        D.box(x + fx * 0.02, top - 0.005, z + fz * 0.02, 0.05, 0.007, 0.03, fx, fz, false);
        ctx.sigLamps.push({ x: x + fx * 0.022, y: top - 0.035, z: z + fz * 0.022, edge: out.id });
        // dark second lens
        D.use(WC.PLAIN, 0x3a3d40);
        D.box(x + fx * 0.021, top - 0.1, z + fz * 0.021, 0.024, 0.024, 0.004, fx, fz, false);
        // white diamond plate (path signal)
        const px = x + fx * 0.012, pz = z + fz * 0.012, py = top - 0.2, h = 0.026;
        const ux = -fz, uz = fx;
        D.use(WC.PLAIN, 0xf4f4f0);
        D.ttri(px - ux * h, py, pz - uz * h, 0, 0, px + ux * h, py, pz + uz * h, 0, 0, px, py + h, pz, 0, 0, fx, 0, fz);
        D.ttri(px - ux * h, py, pz - uz * h, 0, 0, px, py - h, pz, 0, 0, px + ux * h, py, pz + uz * h, 0, 0, fx, 0, fz);
        if (starter) {
          // route indicator box above the head (station starter)
          D.use(WC.PLAIN, 0x1c1e20);
          D.box(x, top + 0.005, z, 0.06, 0.05, 0.035, fx, fz, false);
          D.use(WC.LAMP, 0xf6f2e4);
          D.box(x + fx * 0.018, top + 0.022, z + fz * 0.018, 0.026, 0.016, 0.004, fx, fz, false);
        }
      }
      if (node.signalPass && node.signal >= 2) {
        // passable from behind: small yellow plate on the back of the mast
        D.use(WC.PLAIN, 0xe8c230);
        D.box(x - fx * 0.012, y + 0.2, z - fz * 0.012, 0.03, 0.03, 0.004, fx, fz, false);
      }
    } else {
      // no-entry board for the blocked direction
      D.use(WC.METAL, 0x9aa0a4);
      D.cylinder(x, y - 0.1, z, 0.006, 0.4, 5);
      D.use(WC.PLAIN, 0xc8322a);
      D.box(x, y + 0.24, z, 0.08, 0.08, 0.008, fx, fz, false);
      D.use(WC.PLAIN, 0xffffff);
      D.box(x + fx * 0.005, y + 0.275, z + fz * 0.005, 0.06, 0.012, 0.004, fx, fz, false);
    }
  }
}

export type { PP };
