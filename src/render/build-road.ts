// Road geometry: carriageways with markings, kerbed sidewalks, junction plates, lamps, bus stops, level crossings.
import { ROAD_TYPES, RAIL } from '../game/constants';
import type { Network, NEdge, NNode, Crossing } from '../game/network';
import type { Station } from '../game/stations';
import { ChunkCtx, Smp, edgeRuns, splitBySections, sweep, sampleAt, inChunk, mitre, upTri, wallQuad, PP } from './build-common';
import { STRIP_PERIOD } from './textures';
import { buildBridge, buildPortals } from './build-structures';
import { RAIL_TOP_Y } from './build-rail';

const ASPHALT = 0x56585c;
const PAVING = 0xb5b0a6;
const KERB = 0xd2cec6;
const VERGE = 0x7f7a62;
const EARTH = 0x75695a;
const KERB_H = 0.018;

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
  ctx.road.color(e.owner < 0 ? 0xf2f2f2 : 0xffffff);
  sweep(ctx.road, run, [[-h, 0, street ? 0.504 : 0.004], [h, 0, street ? 0.996 : 0.496]], STRIP_PERIOD);
  const m = ctx.matte;
  const low = bridge ? -0.005 : -0.25;
  if (street) {
    const W = h + sw;
    m.color(EARTH);
    sweep(m, run, [[-W - 0.01, low], [-W, KERB_H]]);
    sweep(m, run, [[W, KERB_H], [W + 0.01, low]]);
    m.color(PAVING);
    sweep(m, run, [[-W, KERB_H], [-h - 0.018, KERB_H]]);
    sweep(m, run, [[h + 0.018, KERB_H], [W, KERB_H]]);
    m.color(KERB);
    sweep(m, run, [[-h - 0.018, KERB_H], [-h, KERB_H], [-h, -0.002]]);
    sweep(m, run, [[h, -0.002], [h, KERB_H], [h + 0.018, KERB_H]]);
  } else if (bridge) {
    m.color(0x9d998f);
    sweep(m, run, [[-h - 0.08, 0], [-h, 0]]);
    sweep(m, run, [[h, 0], [h + 0.08, 0]]);
  } else {
    m.color(VERGE);
    sweep(m, run, [[-h - 0.1, -0.04], [-h, -0.002]]);
    sweep(m, run, [[h, -0.002], [h + 0.1, -0.04]]);
    m.color(EARTH);
    sweep(m, run, [[-h - 0.12, low], [-h - 0.1, -0.04]]);
    sweep(m, run, [[h + 0.1, -0.04], [h + 0.12, low]]);
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
    if (part.type === 'ground' && roadType(e).sidewalk > 0 && e.depot < 0) streetLamps(ctx, e, part.s0, part.s1);
  }
  buildPortals(ctx, e);
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
    const x = p.x + p.lx * off, z = p.z + p.lz * off, y = p.y + KERB_H;
    const mt = ctx.metal;
    mt.color(0x3b4045);
    mt.cylinder(x, y, z, 0.008, 0.62, 5);
    const hx = x - p.lx * side * 0.14, hz = z - p.lz * side * 0.14;
    mt.tube(x, y + 0.6, z, hx, y + 0.62, hz, 0.005, 4);
    ctx.matte.color(0xfff1c8);
    ctx.matte.box(hx, y + 0.595, hz, 0.06, 0.018, 0.03, p.lx, p.lz, false);
    ctx.lights.push(hx, y + 0.585, hz);
  }
}

// ------------------------------------------------------------------------------ junctions

interface Arm { e: NEdge; x: number; y: number; z: number; dx: number; dz: number; w: number; sw: number; a: number }

function qbez(a: number, c: number, b: number, t: number) { const u = 1 - t; return u * u * a + 2 * u * t * c + t * t * b; }

