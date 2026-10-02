// Road geometry: carriageways with markings, kerbed sidewalks, junction plates with stop lines, lamps,
// bus stops and level crossings. Surfaces = world layer (no shadows); furniture = detail layer.
import { ROAD_TYPES, RAIL, LANE_OFFSET } from '../game/constants';
import type { Network, NEdge, NNode, Crossing } from '../game/network';
import type { Station } from '../game/stations';
import { ChunkCtx, Smp, edgeRuns, splitBySections, sweep, sampleAt, inChunk, mitre, upTri, wallQuad, PP, onStationForecourt } from './build-common';
import { WC, WSCALE, STRIP_PERIOD, TRAM_BED_HALF, TRAM_BED_PERIOD } from './textures';
import { distToRect } from '../game/world';
import { buildBridge, buildPortals } from './build-structures';
import { RAIL_TOP_Y } from './build-rail';

const PAVING = 0xd8d2c6;
const KERB = 0xd6d2ca;
const VERGE = 0x9a9476;
const EARTH = 0x8f8170;
const KERB_H = 0.018;
const PS = WSCALE.PAVING;

export function roadType(e: NEdge) { return ROAD_TYPES[e.type] ?? ROAD_TYPES.road; }

/** Width of the paved area (carriageway + sidewalk) of a road edge. */
function paved(e: NEdge) { const rt = roadType(e); return rt.half + rt.sidewalk; }

/**
 * Render trim radius at a road node: at least the network junction radius, more for sharp angles so the
 * paved areas of adjacent roads don't overlap beyond the junction plate. 0 = plain continuation (mitre).
 */
export function nodeTrim(net: Network, nodeId: number): number {
  const jr = net.junctionRadius(nodeId);
  if (jr <= 0) return 0;
  const node = net.nodes.get(nodeId)!;
  const dirs: { a: number; w: number }[] = [];
  for (const id of node.edges) {
    const e = net.edges.get(id);
    if (!e) continue;
    const d = net.leaveDir(e, nodeId);
    dirs.push({ a: Math.atan2(d.z, d.x), w: paved(e) });
  }
  dirs.sort((p, q) => p.a - q.a);
  let r = jr;
  for (let i = 0; i < dirs.length; i++) {
    const p = dirs[i], q = dirs[(i + 1) % dirs.length];
    let gap = q.a - p.a;
    if (i === dirs.length - 1) gap += Math.PI * 2;
    if (gap < Math.PI * 0.95 && gap > 0.05) r = Math.max(r, Math.max(p.w, q.w) / Math.tan(gap / 2) + 0.06);
  }
  return Math.min(r, 2.5);
}

/** Trimmed arc-length range of a road edge. */
export function roadRange(net: Network, e: NEdge): [number, number] {
  const ra = nodeTrim(net, e.a), rb = nodeTrim(net, e.b);
  return [Math.min(ra, e.len * 0.45), Math.max(e.len - rb, e.len * 0.55)];
}

function roadRun(ctx: ChunkCtx, e: NEdge, run: Smp[], bridge: boolean) {
  const rt = roadType(e);
  const h = rt.half, sw = rt.sidewalk;
  const street = sw > 0;
  const W = ctx.w;
  W.cast = 0;
  const cell = street ? WC.ROAD_STREET : WC.ROAD_COUNTRY, tint = e.owner < 0 ? 0xf4f4f4 : 0xffffff;
  if (e.tram) {
    // tram tracks in both lanes: asphalt | bed | asphalt (centre) | bed | asphalt, all flush
    const L = LANE_OFFSET, B = TRAM_BED_HALF;
    const u = (l: number) => 0.01 + (0.98 * (l + h)) / (2 * h);
    for (const [a, b] of [[-h, -L - B], [-L + B, L - B], [L + B, h]]) {
      W.use(cell, tint);
      sweep(W, run, [[a, 0, u(a)], [b, 0, u(b)]], STRIP_PERIOD);
    }
    W.use(WC.TRAMBED, 0xffffff);
    for (const c of [-L, L]) sweep(W, run, [[c - B, 0, 0.01], [c + B, 0, 0.99]], TRAM_BED_PERIOD);
  } else {
    W.use(cell, tint);
    sweep(W, run, [[-h, 0, 0.01], [h, 0, 0.99]], STRIP_PERIOD);
  }
  const low = bridge ? -0.005 : -0.25;
  if (street) {
    const Wd = h + sw;
    W.use(WC.GRAVEL, EARTH);
    sweep(W, run, [[-Wd - 0.01, low, 0], [-Wd, KERB_H, 0.5]], 0.5);
    sweep(W, run, [[Wd, KERB_H, 0], [Wd + 0.01, low, 0.5]], 0.5);
    W.use(WC.PAVING, PAVING);
    sweep(W, run, [[-Wd, KERB_H, 0], [-h - 0.018, KERB_H, (sw - 0.018) / PS]], PS);
    sweep(W, run, [[h + 0.018, KERB_H, 0], [Wd, KERB_H, (sw - 0.018) / PS]], PS);
    W.use(WC.CONCRETE, KERB);
    sweep(W, run, [[-h - 0.018, KERB_H, 0], [-h, KERB_H, 0.02], [-h, -0.002, 0.04]], 1);
    sweep(W, run, [[h, -0.002, 0], [h, KERB_H, 0.02], [h + 0.018, KERB_H, 0.04]], 1);
  } else if (bridge) {
    W.use(WC.CONCRETE, 0xbdb9b0);
    sweep(W, run, [[-h - 0.08, 0, 0], [-h, 0, 0.08]], 1);
    sweep(W, run, [[h, 0, 0], [h + 0.08, 0, 0.08]], 1);
  } else {
    // gravel shoulder, then a grass verge sloping to the formation
    W.use(WC.GRAVEL, VERGE);
    sweep(W, run, [[-h - 0.035, -0.012, 0], [-h, -0.002, 0.07]], 0.5);
    sweep(W, run, [[h, -0.002, 0], [h + 0.035, -0.012, 0.07]], 0.5);
    W.use(WC.GRASS, 0xe8ecd8);
    sweep(W, run, [[-h - 0.1, -0.04, 0], [-h - 0.035, -0.012, 0.08]], WSCALE.GRASS);
    sweep(W, run, [[h + 0.035, -0.012, 0], [h + 0.1, -0.04, 0.08]], WSCALE.GRASS);
    W.use(WC.GRAVEL, EARTH);
    sweep(W, run, [[-h - 0.12, low, 0], [-h - 0.1, -0.04, 0.4]], 0.5);
    sweep(W, run, [[h + 0.1, -0.04, 0], [h + 0.12, low, 0.4]], 0.5);
  }
}

