// Trains on the free-form rail network: routing, path reservation, physics and movement.
import { Vehicle } from './vehicle';
import type { Game } from './game';
import type { Depot } from './build-ops';
import { Curve3, curvePoint, makeCurve, NEdge, NNode } from './network';
import { KMH_TO_UPS, TRACK_TYPES } from './constants';
import { curveSpeed } from './construction';
import type { VehicleModel } from './vehicle-types';
import type { Vec3Like } from './geom';

/** Reservation ids >= CROSS_BASE are crossings (diamond / level). */
export const CROSS_BASE = 50_000_000;

export interface TSeg {
  /** edge id, or -1 for the virtual track behind a depot's inner end */
  e: number;
  dir: number;
  curve: Curve3;
  len: number;
  res: number[];
  limit: number;
  tunnels: [number, number][];
  depot?: number;
}

/** Service braking (units/s^2 = 10 m/s^2). */
export const TRAIN_BRAKE = 0.07;
const GAP = 0.1;
const G = 0.981;

export function makeSeg(g: Game, e: NEdge, dir: number): TSeg {
  const net = g.world.net;
  const geo = net.geo(e);
  const tt = TRACK_TYPES[e.type] ?? TRACK_TYPES.standard;
  let kmh = Math.min(tt.speed, curveSpeed(geo.minRadius));
  if (e.depot >= 0) kmh = Math.min(kmh, 25);
  const res = [e.id];
  for (const c of net.crossings.values()) if (c.e1 === e.id || c.e2 === e.id) res.push(CROSS_BASE + c.id);
  const tunnels: [number, number][] = [];
  for (const s of e.sections) if (s.type === 'tunnel') tunnels.push(dir > 0 ? [s.s0, s.s1] : [e.len - s.s1, e.len - s.s0]);
  return { e: e.id, dir, curve: geo, len: e.len, res, limit: kmh * KMH_TO_UPS, tunnels };
}

function virtualDepotSeg(g: Game, dp: Depot, length: number): TSeg {
  const net = g.world.net;
  const stub = net.edges.get(dp.edge)!;
  const inner = net.nodes.get(stub.a)!;
  const fx = Math.sin(dp.angle), fz = Math.cos(dp.angle);
  const pts = [inner.x - fx * length, inner.y, inner.z - fz * length, inner.x, inner.y, inner.z];
  const c = makeCurve(pts);
  return { e: -1, dir: 1, curve: c, len: c.len, res: [], limit: 25 * KMH_TO_UPS, tunnels: [], depot: dp.id };
}

export interface Cont { edge: NEdge; dir: number }

/** Block signals (`signalKind` 'block'; the default 'path' signals guard just a train's own path). */
type SigNode = NNode & { signalKind?: 'block' | 'path' };
const blockCache = new WeakMap<Game, { v: number; m: Map<number, number[]> }>();

/**
 * The block a block signal guards: the edges reached from `edgeId` (leaving node `fromNode`) without passing
 * another signal (the edges between this signal and the next ones, junctions included). Capped (huge
 * unsignalled networks: the train's own path decides, as at a path signal).
 */
export function blockEdges(g: Game, edgeId: number, fromNode: number): number[] {
  let c = blockCache.get(g);
  if (!c || c.v !== g.networkVersion) { c = { v: g.networkVersion, m: new Map() }; blockCache.set(g, c); }
  const key = edgeId * 2 + (fromNode === g.world.net.edges.get(edgeId)?.a ? 0 : 1);
  const hit = c.m.get(key);
  if (hit) return hit;
  const net = g.world.net;
  const out: number[] = [];
  const seen = new Set<number>([edgeId]);
  const queue: [number, number][] = [[edgeId, fromNode]];
  while (queue.length && out.length < 400) {
    const [id, from] = queue.pop()!;
    const e = net.edges.get(id);
    if (!e) continue;
    out.push(id);
    for (const nid of [e.a, e.b]) {
      if (nid === from && id === edgeId) continue;
      const n = net.nodes.get(nid);
      if (!n || n.signal) continue;
      for (const f of n.edges) if (!seen.has(f)) { const fe = net.edges.get(f); if (fe && fe.kind === 'rail' && fe.depot < 0) { seen.add(f); queue.push([f, nid]); } }
    }
  }
  const res = out.length >= 400 ? [] : out;
  c.m.set(key, res);
  return res;
}

