// Rail track geometry: ballast bed with sleepers, rails, catenary, buffer stops and signals.
import { RAIL, TRACK_TYPES } from '../game/constants';
import type { NEdge, NNode } from '../game/network';
import { ChunkCtx, Smp, edgeRuns, splitBySections, sweep, sampleAt, inChunk, mitre, PP } from './build-common';
import { STRIP_PERIOD } from './textures';
import { buildBridge, buildPortals, parallelSides } from './build-structures';

/** Height of the rail head above the edge profile (`prof` = top of ballast/sleepers). */
export const RAIL_TOP_Y = RAIL.railTop - RAIL.bedHeight;
/** Lateral offset of the rail head centres. */
export const RAIL_HEAD_OFF = RAIL.gauge / 2 + 0.0075;
/** Contact wire height above the profile on electrified track. */
export const WIRE_Y = RAIL_TOP_Y + 0.55;

const BALLAST = 0x8a8478;
const FORMATION = 0x6a6256;
const RAIL_SIDE = 0x6e5f52;
const RAIL_HEAD = 0xc4c0b8;

/** Small per-edge height offset so overlapping beds at switches don't z-fight. */
export function bedOffset(e: NEdge) { return (e.id % 3) * 0.0022; }

/** Track (ballast bed + rails) along a run. `bridge`: narrower bed without the embankment skirt. */
export function trackRun(ctx: ChunkCtx, e: NEdge, run: Smp[], bridge: boolean) {
  const yo = bedOffset(e);
  const conc = e.type === 'highspeed';
  const u0 = conc ? 0.504 : 0.004, u1 = conc ? 0.996 : 0.496;
  const T = RAIL.bedTop, top = -0.004;
  ctx.ballast.color(0xffffff);
  sweep(ctx.ballast, run, [[-T, top, u0], [T, top, u1]], STRIP_PERIOD, yo);
  const m = ctx.matte;
  if (bridge) {
    m.color(BALLAST);
    sweep(m, run, [[-0.235, -0.05], [-T, top]], 1, yo);
    sweep(m, run, [[T, top], [0.235, -0.05]], 1, yo);
  } else {
    m.color(BALLAST);
    sweep(m, run, [[-RAIL.bedBottom, -0.05], [-T, top]], 1, yo);
    sweep(m, run, [[T, top], [RAIL.bedBottom, -0.05]], 1, yo);
    m.color(FORMATION);
    sweep(m, run, [[-0.4, -0.28], [-0.38, -0.1], [-RAIL.bedBottom, -0.05]], 1, yo);
    sweep(m, run, [[RAIL.bedBottom, -0.05], [0.38, -0.1], [0.4, -0.28]], 1, yo);
  }
  const mt = ctx.metal;
  const H = RAIL_TOP_Y;
  for (const c of [-RAIL_HEAD_OFF, RAIL_HEAD_OFF]) {
    mt.color(RAIL_SIDE);
    sweep(mt, run, [[c - 0.011, top - 0.004], [c - 0.0075, H]], 1, yo);
    sweep(mt, run, [[c + 0.0075, H], [c + 0.011, top - 0.004]], 1, yo);
    mt.color(RAIL_HEAD);
    sweep(mt, run, [[c - 0.0075, H], [c + 0.0075, H]], 1, yo);
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
    if (part.type === 'bridge') buildBridge(ctx, e, part.s0, part.s1, runs);
  }
  buildPortals(ctx, e);
  if ((TRACK_TYPES[e.type] ?? TRACK_TYPES.standard).electrified) buildCatenary(ctx, e);
}

// ------------------------------------------------------------------------------ catenary