export function buildRoadEdge(ctx: ChunkCtx, e: NEdge) {
  const net = ctx.game.world.net;
  const [sa, sb] = roadRange(net, e);
  const ma = nodeTrim(net, e.a) === 0 ? mitre(net, e, e.a) : null;
  const mb = nodeTrim(net, e.b) === 0 ? mitre(net, e, e.b) : null;
  for (const part of splitBySections(net, e, sa, sb)) {
    if (part.type === 'tunnel') continue;
    const runs = edgeRuns(ctx, e, part.s0, part.s1, ma, mb);
    for (const run of runs) roadRun(ctx, e, run, part.type === 'bridge');
    if (part.type === 'bridge') {
      // the deck spans the whole bridge section even where the road is trimmed at a junction
      const full = e.sections.find((q) => q.type === 'bridge' && q.s0 <= part.s0 + 1e-6 && q.s1 >= part.s1 - 1e-6);
      buildBridge(ctx, e, full ? Math.max(full.s0, part.s0) : part.s0, full ? Math.min(full.s1, part.s1) : part.s1, runs);
    }
    if (e.tram) tramLine(ctx, e, part.s0, part.s1, runs, part.type === 'bridge');
    if (part.type === 'ground' && e.depot < 0) {
      if (roadType(e).sidewalk > 0) { if (!e.tram) streetLamps(ctx, e, part.s0, part.s1); streetTrees(ctx, e, part.s0, part.s1); }
      else roadFurniture(ctx, e, part.s0, part.s1);
    }
  }
  buildPortals(ctx, e);
}

/** Contact wire height above the road surface. */
export const TRAM_WIRE_Y = 0.55;
const POLE = 0x4c5358, CWIRE = 0x2b2e30;

/** Overhead line along a tram edge: poles at both kerbs with a span wire (and lamps), one contact wire per lane. */
function tramLine(ctx: ChunkCtx, e: NEdge, s0: number, s1: number, runs: Smp[][], bridge: boolean) {
  const g = ctx.game.world.net.geo(e);
  const rt = roadType(e);
  const D = ctx.d;
  const step = 3.5;
  const off = rt.sidewalk > 0 ? rt.half + rt.sidewalk * 0.45 : rt.half + (bridge ? 0.06 : 0.14);
  const base = rt.sidewalk > 0 ? KERB_H : bridge ? 0 : -0.02;
  const keep = clearOf(ctx, e);
  // depot stubs: only the contact wires (they run on into the hall)
  for (let k = Math.ceil((s0 + 0.4) / step); e.depot < 0 && k * step <= s1 - 0.4; k++) {
    const s = k * step;
    const p = sampleAt(g, s);
    if (!inChunk(ctx, p.x, p.z)) continue;
    const near = keep.some((q) => Math.abs(q - s) < 0.5);
    const ax = p.x - p.lx * off, az = p.z - p.lz * off, bx = p.x + p.lx * off, bz = p.z + p.lz * off;
    const y0 = p.y + base;
    D.use(WC.METAL, POLE);
    for (const [x, z] of [[ax, az], [bx, bz]]) if (!near) D.cylinder(x, y0, z, 0.011, 0.72, 6);
    // span wire across the road, hangers down to the contact wires
    D.use(WC.METAL, CWIRE);
    D.tube(ax, y0 + 0.66, az, bx, y0 + 0.66, bz, 0.003, 3);
    for (const c of [-LANE_OFFSET, LANE_OFFSET]) {
      const hx = p.x + p.lx * c, hz = p.z + p.lz * c;
      D.tube(hx, y0 + 0.66, hz, hx, p.y + TRAM_WIRE_Y, hz, 0.002, 3);
    }
    // a street lamp on every other pole
    if (!near && (k & 1)) {
      D.use(WC.LAMP, 0xfff1c8);
      const lx = bx - p.lx * 0.1, lz = bz - p.lz * 0.1;
      D.box(lx, y0 + 0.6, lz, 0.06, 0.018, 0.03, -p.lx, -p.lz, true);
      ctx.lights.push(lx, y0 + 0.59, lz);
    }
  }
  // contact wires along the lanes (chunk-local runs)
  D.use(WC.METAL, CWIRE);
  for (const run of runs) for (const c of [-LANE_OFFSET, LANE_OFFSET]) {
    for (let i = 0; i < run.length - 1; i++) {
      const a = run[i], b = run[i + 1];
      D.tube(a.x + a.lx * c, a.y + TRAM_WIRE_Y, a.z + a.lz * c, b.x + b.lx * c, b.y + TRAM_WIRE_Y, b.z + b.lz * c, 0.0035, 3);
    }
  }
}

