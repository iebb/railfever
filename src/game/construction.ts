// Route planning (A*) for rail and road construction, with automatic grading,
// bridges and tunnels, plus evaluation and committing of plans.
import type { Game } from './game';
import { World, Transport } from './world';
import { DX, DZ, OPP, EDGE_CORNERS, CORNER_DX, CORNER_DZ, pieceOf } from './constants';
import { cornerLocked } from './terraform';
import { COSTS } from './economy';
import { clearStructureCache } from './geom';

export interface PlanLink { kind: 'bridge' | 'tunnel'; span: number }

export interface PlanStep {
  x: number; z: number;
  /** entry edge, or -1 (road start) */
  a: number;
  /** exit edge, or -1 (road end) */
  b: number;
  hIn: number;
  hOut: number;
  link?: PlanLink;
}

export interface RoutePlan {
  kind: Transport;
  steps: PlanStep[];
  ok: boolean;
  error?: string;
  cost: number;
  corners: Map<number, number>;
  /** depot endpoints are connected without construction */
  endDepot?: boolean;
}

const MAX_EXPAND = 160000;
const MAX_BRIDGE = 14;
const MAX_TUNNEL = 18;
const TERRA_W = 0.45;

interface Opt { hOut: number; cost: number }

class Heap {
  private f: number[] = [];
  private v: number[] = [];
  get size() { return this.v.length; }
  push(val: number, pri: number) {
    const f = this.f, v = this.v;
    let i = v.length;
    f.push(pri); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (f[p] <= pri) break;
      f[i] = f[p]; v[i] = v[p];
      i = p;
    }
    f[i] = pri; v[i] = val;
  }
  pop(): number {
    const f = this.f, v = this.v;
    const top = v[0];
    const lf = f.pop()!, lv = v.pop()!;
    const n = v.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && f[c + 1] < f[c]) c++;
        if (f[c] >= lf) break;
        f[i] = f[c]; v[i] = v[c];
        i = c;
      }
      f[i] = lf; v[i] = lv;
    }
    return top;
  }
}

function fail(kind: Transport, error: string): RoutePlan {
  return { kind, steps: [], ok: false, error, cost: 0, corners: new Map() };
}