/**
 * Continuations after travelling edge e in direction dir (signals, track access, no depots). With `anyOwner`,
 * tracks the owner may not use are allowed too (a train caught on them when an agreement ends finds its way off).
 */
export function railNext(g: Game, e: NEdge, dir: number, owner: number, anyOwner = false): Cont[] {
  const net = g.world.net;
  const out: Cont[] = [];
  for (const c of net.nextRail(e, dir)) {
    if (c.edge.depot >= 0 || (!anyOwner && !g.canUse(owner, c.edge.owner))) continue;
    if (net.signalFor(c.node, net.sideAt(c.edge, c.node.id)) < 0) continue;
    out.push({ edge: c.edge, dir: c.dir });
  }
  return out;
}

function frontier(g: Game, seg: TSeg, owner: number, anyOwner = false): Cont[] {
  const net = g.world.net;
  if (seg.e < 0) {
    const dp = g.depots.get(seg.depot!);
    const stub = dp ? net.edges.get(dp.edge) : undefined;
    return stub ? [{ edge: stub, dir: 1 }] : [];
  }
  const e = net.edges.get(seg.e);
  return e ? railNext(g, e, seg.dir, owner, anyOwner) : [];
}

export class Heap {
  f: number[] = []; v: number[] = [];
  get size() { return this.v.length; }
  push(val: number, pri: number) {
    const f = this.f, v = this.v;
    let i = v.length; f.push(pri); v.push(val);
    while (i > 0) { const p = (i - 1) >> 1; if (f[p] <= pri) break; f[i] = f[p]; v[i] = v[p]; i = p; }
    f[i] = pri; v[i] = val;
  }
  pop(): number {
    const f = this.f, v = this.v, top = v[0];
    const lf = f.pop()!, lv = v.pop()!;
    const n = v.length;
    if (n) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= n) break;
        if (c + 1 < n && f[c + 1] < f[c]) c++;
        if (f[c] >= lf) break;
        f[i] = f[c]; v[i] = v[c]; i = c;
      }
      f[i] = lf; v[i] = lv;
    }
    return top;
  }
}

export interface RouteResult { conts: Cont[]; cost: number }

/**
 * A* over (edge, direction) to any platform edge of the target station. With `exit`, tracks the owner may not
 * use are allowed at a high cost (only to get off them).
 */
export function findRailRoute(g: Game, start: Cont[], target: number, owner: number, selfId: number, maxExpand = 60000, exit = false): RouteResult | null {
  const net = g.world.net;
  const st = g.stations.get(target);
  if (!st || !st.rail) return null;
  const tx = st.rail.x, tz = st.rail.z;
  const V = g.vehicles;
  const NE: number[] = [], ND: number[] = [], NG: number[] = [], NP: number[] = [];
  const best = new Map<number, number>();
  const heap = new Heap();
  const key = (e: number, d: number) => e * 2 + (d > 0 ? 1 : 0);
  const heur = (e: NEdge, d: number) => {
    const n = net.nodes.get(d > 0 ? e.b : e.a)!;
    return Math.hypot(n.x - tx, n.z - tz) * 0.98;
  };
  const cost = (e: NEdge) => {
    let c = e.len;
    const r = V.getRes(e.id);
    if (r && r !== selfId) c += 40;
    if (e.station >= 0 && e.station !== target) c += 6;
    if (exit && !g.canUse(owner, e.owner)) c += 200 + e.len * 4;
    return c;
  };
  const push = (e: NEdge, d: number, gc: number, parent: number) => {
    const k = key(e.id, d);
    if ((best.get(k) ?? Infinity) <= gc) return;
    best.set(k, gc);
    NE.push(e.id); ND.push(d); NG.push(gc); NP.push(parent);
    heap.push(NE.length - 1, gc + heur(e, d));
  };
  for (const s of start) push(s.edge, s.dir, cost(s.edge), -1);
  let n = 0;
  while (heap.size) {
    const i = heap.pop();
    const e = net.edges.get(NE[i])!;
    const d = ND[i];
    if ((best.get(key(e.id, d)) ?? Infinity) < NG[i]) continue;
    if (e.station === target) {
      const conts: Cont[] = [];
      for (let j = i; j >= 0; j = NP[j]) conts.push({ edge: net.edges.get(NE[j])!, dir: ND[j] });
      conts.reverse();
      return { conts, cost: NG[i] };
    }
    if (++n > maxExpand) break;
    for (const c of railNext(g, e, d, owner, exit)) push(c.edge, c.dir, NG[i] + cost(c.edge), i);
  }
  return null;
}