/** End of a lane curve (position and travel direction) at its start or end. */
function laneEnd(c: { pts: Float32Array; cum: Float32Array }, atEnd: boolean) {
  const p = c.pts, n = c.cum.length;
  const i = atEnd ? n - 1 : 0, j = atEnd ? n - 2 : 1;
  let dx = p[i * 3] - p[j * 3], dz = p[i * 3 + 2] - p[j * 3 + 2];
  if (!atEnd) { dx = -dx; dz = -dz; }
  const l = Math.hypot(dx, dz) || 1;
  return { x: p[i * 3], y: p[i * 3 + 1], z: p[i * 3 + 2], dx: dx / l, dz: dz / l };
}

/** Rails (raised steel strips) and contact wire along a polyline of points (x,y,z). */
function tramRails(ctx: ChunkCtx, pts: number[]) {
  const D = ctx.d;
  const n = pts.length / 3;
  if (n < 2) return;
  const G2 = RAIL.gauge / 2 + 0.006;
  for (let i = 0; i < n - 1; i++) {
    const ax = pts[i * 3], ay = pts[i * 3 + 1], az = pts[i * 3 + 2], bx = pts[i * 3 + 3], by = pts[i * 3 + 4], bz = pts[i * 3 + 5];
    const dx = bx - ax, dz = bz - az, l = Math.hypot(dx, dz) || 1;
    const rx = -dz / l, rz = dx / l;
    D.use(WC.METAL, 0x8f8a84);
    for (const o of [-G2, G2]) {
      const x0 = ax + rx * (o - 0.006), z0 = az + rz * (o - 0.006), x1 = ax + rx * (o + 0.006), z1 = az + rz * (o + 0.006);
      const x2 = bx + rx * (o + 0.006), z2 = bz + rz * (o + 0.006), x3 = bx + rx * (o - 0.006), z3 = bz + rz * (o - 0.006);
      D.ttri(x0, ay + 0.004, z0, 0, 0, x1, ay + 0.004, z1, 0, 0, x2, by + 0.004, z2, 0, 0, 0, 1, 0);
      D.ttri(x0, ay + 0.004, z0, 0, 0, x2, by + 0.004, z2, 0, 0, x3, by + 0.004, z3, 0, 0, 0, 1, 0);
    }
    D.use(WC.METAL, CWIRE);
    D.tube(ax, ay + TRAM_WIRE_Y, az, bx, by + TRAM_WIRE_Y, bz, 0.0035, 3);
  }
}

/** Tram tracks and wires across a junction: straight-through pairs, and turns for arms without one. */
function tramJunction(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  const arms: NEdge[] = [];
  for (const id of node.edges) { const e = net.edges.get(id); if (e && e.kind === 'road' && e.tram) arms.push(e); }
  if (!arms.length) return;
  const R = nodeTrim(net, node.id);
  // lane stretches between the road strip end and the lane end (they run over the junction plate)
  for (const e of arms) {
    const atA = e.a === node.id;
    const [sa, sb] = roadRange(net, e);
    const jr = net.junctionRadius(node.id);
    const sLane = atA ? Math.min(jr, e.len * 0.45) : Math.max(e.len - jr, e.len * 0.55);
    const sStrip = atA ? sa : sb;
    if (Math.abs(sStrip - sLane) > 0.02) {
      const g = net.geo(e);
      for (const c of [-LANE_OFFSET, LANE_OFFSET]) {
        const pts: number[] = [];
        for (let k = 0; k <= 4; k++) {
          const p = sampleAt(g, sLane + ((sStrip - sLane) * k) / 4);
          pts.push(p.x + p.lx * c, p.y, p.z + p.lz * c);
        }
        tramRails(ctx, pts);
      }
    }
  }
  if (arms.length < 2 || R <= 0) return;
  const dirs = arms.map((e) => net.leaveDir(e, node.id));
  const pairs: [number, number][] = [];
  const straight = new Set<number>();
  for (let i = 0; i < arms.length; i++) for (let j = i + 1; j < arms.length; j++) {
    if (dirs[i].x * dirs[j].x + dirs[i].z * dirs[j].z < -0.85) { pairs.push([i, j]); straight.add(i); straight.add(j); }
  }
  for (let i = 0; i < arms.length; i++) if (!straight.has(i)) for (let j = 0; j < arms.length; j++) if (j !== i && !pairs.some(([a, b]) => (a === i && b === j) || (a === j && b === i))) pairs.push([i, j]);
  for (const [i, j] of pairs) {
    for (const [A, B] of [[arms[i], arms[j]], [arms[j], arms[i]]]) {
      // arrive on A (towards the node), leave on B (away from it)
      const inA = net.lane(A, A.b === node.id ? 1 : -1), outB = net.lane(B, B.a === node.id ? 1 : -1);
      const p0 = laneEnd(inA, true), p3 = laneEnd(outB, false);
      const dist = Math.hypot(p3.x - p0.x, p3.z - p0.z);
      if (dist < 0.03) continue;
      const dot = p0.dx * p3.dx + p0.dz * p3.dz;
      const k = dot < -0.5 ? Math.max(0.36, dist * 0.9) : dist * 0.42;
      const c1x = p0.x + p0.dx * k, c1z = p0.z + p0.dz * k, c2x = p3.x - p3.dx * k, c2z = p3.z - p3.dz * k;
      const pts: number[] = [];
      for (let q = 0; q <= 10; q++) {
        const t = q / 10, u = 1 - t;
        pts.push(u * u * u * p0.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p3.x, p0.y + (p3.y - p0.y) * t,
          u * u * u * p0.z + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * p3.z);
      }
      tramRails(ctx, pts);
    }
  }
}

/** Positions (arc lengths) on edge e that street furniture must keep clear of: stops and level crossings. */
function clearOf(ctx: ChunkCtx, e: NEdge): number[] {
  const out: number[] = [];
  for (const st of ctx.game.stations.map.values()) for (const p of st.stops) if (p.edge === e.id) out.push(p.s);
  for (const c of ctx.game.world.net.crossings.values()) if (c.e2 === e.id) out.push(c.s2);
  return out;
}