/** Corner fillet control point: intersection of the kerb lines through A (dir -da) and B (dir -db). */
function filletCtrl(ax: number, az: number, dax: number, daz: number, bx: number, bz: number, dbx: number, dbz: number): [number, number] | null {
  // A - t*da = B - u*db  ->  t*(-da) + u*db = B - A
  const den = -dax * dbz + daz * dbx;
  if (Math.abs(den) < 1e-4) return null;
  const rx = bx - ax, rz = bz - az;
  const t = (rx * dbz - rz * dbx) / den;
  const u = (-dax * rz + daz * rx) / den;
  if (t < -0.02 || u < -0.02 || t > 4 || u > 4) return null;
  return [ax - dax * t, az - daz * t];
}

export function buildRoadNode(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
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
  // boundary of the carriageway plate (and the sidewalk ring), in increasing angle
  const bnd: number[] = []; // x,y,z
  const m = ctx.matte;
  const SEG = 6;
  for (let i = 0; i < arms.length; i++) {
    const A = arms[i], B = arms[(i + 1) % arms.length];
    // right of an arm direction (dx,dz) is (-dz, dx): increasing angle side
    const lAx = A.x + A.dz * A.w, lAz = A.z - A.dx * A.w; // left corner of A
    const rAx = A.x - A.dz * A.w, rAz = A.z + A.dx * A.w; // right corner of A
    const lBx = B.x + B.dz * B.w, lBz = B.z - B.dx * B.w;
    bnd.push(lAx, A.y, lAz, rAx, A.y, rAz);
    const c = filletCtrl(rAx, rAz, A.dx, A.dz, lBx, lBz, B.dx, B.dz);
    const cx = c ? c[0] : (rAx + lBx) / 2, cz = c ? c[1] : (rAz + lBz) / 2;
    for (let k = 1; k < SEG; k++) {
      const t = k / SEG;
      bnd.push(qbez(rAx, cx, lBx, t), A.y + (B.y - A.y) * t, qbez(rAz, cz, lBz, t));
    }
    // sidewalk ring along the fillet
    const swA = A.sw, swB = B.sw;
    if (swA > 0 || swB > 0) {
      const oAx = A.x - A.dz * (A.w + swA), oAz = A.z + A.dx * (A.w + swA);
      const oBx = B.x + B.dz * (B.w + swB), oBz = B.z - B.dx * (B.w + swB);
      const oc = filletCtrl(oAx, oAz, A.dx, A.dz, oBx, oBz, B.dx, B.dz);
      const ocx = oc ? oc[0] : (oAx + oBx) / 2, ocz = oc ? oc[1] : (oAz + oBz) / 2;
      let px = rAx, pz = rAz, qx = oAx, qz = oAz, py = A.y;
      for (let k = 1; k <= SEG; k++) {
        const t = k / SEG;
        const nx = qbez(rAx, cx, lBx, t), nz = qbez(rAz, cz, lBz, t);
        const ox = qbez(oAx, ocx, oBx, t), oz = qbez(oAz, ocz, oBz, t);
        const ny = A.y + (B.y - A.y) * t;
        m.color(PAVING);
        upTri(m, px, py + KERB_H, pz, qx, py + KERB_H, qz, ox, ny + KERB_H, oz);
        upTri(m, px, py + KERB_H, pz, ox, ny + KERB_H, oz, nx, ny + KERB_H, nz);
        // kerb face looking towards the node
        m.color(KERB);
        wallQuad(m, px, pz, nx, nz, py - 0.002, py + KERB_H, ny - 0.002, ny + KERB_H, node.x - (px + nx) / 2, node.z - (pz + nz) / 2);
        // outer face
        m.color(EARTH);
        wallQuad(m, qx, qz, ox, oz, py - 0.25, py + KERB_H, ny - 0.25, ny + KERB_H, (qx + ox) / 2 - node.x, (qz + oz) / 2 - node.z);
        px = nx; pz = nz; qx = ox; qz = oz; py = ny;
      }
    }
  }
  m.color(ASPHALT);
  const n = bnd.length / 3;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    upTri(m, node.x, cy, node.z, bnd[i * 3], bnd[i * 3 + 1], bnd[i * 3 + 2], bnd[j * 3], bnd[j * 3 + 1], bnd[j * 3 + 2]);
  }
  // skirt under the plate edge (fillets only) to hide the terrain seam
  void cy;
}