// --------------------------------------------------------------------------------------------

export class Train extends Vehicle {
  readonly kind = 'train' as const;
  cars: VehicleModel[];
  segs: TSeg[] = [];
  headSeg = 0;
  headPos = 0;
  pending: TSeg[] = [];
  speed = 0;
  depotId: number;
  waitTime = 0;
  retryTimer = 0;
  loadTimer = 0;
  routeTarget = -1;
  atStation = -1;
  reversed = false;
  blockedBy = 0;
  failCount = 0;
  /** current gradient under the train (for UI) */
  grade = 0;

  constructor(game: Game, id: number, cars: VehicleModel[], depotId: number) {
    super(game, id);
    this.cars = cars;
    this.depotId = depotId;
    this.value = cars.reduce((s, c) => s + c.cost, 0);
    const dp = game.depots.get(depotId);
    if (dp) { this.homeX = dp.x; this.homeZ = dp.z; this.owner = dp.owner; }
  }

  get length() { let l = 0; for (const c of this.cars) l += c.length + GAP; return l; }
  get capacity() { let c = 0; for (const m of this.cars) c += m.capacity; return c; }
  get maxSpeedKmh() { let v = Infinity; for (const m of this.cars) v = Math.min(v, m.speed); return v; }
  get maxSpeed() { return this.maxSpeedKmh * KMH_TO_UPS; }
  get speedKmh() { return this.speed / KMH_TO_UPS; }
  get runningCost() { let c = 0; for (const m of this.cars) c += m.running; return c; }
  get onMap() { return this.segs.length > 0; }
  get power() { let p = 0; for (const m of this.cars) p += m.power; return p; }
  get mass() { let w = 0; for (const m of this.cars) w += m.weight; return w + this.load * 0.075; }

  // ---------------------------------------------------------------- geometry
  tailInfo(): { seg: number; pos: number } {
    let rem = this.length;
    let i = this.headSeg, p = this.headPos;
    while (rem > p && i > 0) { rem -= p; i--; p = this.segs[i].len; }
    return { seg: i, pos: Math.max(0, p - rem) };
  }

  /** Point at distance d behind the head. */
  pointBehind(d: number, out: Vec3Like, dir?: Vec3Like): { seg: TSeg; sp: number } | null {
    if (!this.segs.length) return null;
    let i = this.headSeg, p = this.headPos;
    while (d > p && i > 0) { d -= p; i--; p = this.segs[i].len; }
    const s = this.segs[i];
    const sp = Math.max(0, p - d);
    curvePoint(s.curve, s.dir > 0 ? sp : s.len - sp, out, dir);
    if (dir && s.dir < 0) { dir.x = -dir.x; dir.y = -dir.y; dir.z = -dir.z; }
    return { seg: s, sp };
  }

  worldPos(out: Vec3Like): boolean {
    if (!this.onMap) { out.x = this.homeX; out.y = 0; out.z = this.homeZ; return false; }
    this.pointBehind(this.length / 2, out);
    return true;
  }

  distToEnd(): number {
    let d = this.segs[this.headSeg].len - this.headPos;
    for (let i = this.headSeg + 1; i < this.segs.length; i++) d += this.segs[i].len;
    return d;
  }

  /** Is the given position (along a segment, travel coordinates) hidden in a tunnel or depot? */
  hiddenAt(seg: TSeg, sp: number): boolean {
    if (seg.e < 0) return true;
    for (const [a, b] of seg.tunnels) if (sp > a + 0.6 && sp < b - 0.6) return true;
    return false;
  }

  /** Is the train standing on (or holding) track its owner may not use? */
  private onForeignTrack(): boolean {
    const g = this.game;
    for (const s of this.segs) {
      if (s.e < 0) continue;
      const e = g.world.net.edges.get(s.e);
      if (e && !g.canUse(this.owner, e.owner)) return true;
    }
    return false;
  }

  /** Edges physically covered by the train body. */
  occupiedEdges(): number[] {
    if (!this.segs.length) return [];
    const t = this.tailInfo();
    const out: number[] = [];
    for (let i = t.seg; i <= this.headSeg; i++) if (this.segs[i].e >= 0) out.push(this.segs[i].e);
    return out;
  }