/** Street trees in the sidewalk near the kerb (staggered on both sides), clear of lamps, stops and buildings. */
function streetTrees(ctx: ChunkCtx, e: NEdge, s0: number, s1: number) {
  const w = ctx.game.world;
  const g = w.net.geo(e);
  const rt = roadType(e);
  const step = 1.4, lampStep = 2.8;
  const keep = clearOf(ctx, e);
  for (const side of [-1, 1]) {
    const shift = side > 0 ? 0.5 : 0;
    const k0 = Math.ceil((s0 + 0.75) / step - shift), k1 = Math.floor((s1 - 0.75) / step - shift);
    for (let k = k0; k <= k1; k++) {
      const s = (k + shift) * step;
      // street lamps stand on alternating sides every lampStep
      const lk = Math.round(s / lampStep);
      if (Math.abs(s - lk * lampStep) < 0.45 && (((lk + e.id) & 1) ? 1 : -1) === side) continue;
      if (keep.some((q) => Math.abs(q - s) < 0.9)) continue;
      const h = ((e.id * 73856093) ^ (k * 19349663) ^ (side * 83492791)) >>> 0;
      if ((h % 7) === 0) continue; // occasional gap
      const p = sampleAt(g, s);
      const off = side * (rt.half + 0.075);
      const x = p.x + p.lx * off, z = p.z + p.lz * off;
      if (!inChunk(ctx, x, z)) continue;
      // room to the nearest building front decides the tree size (skip when there is none)
      let room = 1;
      for (const b of w.buildingsNear(x, z, 2)) {
        if (b.type === 8) continue; // parks are fine next to trees
        room = Math.min(room, distToRect(x, z, b.x, b.z, b.angle, b.w / 2, b.d / 2));
      }
      if (room < 0.16) continue;
      const y = p.y + KERB_H;
      const hv = (h % 1000) / 1000;
      const size = Math.min(0.55, 0.3 + room * 0.7) * (0.85 + 0.15 * ((h >> 10) % 100) / 100);
      ctx.trees.push({ type: hv < 0.7 ? 0 : 1, x, y: y - 0.005, z, s: size, rot: hv * 6.28, tint: ((h >> 4) % 100) / 100 });
      ctx.d.use(WC.METAL, 0x2a2d2f);
      ctx.d.box(x, y, z, 0.11, 0.004, 0.11, p.tx, p.tz);
    }
  }
}

/** Country roads: reflector posts on both verges and an occasional distance marker. */
function roadFurniture(ctx: ChunkCtx, e: NEdge, s0: number, s1: number) {
  const g = ctx.game.world.net.geo(e);
  const rt = roadType(e);
  const D = ctx.d;
  const keep = clearOf(ctx, e);
  const step = 5;
  for (let k = Math.ceil((s0 + 0.8) / step); k * step <= s1 - 0.8; k++) {
    const s = k * step;
    if (keep.some((q) => Math.abs(q - s) < 1.2)) continue;
    const p = sampleAt(g, s);
    for (const side of [-1, 1]) {
      const off = side * (rt.half + 0.13);
      const x = p.x + p.lx * off, z = p.z + p.lz * off;
      if (!inChunk(ctx, x, z)) continue;
      const y = p.y - 0.03;
      D.use(WC.PLAIN, 0xf2f2ee, 0);
      D.box(x, y, z, 0.014, 0.12, 0.014, p.tx, p.tz);
      D.use(WC.PLAIN, 0x1d1d1d, 0);
      D.box(x, y + 0.085, z, 0.0145, 0.022, 0.0145, p.tx, p.tz);
      D.use(WC.PLAIN, side > 0 ? 0xd9601a : 0xeeeeee, 0);
      D.box(x - p.lx * side * 0.0075, y + 0.092, z - p.lz * side * 0.0075, 0.006, 0.008, 0.002, -p.lx * side, -p.lz * side);
    }
    // distance marker every 6th post on the right-hand verge
    if (((k + e.id) % 6) === 0) {
      const off = rt.half + 0.2;
      const x = p.x + p.lx * off, z = p.z + p.lz * off;
      if (inChunk(ctx, x, z)) {
        D.use(WC.METAL, 0x9aa0a4, 0);
        D.box(x, p.y - 0.03, z, 0.01, 0.16, 0.01, p.tx, p.tz);
        D.use(WC.PLAIN, 0xf4f4f0, 0);
        D.box(x, p.y + 0.1, z, 0.06, 0.05, 0.006, -p.lx, -p.lz, true);
      }
    }
  }
}

/** Lamp post with an arm and a night-emissive lamp head (detail layer) plus a glow point. */
export function lampPost(ctx: ChunkCtx, x: number, y: number, z: number, ax: number, az: number, h = 0.62, arm = 0.14) {
  const D = ctx.d;
  D.use(WC.METAL, 0x50565b);
  D.cylinder(x, y, z, 0.008, h, 5);
  const hx = x + ax * arm, hz = z + az * arm;
  D.tube(x, y + h - 0.02, z, hx, y + h, hz, 0.005, 4);
  D.use(WC.LAMP, 0xfff1c8);
  D.box(hx, y + h - 0.025, hz, 0.06, 0.018, 0.03, ax, az, true);
  ctx.lights.push(hx, y + h - 0.04, hz);
}