function deadEnd(ctx: ChunkCtx, node: NNode) {
  const net = ctx.game.world.net;
  const e = net.edges.get(node.edges[0]);
  if (!e || e.kind !== 'road' || e.depot >= 0) return;
  const rt = roadType(e);
  if (rt.sidewalk <= 0) return;
  if (net.sectionAt(e, e.a === node.id ? 0 : e.len) !== 'ground') return;
  const p = sampleAt(net.geo(e), e.a === node.id ? 0 : e.len);
  // outward direction beyond the end
  const ox = e.a === node.id ? -p.tx : p.tx, oz = e.a === node.id ? -p.tz : p.tz;
  const rx = -oz, rz = ox;
  const m = ctx.matte;
  const W = rt.half, S = rt.half + rt.sidewalk;
  const SEG = 10;
  const pt = (r: number, k: number): [number, number] => {
    const a = (k / SEG) * Math.PI; // 0 = right side, PI = left side, through the outward direction
    const c = Math.cos(a), s = Math.sin(a);
    return [p.x + rx * r * c + ox * r * s, p.z + rz * r * c + oz * r * s];
  };
  for (let k = 0; k < SEG; k++) {
    const [ax, az] = pt(W, k), [bx, bz] = pt(W, k + 1);
    m.color(ASPHALT);
    upTri(m, p.x, p.y, p.z, ax, p.y, az, bx, p.y, bz);
    const [cx, cz] = pt(S, k), [dx, dz] = pt(S, k + 1);
    m.color(PAVING);
    upTri(m, ax, p.y + KERB_H, az, cx, p.y + KERB_H, cz, dx, p.y + KERB_H, dz);
    upTri(m, ax, p.y + KERB_H, az, dx, p.y + KERB_H, dz, bx, p.y + KERB_H, bz);
    m.color(KERB);
    wallQuad(m, ax, az, bx, bz, p.y - 0.002, p.y + KERB_H, p.y - 0.002, p.y + KERB_H, p.x - (ax + bx) / 2, p.z - (az + bz) / 2);
    m.color(EARTH);
    wallQuad(m, cx, cz, dx, dz, p.y - 0.25, p.y + KERB_H, p.y - 0.25, p.y + KERB_H, (cx + dx) / 2 - p.x, (cz + dz) / 2 - p.z);
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
    for (const side of [-1, 1]) {
      const street = rt.sidewalk > 0;
      const off = side * (street ? rt.half + rt.sidewalk * 0.62 : rt.half + 0.2);
      const x = p.x + p.lx * off, z = p.z + p.lz * off;
      const y = p.y + (street ? KERB_H : 0);
      const fx = p.lx * side, fz = p.lz * side; // away from the road
      const m = ctx.matte, mt = ctx.metal;
      if (!street) {
        m.color(0xa9a59c);
        m.box(x - fx * 0.04, p.y - 0.06, z - fz * 0.04, 0.5, 0.075, 0.2, fx, fz);
      }
      const yb = street ? y : p.y + 0.015;
      // back wall (glass), roof, posts, bench
      m.color(0x8fb3c8);
      m.box(x + fx * 0.05, yb + 0.02, z + fz * 0.05, 0.34, 0.2, 0.01, fx, fz, false);
      m.color(0x3a3f44);
      m.box(x + fx * 0.01, yb + 0.235, z + fz * 0.01, 0.38, 0.014, 0.13, fx, fz, false);
      for (const a of [-0.17, 0.17]) {
        const px = x + fz * a + fx * 0.05, pz = z - fx * a + fz * 0.05;
        mt.color(0x3a3f44);
        mt.box(px, yb, pz, 0.012, 0.235, 0.012, fx, fz);
      }
      m.color(0x6b4f36);
      m.box(x + fx * 0.025, yb + 0.045, z + fz * 0.025, 0.24, 0.012, 0.04, fx, fz, false);
      // sign pole with company colour
      const sx = x - fz * 0.27, sz = z + fx * 0.27;
      mt.color(0x9aa0a6);
      mt.cylinder(sx, yb, sz, 0.006, 0.3, 5);
      m.color(color);
      m.box(sx, yb + 0.24, sz, 0.008, 0.07, 0.07, fx, fz, false);
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
  const W = rt.half + rt.sidewalk + 0.02;
  // panel: intersection of the rail strip |b| <= B and the road strip
  const dotTL = pr.tx * pd.lx + pr.tz * pd.lz;
  const tl = Math.abs(dotTL) < 0.3 ? (dotTL < 0 ? -0.3 : 0.3) : dotTL;
  const lrl = pr.lx * pd.lx + pr.lz * pd.lz;
  const base = (pr.x - pd.x) * pd.lx + (pr.z - pd.z) * pd.lz;
  const corner = (b: number, sw: number): [number, number] => {
    const a = (sw * W - base - b * lrl) / tl;
    return [pr.x + pr.tx * a + pr.lx * b, pr.z + pr.tz * a + pr.lz * b];
  };
  const yTop = pr.y + RAIL_TOP_Y - 0.004;
  const yRoad = pd.y;
  const m = ctx.matte;
  const B = RAIL.bedTop + 0.03, B2 = B + 0.13;
  const c00 = corner(-B, -1), c01 = corner(-B, 1), c11 = corner(B, 1), c10 = corner(B, -1);
  m.color(0x8f8b84);
  upTri(m, c00[0], yTop, c00[1], c01[0], yTop, c01[1], c11[0], yTop, c11[1]);
  upTri(m, c00[0], yTop, c00[1], c11[0], yTop, c11[1], c10[0], yTop, c10[1]);
  // ramps down to the road on both sides of the track
  m.color(0x4f5155);
  for (const sb of [-1, 1]) {
    const i0 = corner(sb * B, -1), i1 = corner(sb * B, 1), o0 = corner(sb * B2, -1), o1 = corner(sb * B2, 1);
    upTri(m, i0[0], yTop, i0[1], i1[0], yTop, i1[1], o1[0], yRoad - 0.003, o1[1]);
    upTri(m, i0[0], yTop, i0[1], o1[0], yRoad - 0.003, o1[1], o0[0], yRoad - 0.003, o0[1]);
  }
  // barriers on the right of both road approaches
  const mt = ctx.metal;
  const sinA = Math.max(0.3, Math.abs(pr.tx * pd.tz - pr.tz * pd.tx));
  const dist = B2 / sinA + 0.12;
  for (const v of [1, -1]) {
    const vx = pd.tx * v, vz = pd.tz * v; // travel direction towards the crossing
    const rx = -vz, rz = vx;
    const px = c.x - vx * dist + rx * (W + 0.06), pz = c.z - vz * dist + rz * (W + 0.06);
    const y = ctx.game.world.heightAt(px, pz) + 0.02;
    const yy = Math.max(y, yRoad - 0.05);
    m.color(0xf0f0ee);
    m.box(px, yy, pz, 0.05, 0.08, 0.05, vx, vz);
    mt.color(0xd8d8d8);
    mt.cylinder(px, yy, pz, 0.008, 0.36, 6);
    // light frame facing approaching traffic
    m.color(0x1b1b1b);
    m.box(px - vx * 0.012, yy + 0.27, pz - vz * 0.012, 0.11, 0.05, 0.012, vx, vz, false);
    for (const [k, ph] of [[-0.03, 0], [0.03, 1]] as [number, number][]) {
      ctx.xLights.push({ crossing: c.id, x: px - vx * 0.022 + rx * k, y: yy + 0.295, z: pz - vz * 0.022 + rz * k, phase: ph });
    }
    // St Andrew's cross board
    m.color(0xffffff);
    m.box(px - vx * 0.012, yy + 0.33, pz - vz * 0.012, 0.12, 0.022, 0.006, vx, vz, false);
    m.color(0xc8322a);
    m.box(px - vx * 0.014, yy + 0.336, pz - vz * 0.014, 0.12, 0.01, 0.006, vx, vz, false);
    // boom pivot: lowered direction points across the carriageway (to the left of travel)
    ctx.booms.push({ crossing: c.id, x: px - rx * 0.03, y: yy + 0.13, z: pz - rz * 0.03, dx: -rx, dz: -rz, len: rt.half + 0.06 + (W - rt.half) });
  }
}

export type { PP };