  // ---------------------------------------------------------------- reservation
  private startsAtSignal(s: TSeg): boolean {
    if (s.e < 0) return false;
    const net = this.game.world.net;
    const e = net.edges.get(s.e);
    if (!e) return false;
    const nodeId = s.dir > 0 ? e.a : e.b;
    const node = net.nodes.get(nodeId);
    if (!node || !node.signal) return false;
    return net.signalFor(node, net.sideAt(e, nodeId)) > 0;
  }

  /** At a block signal (the start of the next stretch): is every edge of its block free of other trains? */
  private blockFree(): boolean {
    const s = this.pending[0];
    if (!s || s.e < 0) return true;
    const net = this.game.world.net;
    const e = net.edges.get(s.e);
    if (!e) return true;
    const nodeId = s.dir > 0 ? e.a : e.b;
    const node = net.nodes.get(nodeId) as SigNode | undefined;
    if (!node || !node.signal || node.signalKind !== 'block' || net.signalFor(node, net.sideAt(e, nodeId)) <= 0) return true;
    const V = this.game.vehicles;
    for (const id of blockEdges(this.game, e.id, nodeId)) {
      const o = V.getRes(id);
      if (o !== 0 && o !== this.id) { this.blockedBy = o; return false; }
    }
    return true;
  }

  /** Reserve pending segments up to the next signal (a block signal: once its whole block is free). */
  private tryExtend(): boolean {
    if (!this.pending.length) return false;
    if (!this.blockFree()) return false;
    const V = this.game.vehicles;
    let j = this.pending.length;
    for (let k = 1; k < this.pending.length; k++) if (this.startsAtSignal(this.pending[k])) { j = k; break; }
    for (let k = 0; k < j; k++) {
      for (const r of this.pending[k].res) {
        const o = V.getRes(r);
        if (o !== 0 && o !== this.id) { this.blockedBy = o; return false; }
      }
    }
    for (let k = 0; k < j; k++) for (const r of this.pending[k].res) V.setRes(r, this.id);
    this.segs.push(...this.pending.splice(0, j));
    this.blockedBy = 0;
    return true;
  }

  private release(s: TSeg, keep: TSeg[]) {
    const V = this.game.vehicles;
    for (const r of s.res) if (!keep.some((x) => x.res.includes(r))) V.releaseRes(r, this.id);
  }

  private releaseBehind() {
    const tail = this.tailInfo();
    if (tail.seg <= 0) return;
    const drop = this.segs.splice(0, tail.seg);
    this.headSeg -= tail.seg;
    for (const s of drop) { this.release(s, this.segs); if (s.e >= 0) this.meterTrack(s); }
  }

  /** The whole train has passed a segment: metered for track access (users share the maintenance by usage). */
  private meterTrack(s: TSeg) {
    const g = this.game;
    const e = g.world.net.edges.get(s.e);
    if (e && e.owner >= 0) g.recordTrackUse(this.owner, e, s.len);
  }

  private releaseAhead() {
    const tail = this.tailInfo();
    const keep = this.segs.slice(tail.seg, this.headSeg + 1);
    for (let i = this.headSeg + 1; i < this.segs.length; i++) this.release(this.segs[i], keep);
    this.segs.length = this.headSeg + 1;
  }

  releaseAll() {
    const V = this.game.vehicles;
    for (const s of this.segs) for (const r of s.res) V.releaseRes(r, this.id);
    this.segs = [];
    this.pending = [];
  }

  // ---------------------------------------------------------------- network changes
  onEdgeSplit(old: NEdge, e1: NEdge, e2: NEdge, s: number) {
    const g = this.game;
    const V = g.vehicles;
    const fix = (list: TSeg[], isSegs: boolean) => {
      for (let i = 0; i < list.length; i++) {
        const sg = list[i];
        if (sg.e !== old.id) continue;
        const a = sg.dir > 0 ? makeSeg(g, e1, 1) : makeSeg(g, e2, -1);
        const b = sg.dir > 0 ? makeSeg(g, e2, 1) : makeSeg(g, e1, -1);
        list.splice(i, 1, a, b);
        if (isSegs) {
          V.releaseRes(old.id, this.id);
          V.setRes(e1.id, this.id);
          V.setRes(e2.id, this.id);
          if (i < this.headSeg) this.headSeg++;
          else if (i === this.headSeg && this.headPos >= a.len) { this.headSeg++; this.headPos -= a.len; }
        }
        i++;
      }
    };
    fix(this.segs, true);
    fix(this.pending, false);
    void s;
  }