function streetLamps(ctx: ChunkCtx, e: NEdge, s0: number, s1: number) {
  const net = ctx.game.world.net;
  const g = net.geo(e);
  const rt = roadType(e);
  const step = 2.8;
  const k0 = Math.ceil((s0 + 0.6) / step), k1 = Math.floor((s1 - 0.6) / step);
  for (let k = k0; k <= k1; k++) {
    const p = sampleAt(g, k * step);
    if (!inChunk(ctx, p.x, p.z)) continue;
    const side = ((k + e.id) & 1) ? 1 : -1;
    const off = side * (rt.half + rt.sidewalk * 0.7);
    lampPost(ctx, p.x + p.lx * off, p.y + KERB_H, p.z + p.lz * off, -p.lx * side, -p.lz * side);
  }
}

// ------------------------------------------------------------------------------ junctions

interface Arm { e: NEdge; x: number; y: number; z: number; dx: number; dz: number; w: number; sw: number; a: number }

function qbez(a: number, c: number, b: number, t: number) { const u = 1 - t; return u * u * a + 2 * u * t * c + t * t * b; }

/** Corner fillet control point: intersection of the kerb lines through A (dir -da) and B (dir -db). */
function filletCtrl(ax: number, az: number, dax: number, daz: number, bx: number, bz: number, dbx: number, dbz: number): [number, number] | null {
  const den = -dax * dbz + daz * dbx;
  if (Math.abs(den) < 1e-4) return null;
  const rx = bx - ax, rz = bz - az;
  const t = (rx * dbz - rz * dbx) / den;
  const u = (-dax * rz + daz * rx) / den;
  if (t < -0.02 || u < -0.02 || t > 4 || u > 4) return null;
  return [ax - dax * t, az - daz * t];
}

const STOP_W = 0.035;

export function buildRoadNode(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  tramJunction(ctx, node);
  const R = nodeTrim(net, node.id);
  if (node.edges.length === 1) { deadEnd(ctx, node); return; }
  if (R <= 0) return;
  const arms: Arm[] = [];
  for (const id of node.edges) {
    const e = net.edges.get(id);
    if (!e || e.kind !== 'road') continue;
    const [sa, sb] = roadRange(net, e);
    const atA = e.a === node.id;
    const p = sampleAt(net.geo(e), atA ? sa : sb);
    const dx = atA ? p.tx : -p.tx, dz = atA ? p.tz : -p.tz;
    const rt = roadType(e);
    arms.push({ e, x: p.x, y: p.y, z: p.z, dx, dz, w: rt.half, sw: rt.sidewalk, a: Math.atan2(dz, dx) });
  }
  if (arms.length < 2) return;
  arms.sort((p, q) => p.a - q.a);
  const cy = node.y;
  const W = ctx.w;
  W.cast = 0;
  const bnd: number[] = []; // plate boundary (x,y,z), increasing angle
  const SEG = 6;
  const stopLines = arms.length >= 3;
  // end zone of each arm (between the trimmed strip end and the plate): stop line, zebra crossing on streets
  const zoneD = (A: Arm) => (stopLines ? STOP_W + (A.sw > 0 ? 0.12 : 0) : 0);
  const zone = (A: Arm, Z: number) => {
    const rx = -A.dz, rz = A.dx; // right of the outward arm direction
    const P = (l: number, d: number): [number, number] => [A.x + rx * l - A.dx * d, A.z + rz * l - A.dz * d];
    const q = (l0: number, l1: number, d0: number, d1: number, white: boolean) => {
      const [ax, az] = P(l0, d0), [bx, bz] = P(l1, d0), [cx, cz] = P(l1, d1), [dx, dz] = P(l0, d1);
      if (white) W.use(WC.PLAIN, 0xe8e8e2); else W.use(WC.ASPHALT, 0xffffff);
      upTri(W, ax, A.y, az, bx, A.y, bz, cx, A.y, cz, WSCALE.ASPHALT);
      upTri(W, ax, A.y, az, cx, A.y, cz, dx, A.y, dz, WSCALE.ASPHALT);
    };
    // stop line across the incoming lane (left of the outward direction)
    q(-A.w, 0, 0, STOP_W, true);
    q(0, A.w, 0, STOP_W, false);
    if (Z > STOP_W + 1e-6) {
      q(-A.w, A.w, STOP_W, STOP_W + 0.015, false);
      const n = Math.max(3, Math.round((2 * A.w) / 0.09));
      for (let k = 0; k < 2 * n; k++) {
        const l0 = -A.w + (2 * A.w * k) / (2 * n), l1 = -A.w + (2 * A.w * (k + 1)) / (2 * n);
        q(l0, l1, STOP_W + 0.015, Z, k % 2 === 0);
      }
    }
  };
  for (let i = 0; i < arms.length; i++) {
    const A = arms[i], B = arms[(i + 1) % arms.length];
    const ZA = zoneD(A), ZB = zoneD(B);
    // corners at the inner edge of the end zone (plate side)
    const ix = A.x - A.dx * ZA, iz = A.z - A.dz * ZA;
    const lAx = ix + A.dz * A.w, lAz = iz - A.dx * A.w; // left corner of A
    const rAx = ix - A.dz * A.w, rAz = iz + A.dx * A.w; // right corner of A
    if (stopLines) zone(A, ZA);
    bnd.push(lAx, A.y, lAz, ix, A.y, iz, rAx, A.y, rAz);
    // fillet from A's right kerb to B's left kerb (computed on the outer corners for a clean curve)
    const oAx = A.x - A.dz * A.w, oAz = A.z + A.dx * A.w, oBx = B.x + B.dz * B.w, oBz = B.z - B.dx * B.w;
    const c = filletCtrl(oAx, oAz, A.dx, A.dz, oBx, oBz, B.dx, B.dz);
    const cx = c ? c[0] : (oAx + oBx) / 2, cz = c ? c[1] : (oAz + oBz) / 2;
    for (let k = 1; k < SEG; k++) {
      const t = k / SEG;
      bnd.push(qbez(oAx, cx, oBx, t), A.y + (B.y - A.y) * t, qbez(oAz, cz, oBz, t));
    }
    // gap pieces between the end-zone inner corners and the outer corners (asphalt)
    if (stopLines) {
      W.use(WC.ASPHALT, 0xffffff);
      upTri(W, rAx, A.y, rAz, oAx, A.y, oAz, qbez(oAx, cx, oBx, 1 / SEG), A.y + (B.y - A.y) / SEG, qbez(oAz, cz, oBz, 1 / SEG), WSCALE.ASPHALT);
      const iBx = B.x - B.dx * ZB + B.dz * B.w, iBz = B.z - B.dz * ZB - B.dx * B.w;
      upTri(W, iBx, B.y, iBz, qbez(oAx, cx, oBx, (SEG - 1) / SEG), A.y + (B.y - A.y) * (SEG - 1) / SEG, qbez(oAz, cz, oBz, (SEG - 1) / SEG), oBx, B.y, oBz, WSCALE.ASPHALT);
    }
    // sidewalk ring along the fillet
    const swA = A.sw, swB = B.sw;
    if (swA > 0 || swB > 0) {
      const pAx = A.x - A.dz * (A.w + swA), pAz = A.z + A.dx * (A.w + swA);
      const pBx = B.x + B.dz * (B.w + swB), pBz = B.z - B.dx * (B.w + swB);
      const oc = filletCtrl(pAx, pAz, A.dx, A.dz, pBx, pBz, B.dx, B.dz);
      const ocx = oc ? oc[0] : (pAx + pBx) / 2, ocz = oc ? oc[1] : (pAz + pBz) / 2;
      let px = oAx, pz = oAz, qx = pAx, qz = pAz, py = A.y;
      for (let k = 1; k <= SEG; k++) {
        const t = k / SEG;
        const nx = qbez(oAx, cx, oBx, t), nz = qbez(oAz, cz, oBz, t);
        const ox = qbez(pAx, ocx, pBx, t), oz = qbez(pAz, ocz, pBz, t);
        const ny = A.y + (B.y - A.y) * t;
        W.use(WC.PAVING, PAVING);
        upTri(W, px, py + KERB_H, pz, qx, py + KERB_H, qz, ox, ny + KERB_H, oz, PS);
        upTri(W, px, py + KERB_H, pz, ox, ny + KERB_H, oz, nx, ny + KERB_H, nz, PS);
        W.use(WC.CONCRETE, KERB);
        wallQuad(W, px, pz, nx, nz, py - 0.002, py + KERB_H, ny - 0.002, ny + KERB_H, node.x - (px + nx) / 2, node.z - (pz + nz) / 2);
        W.use(WC.GRAVEL, EARTH);
        wallQuad(W, qx, qz, ox, oz, py - 0.25, py + KERB_H, ny - 0.25, ny + KERB_H, (qx + ox) / 2 - node.x, (qz + oz) / 2 - node.z, 0.5);
        px = nx; pz = nz; qx = ox; qz = oz; py = ny;
      }
    }
  }
  W.use(WC.ASPHALT, 0xffffff);
  const n = bnd.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    upTri(W, node.x, cy, node.z, bnd[i * 3], bnd[i * 3 + 1], bnd[i * 3 + 2], bnd[j * 3], bnd[j * 3 + 1], bnd[j * 3 + 2], WSCALE.ASPHALT);
  }
}