export function planRoute(game: Game, kind: Transport, sx: number, sz: number, ex: number, ez: number): RoutePlan {
  const w = game.world;
  if (!w.inBounds(sx, sz) || !w.inBounds(ex, ez)) return fail(kind, 'Out of bounds');
  if (sx === ex && sz === ez) return fail(kind, 'Drag to another tile');
  const rail = kind === 'rail';
  const tc = [0, 0, 0, 0];

  const pad = 16;
  const minX = Math.max(0, Math.min(sx, ex) - pad), maxX = Math.min(w.size - 1, Math.max(sx, ex) + pad);
  const minZ = Math.max(0, Math.min(sz, ez) - pad), maxZ = Math.min(w.size - 1, Math.max(sz, ez) + pad);
  const inBox = (x: number, z: number) => x >= minX && x <= maxX && z >= minZ && z <= maxZ;

  // node storage
  const NX: number[] = [], NZ: number[] = [], ND: number[] = [], NH: number[] = [], NPT: number[] = [], NMS: number[] = [];
  const NG: number[] = [], NPAR: number[] = [], NSTART: number[] = [];
  const NSTEP: (PlanStep | null)[] = [];
  const NGOAL: number[] = [];
  const best = new Map<number, number>();
  const heap = new Heap();
  const keyOf = (x: number, z: number, d: number, h: number, _pt: number, ms: number, st: number) =>
    ((((x * 512 + z) * 4 + d) * 128 + (h + 16)) * 2 + ms) * 2 + st;
  const span0 = Math.abs(ex - sx) + Math.abs(ez - sz);
  const hw = 1.15 + Math.min(0.45, span0 / 220);
  const heur = (x: number, z: number) => (Math.abs(x - ex) + Math.abs(z - ez)) * hw;

  const addNode = (x: number, z: number, d: number, h: number, pt: number, ms: number, st: number, g: number, par: number, step: PlanStep | null, goal = 0) => {
    if (!goal) {
      const k = keyOf(x, z, d, h, pt, ms, st);
      const b = best.get(k);
      if (b !== undefined && b <= g) return;
      best.set(k, g);
    }
    const i = NX.length;
    NX.push(x); NZ.push(z); ND.push(d); NH.push(h); NPT.push(pt); NMS.push(ms); NSTART.push(st);
    NG.push(g); NPAR.push(par); NSTEP.push(step); NGOAL.push(goal);
    heap.push(i, g + (goal ? 0 : heur(x, z)));
  };

  const lockCache = new Map<number, boolean>();
  const locked = (cx: number, cz: number): boolean => {
    const key = cz * (w.size + 1) + cx;
    let v = lockCache.get(key);
    if (v === undefined) { v = cornerLocked(w, cx, cz); lockCache.set(key, v); }
    return v;
  };
  // ---- tile evaluation
  const evalTile = (x: number, z: number, a: number, e: number, h: number, isStart: boolean): Opt[] => {
    const t = w.idx(x, z);
    if (w.building[t] >= 0 || w.depot[t] >= 0) return [];
    const c = w.corners(x, z, tc);
    const tmax = Math.max(c[0], c[1], c[2], c[3]);
    if (tmax <= 0) return [];
    const sp = w.span[t];
    if (sp >= 0) {
      const st = w.structures.get(sp)!;
      if (st.kind === 'bridge' && st.h - tmax < 2) return [];
    }
    const newMask = (a >= 0 ? 1 << a : 0) | (e >= 0 ? 1 << e : 0);
    const rl = w.rail[t], rd = w.road[t];
    const stn = w.station[t];
    let base = 1, extra = 0;
    if (rail) {
      const p = pieceOf(a, e);
      if (p < 0) return [];
      if (stn >= 0) {
        if (w.stationKind[t] !== 1 || !(rl & (1 << p))) return [];
        base = 0.25;
      } else if (rd) {
        if (p > 1) return [];
        const perp = p === 0 ? 0b1010 : 0b0101;
        if (rd !== perp) return [];
        if (rl & ~(1 << p)) return [];
        extra += 3;
        base = rl ? 0.25 : 1;
      } else if (rl) {
        base = rl & (1 << p) ? 0.25 : 1.3;
      }
    } else {
      if (stn >= 0) {
        if (w.stationKind[t] !== 2 || (newMask & ~rd)) return [];
        base = 0.25;
      } else if (rl) {
        if (a < 0 || e < 0 || e !== OPP[a]) return [];
        const needPiece = a === 0 || a === 2 ? 1 : 0;
        if (rl !== 1 << needPiece) return [];
        if (rd & ~newMask) return [];
        extra += 3;
        base = rd ? 0.3 : 1;
      } else if (rd) {
        base = newMask & ~rd ? 0.6 : 0.25;
      }
    }
    const slopeW = rail ? 0.7 : 0.3;
    const constructed = rl !== 0 || rd !== 0 || stn >= 0;
    if (constructed || sp >= 0) {
      const full = w.railEdges(t) | rd | newMask;
      if (!World.shapeSupports(c, full)) return [];
      if (a >= 0 && w.edgeLevel(x, z, a) !== h) return [];
      if (a < 0 && e >= 0 && isNaN(w.edgeLevel(x, z, e))) return [];
      const hOut = e >= 0 ? w.edgeLevel(x, z, e) : h;
      if (isNaN(hOut)) return [];
      return [{ hOut, cost: base + extra + (hOut !== h && a >= 0 ? slopeW : 0) }];
    }
    const treeCost = (w.trees[t] & 15) * 0.05;
    const cands: number[][] = [];
    if (a >= 0 && e >= 0) {
      const [a0, a1] = EDGE_CORNERS[a];
      if (e === OPP[a]) {
        const [e0, e1] = EDGE_CORNERS[e];
        for (const ho of [h - 1, h, h + 1]) {
          const r = [0, 0, 0, 0];
          r[a0] = h; r[a1] = h; r[e0] = ho; r[e1] = ho;
          cands.push(r);
        }
      } else cands.push([h, h, h, h]);
    } else if (a >= 0) {
      cands.push([h, h, h, h]);
      if (World.shapeSupports(c, 1 << a) && w.edgeLevel(x, z, a) === h) cands.push([c[0], c[1], c[2], c[3]]);
    } else if (e >= 0) {
      if (World.shapeSupports(c, 1 << e) && !isNaN(w.edgeLevel(x, z, e))) cands.push([c[0], c[1], c[2], c[3]]);
      const lv = new Set([Math.max(...c), Math.min(...c), Math.round((c[0] + c[1] + c[2] + c[3]) / 4)]);
      for (const L of lv) if (L > 0) cands.push([L, L, L, L]);
    }
    const out: Opt[] = [];
    const skipA = a >= 0 && !isStart;
    for (const r of cands) {
      let cost = 0, ok = true;
      for (let k = 0; k < 4; k++) {
        if (r[k] === c[k]) continue;
        if (skipA && (k === EDGE_CORNERS[a][0] || k === EDGE_CORNERS[a][1])) continue;
        const dd = Math.abs(r[k] - c[k]);
        if (dd > 4 || r[k] <= 0) { ok = false; break; }
        if (locked(x + CORNER_DX[k], z + CORNER_DZ[k])) { ok = false; break; }
        cost += dd;
      }
      if (!ok) continue;
      let hOut = h;
      if (e >= 0) {
        const [e0, e1] = EDGE_CORNERS[e];
        if (r[e0] !== r[e1]) continue;
        hOut = r[e0];
      }
      out.push({ hOut, cost: base + extra + treeCost + cost * TERRA_W + (hOut !== h && a >= 0 ? slopeW : 0) });
    }
    return out;
  };

  /** Landing tile entry corners must be at level h. Returns terraform steps or -1. */
  const landingCost = (bx: number, bz: number, entryEdge: number, h: number): number => {
    if (!w.inBounds(bx, bz)) return -1;
    const t = w.idx(bx, bz);
    if (w.building[t] >= 0 || w.depot[t] >= 0 || w.span[t] >= 0) return -1;
    if (w.tileMax(bx, bz) <= 0) return -1;
    let cost = 0;
    for (const k of EDGE_CORNERS[entryEdge]) {
      const cx = bx + CORNER_DX[k], cz = bz + CORNER_DZ[k];
      const cur = w.cornerH(cx, cz);
      if (cur === h) continue;
      if (Math.abs(cur - h) > 4 || locked(cx, cz)) return -1;
      cost += Math.abs(cur - h);
    }
    return cost;
  };

  const tryStructures = (x: number, z: number, e: number, hOut: number, g: number, par: number, baseStep: PlanStep, d: number) => {
    // bridges
    if (hOut >= 1) {
      let anyLow = false;
      for (let k = 1; k <= MAX_BRIDGE; k++) {
        const qx = x + DX[e] * k, qz = z + DZ[e] * k;
        if (!w.inBounds(qx, qz)) break;
        const q = w.idx(qx, qz);
        if (w.building[q] >= 0 || w.station[q] >= 0 || w.depot[q] >= 0 || w.span[q] >= 0) break;
        const qmax = w.tileMax(qx, qz);
        const cons = w.rail[q] !== 0 || w.road[q] !== 0;
        if (qmax > hOut) break;
        if (cons && hOut - qmax < 2) break;
        if (qmax < hOut || cons) anyLow = true;
        if (!anyLow) continue;
        const bx = qx + DX[e], bz = qz + DZ[e];
        if (!inBox(bx, bz)) continue;
        const lc = landingCost(bx, bz, OPP[e], hOut);
        if (lc < 0) continue;
        const step: PlanStep = { ...baseStep, link: { kind: 'bridge', span: k } };
        const cost = (rail ? 2.5 : 2) + (rail ? 2.4 : 1.8) * k + lc * TERRA_W;
        addNode(bx, bz, e, hOut, 0, 1, 0, g + cost, par, step);
      }
    }
    // tunnels
    const ahead = (k: number) => [x + DX[e] * k, z + DZ[e] * k];
    for (let i = 1; i <= MAX_TUNNEL; i++) {
      const [qx, qz] = ahead(i);
      if (!w.inBounds(qx, qz)) break;
      const q = w.idx(qx, qz);
      if (w.span[q] >= 0) break;
      const [f0, f1] = EDGE_CORNERS[e];
      const h0 = w.corner(qx, qz, f0), h1 = w.corner(qx, qz, f1);
      if (i >= 2) {
        // try ending here: far corners of this span tile become the exit portal
        const bx = qx + DX[e], bz = qz + DZ[e];
        if (inBox(bx, bz)) {
          const lc = landingCost(bx, bz, OPP[e], hOut);
          if (lc >= 0 && lc <= 2) {
            const step: PlanStep = { ...baseStep, link: { kind: 'tunnel', span: i } };
            const cost = (rail ? 4 : 3) + (rail ? 2.8 : 2.2) * i + lc * TERRA_W;
            addNode(bx, bz, e, hOut, 0, 1, 0, g + cost, par, step);
          }
        }
      }
      if (Math.min(h0, h1) < hOut + 2) break;
    }
  };

  /** Edges of a rail tile that connect onwards to neighbouring track (or bridges/depots). */
  const connectedEdges = (t: number): number => {
    const touched = w.railEdges(t);
    let m = 0;
    for (let e = 0; e < 4; e++) {
      if (!(touched & (1 << e))) continue;
      if (w.headAt(t, e) >= 0) { m |= 1 << e; continue; }
      const n = w.neighbour(t, e);
      if (n < 0) continue;
      if (w.railEdges(n) & (1 << OPP[e])) m |= 1 << e;
      else if (w.depot[n] >= 0) { const dp = w.depots.get(w.depot[n])!; if (dp.kind === 'rail' && dp.dir === OPP[e]) m |= 1 << e; }
    }
    return m || touched;
  };

  // ---- start nodes
  const sDepot = w.depot[w.idx(sx, sz)];
  if (sDepot >= 0) {
    const dp = w.depots.get(sDepot)!;
    if (dp.kind !== kind) return fail(kind, 'Wrong depot type');
    const nx = sx + DX[dp.dir], nz = sz + DZ[dp.dir];
    if (!w.inBounds(nx, nz)) return fail(kind, 'Depot faces map edge');
    if (nx === ex && nz === ez) return fail(kind, 'Too short');
    addNode(nx, nz, dp.dir, w.cornerH(sx, sz), 0, 0, 0, 0, -1, null);
  } else {
    const st = w.idx(sx, sz);
    const c = w.corners(sx, sz, [0, 0, 0, 0]);
    for (let a = 0; a < 4; a++) {
      const d = OPP[a];
      if (rail) {
        let extra = 0;
        if (w.rail[st] || w.station[st] >= 0) {
          // continue outwards from the existing track: enter through a connected edge
          if (!(connectedEdges(st) & (1 << a))) continue;
        } else {
          const n = w.neighbour(st, a);
          const connects = n >= 0 && ((w.railEdges(n) & (1 << OPP[a])) !== 0 || (w.depot[n] >= 0 && w.depots.get(w.depot[n])!.dir === OPP[a] && w.depots.get(w.depot[n])!.kind === 'rail'));
          extra = connects ? 0 : 0.4;
        }
        const [k0, k1] = EDGE_CORNERS[a];
        const l0 = c[k0], l1 = c[k1];
        if (l0 === l1) addNode(sx, sz, d, l0, 0, 0, 1, extra, -1, null);
        else if (w.isEmpty(st)) {
          for (const L of [Math.min(l0, l1), Math.max(l0, l1)]) addNode(sx, sz, d, L, 0, 0, 1, extra + 0.5, -1, null);
        }
      } else {
        // road: virtual entry; exit straight ahead (d)
        addNode(sx, sz, d, c[EDGE_CORNERS[d][0]], 0, 0, 1, 0, -1, null);
      }
    }
  }
  {
    const et = w.idx(ex, ez);
    if (w.building[et] >= 0) return fail(kind, 'Building in the way');
    if (w.tileMax(ex, ez) <= 0) return fail(kind, 'Cannot end on water');
    if (w.station[et] >= 0 && w.stationKind[et] !== (rail ? 1 : 2)) return fail(kind, 'Station in the way');
    if (rail && w.road[et] && w.road[et] !== 0b0101 && w.road[et] !== 0b1010) return fail(kind, 'Road junction in the way');
  }
  const eDepot = w.depot[w.idx(ex, ez)];
  const endDepot = eDepot >= 0 ? w.depots.get(eDepot)! : null;
  if (endDepot && endDepot.kind !== kind) return fail(kind, 'Wrong depot type');

  // ---- search
  let expanded = 0;
  let goalNode = -1;
  const budget = Math.min(MAX_EXPAND, 4000 + 1500 * span0);
  const tStart = performance.now();
  while (heap.size > 0) {
    const i = heap.pop();
    if (NGOAL[i]) { goalNode = i; break; }
    const x = NX[i], z = NZ[i], d = ND[i], h = NH[i], pt = NPT[i], ms = NMS[i], st = NSTART[i];
    const k = keyOf(x, z, d, h, pt, ms, st);
    if ((best.get(k) ?? Infinity) < NG[i]) continue;
    if (++expanded > budget || ((expanded & 1023) === 0 && performance.now() - tStart > 350)) { expanded = budget + 1; break; }
    const g = NG[i];
    const isStart = st === 1;
    const a = !rail && isStart ? -1 : OPP[d];
    const atEnd = x === ex && z === ez;

    if (atEnd) {
      if (endDepot) {
        if (OPP[d] === endDepot.dir) addNode(x, z, d, h, 0, 0, 0, g, i, null, 1);
        continue;
      }
      const t = w.idx(x, z);
      if (rail) {
        for (const e of [d, (d + 1) & 3, (d + 3) & 3]) {
          if (ms && e !== d) continue;
          const hasRail = w.rail[t] !== 0 || w.station[t] >= 0;
          if (hasRail) {
            if (!(connectedEdges(t) & (1 << e))) continue;
          } else if (e !== d) {
            const n = w.neighbour(t, e);
            if (n < 0 || !(w.railEdges(n) & (1 << OPP[e]))) continue;
          }
          const turn = e === d ? 0 : e === ((d + 1) & 3) ? 2 : 1;
          for (const o of evalTile(x, z, a, e, h, isStart)) {
            const step: PlanStep = { x, z, a, b: e, hIn: h, hOut: o.hOut };
            addNode(x, z, d, h, 0, 0, 0, g + o.cost + turnCost(pt, turn, rail), i, step, 1);
          }
        }
      } else {
        for (const o of evalTile(x, z, OPP[d], -1, h, false)) {
          const step: PlanStep = { x, z, a: OPP[d], b: -1, hIn: h, hOut: o.hOut };
          addNode(x, z, d, h, 0, 0, 0, g + o.cost, i, step, 1);
        }
      }
      continue;
    }

    const exits = ms ? [d] : !rail && isStart ? [d] : [d, (d + 1) & 3, (d + 3) & 3];
    for (const e of exits) {
      const turn = e === d ? 0 : e === ((d + 1) & 3) ? 2 : 1;
      const opts = evalTile(x, z, a, e, h, isStart);
      for (const o of opts) {
        const step: PlanStep = { x, z, a, b: e, hIn: h, hOut: o.hOut };
        const ng = g + o.cost + turnCost(pt, turn, rail);
        const nx = x + DX[e], nz = z + DZ[e];
        if (inBox(nx, nz)) addNode(nx, nz, e, o.hOut, turn, 0, 0, ng, i, step);
        if (e === d && (a < 0 || e === OPP[a])) tryStructures(x, z, e, o.hOut, ng, i, step, d);
      }
    }
  }
  if (goalNode < 0) return fail(kind, expanded > budget ? 'No route found (try a shorter drag)' : 'No possible route');
  const steps: PlanStep[] = [];
  for (let i = goalNode; i >= 0; i = NPAR[i]) if (NSTEP[i]) steps.push(NSTEP[i]!);
  steps.reverse();
  const plan: RoutePlan = { kind, steps, ok: true, cost: 0, corners: new Map(), endDepot: !!endDepot };
  evaluatePlan(game, plan);
  return plan;
}