  onEdgeRemoved(e: NEdge) {
    const idx = this.segs.findIndex((s) => s.e === e.id);
    if (idx >= 0) {
      const tail = this.tailInfo();
      if (idx <= this.headSeg && idx >= tail.seg) {
        // the track under the train disappeared: return it to its depot
        this.releaseAll();
        this.speed = 0;
        this.state = 'depot';
        this.status = 'Returned to depot';
        return;
      }
      if (idx > this.headSeg) {
        const keep = this.segs.slice(0, idx);
        for (let i = idx; i < this.segs.length; i++) this.release(this.segs[i], keep);
        this.segs.length = idx;
      }
    }
    if (this.pending.some((s) => s.e === e.id)) this.pending = [];
  }

  /** Refresh cached geometry after edges were modified. */
  refreshGeometry() {
    const net = this.game.world.net;
    for (const list of [this.segs, this.pending]) {
      for (const s of list) {
        if (s.e < 0) continue;
        const e = net.edges.get(s.e);
        if (!e) continue;
        s.curve = net.geo(e);
        s.len = e.len;
      }
    }
    if (this.segs.length && this.headPos > this.segs[this.headSeg].len) this.headPos = this.segs[this.headSeg].len;
  }

  // ---------------------------------------------------------------- routing
  private reverseTrain(): boolean {
    if (!this.segs.length) return false;
    const tail = this.tailInfo();
    for (let i = tail.seg; i <= this.headSeg; i++) if (this.segs[i].e < 0) return false;
    this.releaseAhead();
    const R: TSeg[] = [];
    const net = this.game.world.net;
    for (let i = this.headSeg; i >= tail.seg; i--) {
      const e = net.edges.get(this.segs[i].e);
      if (!e) return false;
      R.push(makeSeg(this.game, e, -this.segs[i].dir));
    }
    for (let i = 0; i < tail.seg; i++) this.release(this.segs[i], R);
    this.segs = R;
    this.headSeg = R.length - 1;
    this.headPos = R[R.length - 1].len - tail.pos;
    this.cars.reverse();
    this.reversed = !this.reversed;
    return true;
  }

  private planRoute(allowReverse: boolean): boolean {
    const g = this.game;
    const target = this.targetStation();
    this.pending = [];
    if (!target) { this.state = 'stopped'; this.status = 'No line assigned'; return false; }
    if (!target.rail) { this.state = 'noroute'; this.status = target.name + ' has no platforms'; return false; }
    this.routeTarget = target.id;
    const last = this.segs[this.segs.length - 1];
    const fr = last ? frontier(g, last, this.owner) : [];
    let fwd = fr.length ? findRailRoute(g, fr, target.id, this.owner, this.id) : null;
    let rev: RouteResult | null = null;
    if (allowReverse && this.speed < 0.01 && this.segs.length && this.headSeg === this.segs.length - 1) {
      const tail = this.tailInfo();
      const ts = this.segs[tail.seg];
      if (ts.e >= 0 && g.world.net.edges.get(ts.e)) {
        const rf = frontier(g, { ...ts, dir: -ts.dir }, this.owner);
        if (rf.length) rev = findRailRoute(g, rf, target.id, this.owner, this.id);
      }
    }
    if (!fwd && !rev && this.onForeignTrack()) {
      // caught on tracks we may no longer use (an access agreement ended): find the way off them
      const fx = last ? frontier(g, last, this.owner, true) : [];
      fwd = fx.length ? findRailRoute(g, fx, target.id, this.owner, this.id, 60000, true) : null;
      if (!fwd && allowReverse && this.speed < 0.01 && this.segs.length && this.headSeg === this.segs.length - 1) {
        const ts = this.segs[this.tailInfo().seg];
        if (ts.e >= 0 && g.world.net.edges.get(ts.e)) {
          const rf = frontier(g, { ...ts, dir: -ts.dir }, this.owner, true);
          if (rf.length) rev = findRailRoute(g, rf, target.id, this.owner, this.id, 60000, true);
        }
      }
    }
    if (!fwd && !rev) {
      this.state = 'noroute';
      this.status = 'No route to ' + target.name;
      if (++this.failCount >= 3 && this.line && this.line.stops.length > 1) { this.advanceStop(); this.failCount = 0; }
      return false;
    }
    this.failCount = 0;
    const penalty = 10 + this.length * 2;
    // a loop line keeps circulating: turning back only where the way ahead leads nowhere
    const loop = !!this.line && g.lines.isLoop(this.line);
    let route = fwd;
    if (rev && (!fwd || (!loop && rev.cost + penalty < fwd.cost))) {
      if (this.reverseTrain()) route = rev;
    }
    if (!route) { this.state = 'noroute'; return false; }
    this.pending = route.conts.map((c) => makeSeg(g, c.edge, c.dir));
    this.state = 'running';
    this.status = 'Heading to ' + target.name;
    return true;
  }