function deadEnd(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  const e = net.edges.get(node.edges[0]);
  if (!e || e.kind !== 'road' || e.depot >= 0) return;
  const rt = roadType(e);
  if (rt.sidewalk <= 0) return;
  // access streets end on a station forecourt: no turning circle
  if (onStationForecourt(ctx.game, node.x, node.z, 0.35)) return;
  if (net.sectionAt(e, e.a === node.id ? 0 : e.len) !== 'ground') return;
  const p = sampleAt(net.geo(e), e.a === node.id ? 0 : e.len);
  const ox = e.a === node.id ? -p.tx : p.tx, oz = e.a === node.id ? -p.tz : p.tz;
  const rx = -oz, rz = ox;
  const W = ctx.w;
  W.cast = 0;
  const Wd = rt.half, S = rt.half + rt.sidewalk;
  const SEG = 10;
  const pt = (r: number, k: number): [number, number] => {
    const a = (k / SEG) * Math.PI;
    const c = Math.cos(a), s = Math.sin(a);
    return [p.x + rx * r * c + ox * r * s, p.z + rz * r * c + oz * r * s];
  };
  for (let k = 0; k < SEG; k++) {
    const [ax, az] = pt(Wd, k), [bx, bz] = pt(Wd, k + 1);
    W.use(WC.ASPHALT, 0xffffff);
    upTri(W, p.x, p.y, p.z, ax, p.y, az, bx, p.y, bz, WSCALE.ASPHALT);
    const [cx, cz] = pt(S, k), [dx, dz] = pt(S, k + 1);
    W.use(WC.PAVING, PAVING);
    upTri(W, ax, p.y + KERB_H, az, cx, p.y + KERB_H, cz, dx, p.y + KERB_H, dz, PS);
    upTri(W, ax, p.y + KERB_H, az, dx, p.y + KERB_H, dz, bx, p.y + KERB_H, bz, PS);
    W.use(WC.CONCRETE, KERB);
    wallQuad(W, ax, az, bx, bz, p.y - 0.002, p.y + KERB_H, p.y - 0.002, p.y + KERB_H, p.x - (ax + bx) / 2, p.z - (az + bz) / 2);
    W.use(WC.GRAVEL, EARTH);
    wallQuad(W, cx, cz, dx, dz, p.y - 0.25, p.y + KERB_H, p.y - 0.25, p.y + KERB_H, (cx + dx) / 2 - p.x, (cz + dz) / 2 - p.z, 0.5);
  }
}

// ------------------------------------------------------------------------------ bus stops