const MAST = 0x5d656b;
const WIRE = 0x2e3133;

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
  const mt = ctx.metal;
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
        mt.color(MAST);
        mt.box(mx, base, mz, 0.03, p.y + yo + 0.74 - base, 0.03, p.tx, p.tz, false);
        // cantilever arm and stay over the track
        const ax = p.x - p.lx * side * 0.02, az = p.z - p.lz * side * 0.02;
        mt.tube(mx, p.y + yo + 0.7, mz, ax, p.y + yo + 0.66, az, 0.006, 4);
        mt.tube(mx, p.y + yo + 0.56, mz, ax, p.y + yo + WIRE_Y + 0.01, az, 0.005, 4);
      }
    }
    if (i < pts.length - 1) {
      const q = pts[i + 1];
      if (inTunnel((p.s + q.s) / 2) || !inChunk(ctx, (p.x + q.x) / 2, (p.z + q.z) / 2)) continue;
      // contact wire (zig-zag stagger at the masts) and messenger wire
      const st = (k: number) => (k > 0 && k < pts.length - 1 ? ((k & 1) ? 0.02 : -0.02) : 0);
      const sa = st(i), sb = st(i + 1);
      mt.color(WIRE);
      mt.tube(p.x + p.lx * sa, p.y + yo + WIRE_Y, p.z + p.lz * sa, q.x + q.lx * sb, q.y + yo + WIRE_Y, q.z + q.lz * sb, 0.004, 3);
      const mid = sampleAt(g, (p.s + q.s) / 2);
      const hA = i > 0 ? 0.66 : WIRE_Y + 0.02, hB = i + 1 < pts.length - 1 ? 0.66 : WIRE_Y + 0.02;
      const hM = WIRE_Y + 0.025;
      mt.tube(p.x, p.y + yo + hA, p.z, mid.x, mid.y + yo + hM, mid.z, 0.003, 3);
      mt.tube(mid.x, mid.y + yo + hM, mid.z, q.x, q.y + yo + hB, q.z, 0.003, 3);
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
    const m = ctx.matte;
    m.color(0x6a6f73);
    m.box(x + d.x * 0.03, y - 0.004, z + d.z * 0.03, 0.2, 0.035, 0.07, d.x, d.z);
    m.color(0xb8382a);
    m.box(x, y + 0.012, z, 0.24, 0.05, 0.035, d.x, d.z);
    m.color(0xf2f2f0);
    m.box(x, y + 0.062, z, 0.24, 0.012, 0.036, d.x, d.z);
    const mt = ctx.metal;
    mt.color(0x2d2f31);
    for (const o of [-0.08, 0.08]) {
      const bx = x - d.z * o, bz = z + d.x * o;
      mt.tube(bx - d.x * 0.02, y + 0.04, bz - d.z * 0.02, bx + d.x * 0.045, y + 0.04, bz + d.z * 0.045, 0.012, 6);
    }
    return;
  }
  if (node.signal && node.edges.length === 2) buildSignals(ctx, node);
}

function buildSignals(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  for (const side of [1, -1]) {
    const sf = net.signalFor(node, side);
    if (!sf) continue;
    let out: NEdge | null = null;
    for (const id of node.edges) { const e = net.edges.get(id); if (e && net.sideAt(e, node.id) === side) out = e; }
    if (!out) continue;
    const d = net.leaveDir(out, node.id);
    // right-hand side of a train travelling along d
    const rx = -d.z, rz = d.x;
    const x = node.x + rx * 0.3 - d.x * 0.05, z = node.z + rz * 0.3 - d.z * 0.05;
    const y = node.y + bedOffset(out);
    const mt = ctx.metal, m = ctx.matte;
    if (sf > 0) {
      mt.color(0x4f5559);
      mt.cylinder(x, y - 0.1, z, 0.009, 0.62, 6);
      m.color(0x1c1e20);
      m.box(x, y + 0.42, z, 0.055, 0.13, 0.04, -d.x, -d.z, false);
      // sun hood
      m.box(x - d.x * 0.025, y + 0.53, z - d.z * 0.025, 0.05, 0.008, 0.03, -d.x, -d.z, false);
      ctx.sigLamps.push({ x: x - d.x * 0.022, y: y + 0.5, z: z - d.z * 0.022, edge: out.id });
    } else {
      // no-entry board for the blocked direction
      mt.color(0x9aa0a4);
      mt.cylinder(x, y - 0.1, z, 0.006, 0.4, 5);
      m.color(0xc8322a);
      m.box(x, y + 0.24, z, 0.08, 0.08, 0.008, -d.x, -d.z, false);
      m.color(0xffffff);
      m.box(x - d.x * 0.005, y + 0.275, z - d.z * 0.005, 0.06, 0.012, 0.004, -d.x, -d.z, false);
    }
  }
}

export type { PP };