  onLineChanged() {
    this.fixCargo();
    if (!this.onMap) { this.state = 'depot'; this.retryTimer = 0; return; }
    if (this.state === 'loading') return;
    this.atStation = -1;
    const g = this.game;
    const target = this.targetStation();
    const last = this.segs[this.segs.length - 1];
    if (target && !this.pending.length && last && last.e >= 0 && g.world.net.edges.get(last.e)?.station === target.id) {
      this.routeTarget = target.id;
      if (this.state === 'noroute' || this.state === 'stopped') { this.state = 'running'; this.status = 'Heading to ' + target.name; }
      return;
    }
    this.planRoute(this.speed < 0.01);
  }

  private tryLeaveDepot() {
    const g = this.game;
    const dp = g.depots.get(this.depotId);
    if (!dp) { this.status = 'Depot missing'; return; }
    if (!this.line || this.line.stops.length < 1) { this.status = 'In depot (no line)'; return; }
    for (const v of g.vehicles.trains()) {
      if (v !== this && v.segs.some((s) => s.depot === dp.id)) { this.status = 'Waiting to leave depot'; return; }
    }
    const vs = virtualDepotSeg(g, dp, this.length + 0.3);
    this.segs = [vs];
    this.headSeg = 0;
    this.headPos = vs.len;
    this.speed = 0;
    if (!this.planRoute(false)) { this.segs = []; this.state = 'noroute'; return; }
    if (!this.tryExtend()) {
      this.segs = [];
      this.pending = [];
      this.state = 'depot';
      this.status = 'Waiting for a free path out of the depot';
    }
  }

  depart() {
    this.atStation = -1;
    this.advanceStop();
    if (this.planRoute(true)) {
      if (!this.tryExtend()) { this.state = 'waiting'; this.status = 'Waiting for free path'; }
    }
    this.waitTime = 0;
  }

  private arrive() {
    const g = this.game;
    const st = g.stations.get(this.routeTarget);
    const head = this.segs[this.headSeg];
    const he = head && head.e >= 0 ? g.world.net.edges.get(head.e) : undefined;
    if (st && he && he.station === st.id) {
      this.atStation = st.id;
      this.state = 'loading';
      this.loadTimer = this.serveStation(st, 0.03);
      this.status = 'Loading at ' + st.name;
    } else {
      this.planRoute(true);
    }
  }

  // ---------------------------------------------------------------- update
  update(dt: number) {
    this.stateTime += dt;
    switch (this.state) {
      case 'depot':
      case 'noroute':
        this.retryTimer -= dt;
        if (this.retryTimer <= 0) {
          this.retryTimer = 2;
          if (!this.onMap) this.tryLeaveDepot();
          else if (this.planRoute(this.speed < 0.01)) this.tryExtend();
        }
        if (this.state === 'noroute' && this.onMap && this.speed > 0) this.move(dt);
        return;
      case 'stopped':
        if (this.onMap && this.speed > 0) this.move(dt);
        return;
      case 'loading':
        this.loadTimer -= dt;
        if (this.loadTimer <= 0) this.depart();
        return;
    }
    this.move(dt);
  }

  private tmpA = { x: 0, y: 0, z: 0 };
  private tmpB = { x: 0, y: 0, z: 0 };