function turnCost(pt: number, turn: number, rail: boolean): number {
  if (turn === 0) return 0;
  if (!rail) return pt === turn ? 1.2 : 0.5;
  if (pt === 0) return 0.9;
  if (pt !== turn) return 0.12; // alternating => diagonal
  return 6; // two turns the same way => very tight curve
}

/** Compute terraforming, validity and money cost of a plan. */
export function evaluatePlan(game: Game, plan: RoutePlan) {
  const w = game.world;
  const rail = plan.kind === 'rail';
  plan.ok = true;
  plan.error = undefined;
  for (const s of plan.steps) {
    const t = w.idx(s.x, s.z);
    if (w.building[t] >= 0 || w.depot[t] >= 0) { plan.ok = false; plan.error = 'Something was built in the way'; }
    if (w.station[t] >= 0 && w.stationKind[t] !== (rail ? 1 : 2)) { plan.ok = false; plan.error = 'Station in the way'; }
    if (s.link) {
      for (let k = 1; k <= s.link.span; k++) {
        const q = w.idx(s.x + DX[s.b] * k, s.z + DZ[s.b] * k);
        if (w.span[q] >= 0) { plan.ok = false; plan.error = 'Another bridge or tunnel is in the way'; }
        if (s.link.kind === 'bridge' && (w.building[q] >= 0 || w.station[q] >= 0 || w.depot[q] >= 0)) { plan.ok = false; plan.error = 'Something was built in the way'; }
      }
    }
  }
  const req = new Map<number, number>();
  const s1 = w.size + 1;
  let conflict = false;
  const setReq = (x: number, z: number, k: number, lvl: number) => {
    const ci = (z + CORNER_DZ[k]) * s1 + x + CORNER_DX[k];
    const cur = req.get(ci);
    if (cur !== undefined && cur !== lvl) conflict = true;
    req.set(ci, lvl);
  };
  const tc = [0, 0, 0, 0];
  for (const s of plan.steps) {
    const t = w.idx(s.x, s.z);
    if (!w.isEmpty(t) || w.span[t] >= 0) continue;
    const c = w.corners(s.x, s.z, tc);
    if (s.a >= 0 && s.b >= 0) {
      if (s.b === OPP[s.a]) {
        for (const k of EDGE_CORNERS[s.a]) setReq(s.x, s.z, k, s.hIn);
        for (const k of EDGE_CORNERS[s.b]) setReq(s.x, s.z, k, s.hOut);
      } else for (let k = 0; k < 4; k++) setReq(s.x, s.z, k, s.hIn);
    } else if (s.a >= 0) {
      if (!(World.shapeSupports(c, 1 << s.a) && w.edgeLevel(s.x, s.z, s.a) === s.hIn)) for (let k = 0; k < 4; k++) setReq(s.x, s.z, k, s.hIn);
    } else if (s.b >= 0) {
      if (!(World.shapeSupports(c, 1 << s.b) && w.edgeLevel(s.x, s.z, s.b) === s.hOut)) {
        const L = Math.max(s.hOut, 1);
        for (let k = 0; k < 4; k++) setReq(s.x, s.z, k, L);
      }
    }
  }
  // landing tiles of structures need their entry corners at the deck level
  for (let i = 0; i < plan.steps.length; i++) {
    const s = plan.steps[i];
    if (!s.link) continue;
    const bx = s.x + DX[s.b] * (s.link.span + 1), bz = s.z + DZ[s.b] * (s.link.span + 1);
    for (const k of EDGE_CORNERS[OPP[s.b]]) setReq(bx, bz, k, s.hOut);
    for (const k of EDGE_CORNERS[s.b]) setReq(s.x, s.z, k, s.hOut);
  }
  plan.corners = new Map();
  let terra = 0;
  for (const [ci, lvl] of req) {
    const cur = w.hgt[ci];
    if (cur === lvl) continue;
    const cx = ci % s1, cz = (ci / s1) | 0;
    if (cornerLocked(w, cx, cz)) { plan.ok = false; plan.error = 'Terrain is locked by nearby construction'; }
    plan.corners.set(ci, lvl);
    terra += Math.abs(cur - lvl);
  }
  if (conflict) { plan.ok = false; plan.error = 'Route conflicts with itself'; }

  // final validity with new heights
  const newH = (cx: number, cz: number) => plan.corners.get(cz * s1 + cx) ?? w.cornerH(cx, cz);
  const masks = new Map<number, number>();
  let money = terra * COSTS.terraform;
  for (const s of plan.steps) {
    const t = w.idx(s.x, s.z);
    const add = (s.a >= 0 ? 1 << s.a : 0) | (s.b >= 0 ? 1 << s.b : 0);
    masks.set(t, (masks.get(t) ?? 0) | add);
    money += (w.trees[t] & 15) * COSTS.tree;
    if (rail) {
      const p = pieceOf(s.a, s.b);
      if (!(w.rail[t] & (1 << p))) money += COSTS.rail + (w.road[t] ? COSTS.levelCrossing : 0);
    } else {
      if (add & ~w.road[t]) money += COSTS.road + (w.rail[t] ? COSTS.levelCrossing : 0);
    }
    if (s.link) {
      const per = s.link.kind === 'bridge' ? (rail ? COSTS.bridgeRail : COSTS.bridgeRoad) : rail ? COSTS.tunnelRail : COSTS.tunnelRoad;
      money += per * s.link.span;
      if (s.link.kind === 'bridge') {
        for (let k = 1; k <= s.link.span; k++) {
          const q = w.idx(s.x + DX[s.b] * k, s.z + DZ[s.b] * k);
          money += (w.trees[q] & 15) * COSTS.tree;
        }
      }
    }
  }
  for (const [t, add] of masks) {
    const x = w.tx(t), z = w.tz(t);
    const c = [newH(x, z), newH(x + 1, z), newH(x + 1, z + 1), newH(x, z + 1)];
    const full = w.railEdges(t) | w.road[t] | add;
    if (!World.shapeSupports(c, full)) { plan.ok = false; plan.error = plan.error ?? 'Unsuitable slope'; }
  }
  plan.cost = Math.round(money);
}