export function buildBusStops(ctx: ChunkCtx, st: Station, color: number) {
  const net = ctx.game.world.net;
  for (const stop of st.stops) {
    if (!inChunk(ctx, stop.x, stop.z)) continue;
    const e = net.edges.get(stop.edge);
    if (!e) continue;
    const p = sampleAt(net.geo(e), stop.s);
    const rt = roadType(e);
    const street = rt.sidewalk > 0;
    for (const side of [-1, 1]) {
      const off = side * (street ? rt.half + rt.sidewalk * 0.62 : rt.half + 0.2);
      const x = p.x + p.lx * off, z = p.z + p.lz * off;
      const fx = p.lx * side, fz = p.lz * side; // away from the road
      const W = ctx.w, D = ctx.d;
      const tram = !!e.tram;
      if (!street) {
        W.cast = 0;
        W.use(WC.PAVING, PAVING);
        W.tbox(x - fx * 0.04, p.y - 0.06, z - fz * 0.04, tram ? 1.3 : 0.5, tram ? 0.1 : 0.075, 0.2, fx, fz, PS);
      } else if (tram) {
        // raised boarding platform along the kerb with a yellow tactile edge
        const bx = p.x + p.lx * side * (rt.half + 0.07), bz = p.z + p.lz * side * (rt.half + 0.07);
        W.cast = 0;
        W.use(WC.PAVING, 0xcfcac0);
        W.tbox(bx, p.y + KERB_H - 0.01, bz, 1.3, 0.035, 0.14, fx, fz, PS);
        W.use(WC.PLAIN, 0xe3c02b);
        W.box(bx - fx * 0.055, p.y + KERB_H + 0.025, bz - fz * 0.055, 1.24, 0.002, 0.02, fx, fz);
      }
      const yb = street ? p.y + KERB_H + (tram ? 0.025 : 0) : p.y + (tram ? 0.04 : 0.015);
      // back wall (glass), roof, posts, bench
      D.use(WC.PLAIN, 0x8fb3c8);
      D.box(x + fx * 0.05, yb + 0.02, z + fz * 0.05, 0.34, 0.2, 0.01, fx, fz, false);
      D.use(WC.METAL, 0x3a3f44);
      D.box(x + fx * 0.01, yb + 0.235, z + fz * 0.01, 0.38, 0.014, 0.13, fx, fz, false);
      for (const a of [-0.17, 0.17]) D.box(x + fz * a + fx * 0.05, yb, z - fx * a + fz * 0.05, 0.012, 0.235, 0.012, fx, fz);
      D.use(WC.PLAIN, 0x6b4f36);
      D.box(x + fx * 0.025, yb + 0.045, z + fz * 0.025, 0.24, 0.012, 0.04, fx, fz, false);
      // sign pole with company colour (tram stops add a 'T' plate)
      const sx = x - fz * 0.27, sz = z + fx * 0.27;
      D.use(WC.METAL, 0x9aa0a6);
      D.cylinder(sx, yb, sz, 0.006, tram ? 0.36 : 0.3, 5);
      D.use(WC.PLAIN, color);
      D.box(sx, yb + 0.24, sz, 0.008, 0.07, 0.07, fx, fz, false);
      if (tram) {
        // green plate facing along the road with a white 'T' on both faces
        D.use(WC.PLAIN, 0x1f6b45);
        D.box(sx, yb + 0.3, sz, 0.008, 0.06, 0.06, fx, fz, false);
        D.use(WC.PLAIN, 0xffffff);
        for (const o of [-0.0055, 0.0055]) {
          const px = sx + fz * o, pz = sz - fx * o;
          D.box(px, yb + 0.342, pz, 0.004, 0.01, 0.04, fx, fz, false);
          D.box(px, yb + 0.309, pz, 0.004, 0.033, 0.01, fx, fz, false);
        }
      }
    }
  }
}

// ------------------------------------------------------------------------------ level crossings