  private move(dt: number) {
    if (!this.segs.length) return;
    const g = this.game;
    let dEnd = this.distToEnd();
    const vmax = this.maxSpeed;
    const brakeDist = (this.speed * this.speed) / (2 * TRAIN_BRAKE);
    if (this.pending.length && dEnd < brakeDist + 6) {
      if (this.tryExtend()) dEnd = this.distToEnd();
    }
    // target speed from the braking curve to the end of the reserved path and speed limits ahead
    let vt = Math.min(vmax, Math.sqrt(2 * TRAIN_BRAKE * Math.max(0, dEnd - 0.05)) + 0.02);
    const look = brakeDist + 3;
    let d = -this.headPos;
    for (let i = this.headSeg; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (i > this.headSeg && s.limit < vt) vt = Math.min(vt, Math.sqrt(s.limit * s.limit + 2 * TRAIN_BRAKE * Math.max(0, d)));
      if (s.e >= 0 && s.res.length > 1) {
        for (const r of s.res) {
          if (r < CROSS_BASE) continue;
          const c = g.world.net.crossings.get(r - CROSS_BASE);
          if (!c || c.kind !== 'level') continue;
          const sp = s.dir > 0 ? c.s1 : s.len - c.s1;
          const dist = d + sp;
          if (dist < 0.2 || dist > look + 2) continue;
          if (g.vehicles.roadBusyNear(c.e2, c.x, c.z, 0.55)) vt = Math.min(vt, Math.sqrt(2 * TRAIN_BRAKE * Math.max(0, dist - 0.7)));
        }
      }
      d += s.len;
      if (d > look) break;
    }
    // the whole train must respect the limits of the track it occupies
    const tail = this.tailInfo();
    for (let i = tail.seg; i <= this.headSeg; i++) vt = Math.min(vt, this.segs[i].limit);
    // physics: tractive effort limited by power and adhesion, gradient and running resistance (SI, then /10)
    const A = this.tmpA, B = this.tmpB;
    this.pointBehind(0, A);
    this.pointBehind(Math.min(this.length, 8), B);
    const span = Math.max(0.5, Math.min(this.length, 8));
    this.grade = (A.y - B.y) / span;
    const mass = this.mass;
    let locoMass = 0;
    for (const c of this.cars) if (c.power > 0) locoMass += c.weight;
    const vms = this.speed * 10;
    const adhesion = (0.28 * 9.81 * locoMass) / mass;
    const tract = Math.min(adhesion, (this.power * 0.92) / (mass * Math.max(2, vms)));
    const resist = 0.012 + 0.000035 * vms * vms;
    const accel = (tract - resist) / 10 - G * this.grade;
    if (this.speed < vt) this.speed = Math.max(0, Math.min(vt, this.speed + Math.max(accel, this.speed < 0.3 ? 0.004 : -0.05) * dt));
    else this.speed = Math.max(vt, this.speed - TRAIN_BRAKE * 1.3 * dt);
    if (this.speed > vt && this.speed - vt < 0.002) this.speed = vt;
    let mv = this.speed * dt;
    if (mv >= dEnd) mv = dEnd;
    this.headPos += mv;
    while (this.headPos > this.segs[this.headSeg].len && this.headSeg < this.segs.length - 1) {
      this.headPos -= this.segs[this.headSeg].len;
      this.headSeg++;
    }
    if (this.headPos > this.segs[this.headSeg].len) this.headPos = this.segs[this.headSeg].len;
    this.releaseBehind();
    const rem = this.distToEnd();
    if (rem < 0.02 && this.speed < 0.15) {
      this.speed = 0;
      if (this.state === 'noroute' || this.state === 'stopped') return;
      if (this.pending.length === 0) {
        this.waitTime = 0;
        this.arrive();
      } else {
        if (this.state !== 'waiting') { this.state = 'waiting'; this.waitTime = 0; }
        this.waitTime += dt;
        const bt = g.vehicles.get(this.blockedBy);
        this.status = 'Waiting for free path' + (bt ? ` (${bt.name} in the way)` : '');
        if (this.tryExtend()) { this.state = 'running'; this.status = 'Heading to ' + (g.stations.get(this.routeTarget)?.name ?? ''); }
        else if (this.waitTime > 6) {
          this.waitTime = 0;
          const he = this.segs[this.headSeg].e >= 0 ? g.world.net.edges.get(this.segs[this.headSeg].e) : undefined;
          if (this.planRoute(!!he && he.station >= 0)) this.state = 'waiting';
        }
      }
    } else if (this.state === 'waiting') {
      this.state = 'running';
      this.status = 'Heading to ' + (g.stations.get(this.routeTarget)?.name ?? '');
    }
  }

  destroy() { this.releaseAll(); }
}

/** Can a train leaving this depot reach the station? */
export function depotReaches(g: Game, dp: Depot, stationId: number): boolean {
  const stub = g.world.net.edges.get(dp.edge);
  if (!stub) return false;
  return !!findRailRoute(g, [{ edge: stub, dir: 1 }], stationId, dp.owner, -1, 80000);
}