/** Apply a plan to the world. Returns error string or null. */
export function commitPlan(game: Game, plan: RoutePlan): string | null {
  const w = game.world;
  // the world may have changed since planning (towns grow): validate again
  if (plan.ok) evaluatePlan(game, plan);
  if (!plan.ok) return plan.error ?? 'Cannot build';
  if (!game.economy.canAfford(plan.cost)) return 'Not enough money';
  // vehicles on tiles that are terraformed?
  const s1 = w.size + 1;
  for (const ci of plan.corners.keys()) {
    const cx = ci % s1, cz = (ci / s1) | 0;
    for (let dz = -1; dz <= 0; dz++) for (let dx = -1; dx <= 0; dx++) {
      if (w.inBounds(cx + dx, cz + dz) && game.isTileBusy(w.idx(cx + dx, cz + dz))) return 'Vehicle in the way';
    }
  }
  game.economy.spend(plan.cost, 'construction');
  for (const [ci, lvl] of plan.corners) w.setCorner(ci % s1, (ci / s1) | 0, lvl);
  const rail = plan.kind === 'rail';
  for (const s of plan.steps) {
    const t = w.idx(s.x, s.z);
    if (rail) {
      w.rail[t] |= 1 << pieceOf(s.a, s.b);
      if (w.pieceCount(t) > 1) w.signal[t] = 0; // signals only live on plain track
    } else {
      const add = (s.a >= 0 ? 1 << s.a : 0) | (s.b >= 0 ? 1 << s.b : 0);
      if (!w.road[t]) w.roadOwner[t] = 2;
      w.road[t] |= add;
    }
    w.trees[t] = 0;
    w.markTile(s.x, s.z);
    if (s.link) {
      const bx = s.x + DX[s.b] * (s.link.span + 1), bz = s.z + DZ[s.b] * (s.link.span + 1);
      const id = w.nextStructureId++;
      w.structures.set(id, {
        id, kind: s.link.kind, transport: plan.kind, ax: s.x, az: s.z, bx, bz, dir: s.b, h: s.hOut, span: s.link.span,
      });
      clearStructureCache(id);
      w.heads.set(t * 4 + s.b, id);
      w.heads.set(w.idx(bx, bz) * 4 + OPP[s.b], id);
      for (let k = 1; k <= s.link.span; k++) {
        const qx = s.x + DX[s.b] * k, qz = s.z + DZ[s.b] * k;
        const q = w.idx(qx, qz);
        w.span[q] = id;
        if (s.link.kind === 'bridge') w.trees[q] = 0;
        w.markTile(qx, qz);
      }
    }
  }
  game.onNetworkChanged();
  return null;
}