export function buildCrossing(ctx: ChunkCtx, c: Crossing) {
  if (c.kind !== 'level' || !inChunk(ctx, c.x, c.z)) return;
  const net = ctx.game.world.net;
  const er = net.edges.get(c.e1), ed = net.edges.get(c.e2);
  if (!er || !ed) return;
  const pr = sampleAt(net.geo(er), c.s1), pd = sampleAt(net.geo(ed), c.s2);
  const rt = roadType(ed);
  const Wd = rt.half + rt.sidewalk + 0.02;
  // panel: intersection of the rail strip |b| <= B and the road strip
  const dotTL = pr.tx * pd.lx + pr.tz * pd.lz;
  const tl = Math.abs(dotTL) < 0.3 ? (dotTL < 0 ? -0.3 : 0.3) : dotTL;
  const lrl = pr.lx * pd.lx + pr.lz * pd.lz;
  const base = (pr.x - pd.x) * pd.lx + (pr.z - pd.z) * pd.lz;
  const corner = (b: number, sw: number): [number, number] => {
    const a = (sw * Wd - base - b * lrl) / tl;
    return [pr.x + pr.tx * a + pr.lx * b, pr.z + pr.tz * a + pr.lz * b];
  };
  const yTop = pr.y + RAIL_TOP_Y - 0.004;
  const yRoad = pd.y;
  const W = ctx.w;
  W.cast = 0;
  // neighbouring level crossings of the same road over parallel tracks: one continuous panel between them
  const nbSide = [false, false]; // [-1 side, +1 side] relative to the rail
  const nbAlong = [false, false]; // another crossing before this one for road travel [+s, -s]
  for (const o of net.crossings.values()) {
    if (o.id === c.id || o.kind !== 'level' || o.e2 !== c.e2 || Math.abs(o.s2 - c.s2) > 1.2) continue;
    const lat = (o.x - c.x) * pr.lx + (o.z - c.z) * pr.lz;
    if (Math.abs(lat) < 0.8) nbSide[lat < 0 ? 0 : 1] = true;
    if (o.s2 < c.s2) nbAlong[0] = true; else nbAlong[1] = true;
  }
  const B = RAIL.bedTop + 0.03, B2 = B + 0.13, half = RAIL.spacing / 2 + 0.002;
  const bl = nbSide[0] ? half : B, br = nbSide[1] ? half : B;
  const c00 = corner(-bl, -1), c01 = corner(-bl, 1), c11 = corner(br, 1), c10 = corner(br, -1);
  W.use(WC.CONCRETE, 0xa9a59d);
  upTri(W, c00[0], yTop, c00[1], c01[0], yTop, c01[1], c11[0], yTop, c11[1], 0.5);
  upTri(W, c00[0], yTop, c00[1], c11[0], yTop, c11[1], c10[0], yTop, c10[1], 0.5);
  // ramps down to the road on the outer sides
  W.use(WC.ASPHALT, 0xffffff);
  for (const sb of [-1, 1]) {
    if (nbSide[sb < 0 ? 0 : 1]) continue;
    const i0 = corner(sb * B, -1), i1 = corner(sb * B, 1), o0 = corner(sb * B2, -1), o1 = corner(sb * B2, 1);
    upTri(W, i0[0], yTop, i0[1], i1[0], yTop, i1[1], o1[0], yRoad - 0.003, o1[1], WSCALE.ASPHALT);
    upTri(W, i0[0], yTop, i0[1], o1[0], yRoad - 0.003, o1[1], o0[0], yRoad - 0.003, o0[1], WSCALE.ASPHALT);
  }
  // barriers on the right of both road approaches (only at the first crossing a driver reaches)
  const D = ctx.d;
  const sinA = Math.max(0.3, Math.abs(pr.tx * pd.tz - pr.tz * pd.tx));
  const dist = B2 / sinA + 0.12;
  for (const v of [1, -1]) {
    if (nbAlong[v > 0 ? 0 : 1]) continue;
    const vx = pd.tx * v, vz = pd.tz * v; // travel direction towards the crossing
    const rx = -vz, rz = vx;
    const px = c.x - vx * dist + rx * (Wd + 0.06), pz = c.z - vz * dist + rz * (Wd + 0.06);
    const yy = Math.max(ctx.game.world.heightAt(px, pz) + 0.02, yRoad - 0.05);
    D.use(WC.PLAIN, 0xf0f0ee);
    D.box(px, yy, pz, 0.05, 0.08, 0.05, vx, vz);
    D.use(WC.METAL, 0xd8d8d8);
    D.cylinder(px, yy, pz, 0.008, 0.36, 6);
    D.use(WC.PLAIN, 0x1b1b1b);
    D.box(px - vx * 0.012, yy + 0.27, pz - vz * 0.012, 0.11, 0.05, 0.012, vx, vz, false);
    for (const [k, ph] of [[-0.03, 0], [0.03, 1]] as [number, number][]) {
      ctx.xLights.push({ crossing: c.id, x: px - vx * 0.022 + rx * k, y: yy + 0.295, z: pz - vz * 0.022 + rz * k, phase: ph });
    }
    // St Andrew's cross: two crossed boards facing the approaching traffic
    const cxp = px - vx * 0.016, czp = pz - vz * 0.016, cyp = yy + 0.36;
    for (const sgn of [1, -1]) {
      const ux = rx * 0.7071, uy = 0.7071 * sgn, uz = rz * 0.7071; // board axis in the sign plane
      const L = 0.075, Tt = 0.012;
      const nx2 = -rz * 0, wx = -vx, wz = -vz; void nx2;
      // perpendicular in the plane: (up x axis)
      const px2 = -rx * 0.7071 * sgn, py2 = 0.7071, pz2 = -rz * 0.7071 * sgn;
      const P = (a: number, b: number): [number, number, number] => [cxp + ux * a + px2 * b, cyp + uy * a + py2 * b, czp + uz * a + pz2 * b];
      const q0 = P(-L, -Tt), q1 = P(L, -Tt), q2 = P(L, Tt), q3 = P(-L, Tt);
      D.use(WC.PLAIN, sgn > 0 ? 0xffffff : 0xf2f2f2);
      D.ttri(...q0, 0, 0, ...q1, 0, 0, ...q2, 0, 0, wx, 0, wz);
      D.ttri(...q0, 0, 0, ...q2, 0, 0, ...q3, 0, 0, wx, 0, wz);
      D.use(WC.PLAIN, 0xc8322a);
      const r0 = P(-L * 0.6, -Tt * 0.45), r1 = P(L * 0.6, -Tt * 0.45), r2 = P(L * 0.6, Tt * 0.45), r3 = P(-L * 0.6, Tt * 0.45);
      const ox2 = -vx * 0.002, oz2 = -vz * 0.002;
      D.ttri(r0[0] + ox2, r0[1], r0[2] + oz2, 0, 0, r1[0] + ox2, r1[1], r1[2] + oz2, 0, 0, r2[0] + ox2, r2[1], r2[2] + oz2, 0, 0, wx, 0, wz);
      D.ttri(r0[0] + ox2, r0[1], r0[2] + oz2, 0, 0, r2[0] + ox2, r2[1], r2[2] + oz2, 0, 0, r3[0] + ox2, r3[1], r3[2] + oz2, 0, 0, wx, 0, wz);
    }
    // boom pivot: lowered direction points across the carriageway (to the left of travel)
    ctx.booms.push({ crossing: c.id, x: px - rx * 0.03, y: yy + 0.13, z: pz - rz * 0.03, dx: -rx, dz: -rz, len: Wd + 0.06 });
  }
}

export type { PP };
