// Trains: rail pathfinding, path-based block reservation and movement.
import { Vehicle } from './vehicle';
import type { Game } from './game';
import type { Structure, Depot } from './world';
import { PathCurve, curvePoint, railPieceCurve, structureCurveCached, polylineCurve, Vec3Like } from './geom';
import { DX, DZ, OPP, PIECE_EDGES, pieceOf, KMH_TO_TPS, HSTEP, EDGE_MID_X, EDGE_MID_Z } from './constants';
import { VehicleModel } from './vehicle-types';

export interface TSeg {
  t: number; a: number; b: number;
  /** >=0 structure id, -1 tile piece, -2 depot */
  sid: number;
  rev: boolean;
  curve: PathCurve;
  len: number;
  res: number;
  limit: number;
  grade: number;
  /** 0 visible, 1 depot interior, 2 tunnel */
  hidden: number;
}

interface Node { t: number; e: number }
interface Frontier { via: TSeg[]; node: Node }

const BRAKE = 0.8;
const GAP = 0.04;

export function curveLimit(r: number): number {
  if (!isFinite(r)) return Infinity;
  return Math.max(30, 140 * Math.sqrt(r)) * KMH_TO_TPS;
}

export function makeTileSeg(g: Game, t: number, a: number, b: number): TSeg {
  const p = pieceOf(a, b);
  const c = railPieceCurve(g.world, t, p);
  const rev = PIECE_EDGES[p][0] !== a;
  const n = c.pts.length;
  const y0 = c.pts[1], y1 = c.pts[n - 2];
  const grade = (rev ? y0 - y1 : y1 - y0) / c.len;
  return { t, a, b, sid: -1, rev, curve: c, len: c.len, res: t, limit: curveLimit(c.minRadius), grade, hidden: 0 };
}

export function makeStructSeg(g: Game, s: Structure, fromA: boolean): TSeg {
  const w = g.world;
  const c = structureCurveCached(w, s, 0);
  const t = fromA ? w.idx(s.ax, s.az) : w.idx(s.bx, s.bz);
  return {
    t, a: -1, b: -1, sid: s.id, rev: !fromA, curve: c, len: c.len, res: w.size * w.size + s.id,
    limit: Infinity, grade: 0, hidden: s.kind === 'tunnel' ? 2 : 0,
  };
}

export function makeDepotSeg(g: Game, dp: Depot, length: number): TSeg {
  const w = g.world;
  const ex = dp.x + EDGE_MID_X[dp.dir], ez = dp.z + EDGE_MID_Z[dp.dir];
  const y = w.cornerH(dp.x, dp.z) * HSTEP;
  const pts = [ex - DX[dp.dir] * length, y, ez - DZ[dp.dir] * length, ex, y, ez];
  const c = polylineCurve(pts, true);
  return { t: w.idx(dp.x, dp.z), a: OPP[dp.dir], b: dp.dir, sid: -2, rev: false, curve: c, len: c.len, res: -1, limit: 1.0, grade: 0, hidden: 1 };
}

function flipSeg(g: Game, s: TSeg): TSeg | null {
  if (s.sid === -1) return makeTileSeg(g, s.t, s.b, s.a);
  if (s.sid >= 0) {
    const st = g.world.structures.get(s.sid);
    if (!st) return null;
    return makeStructSeg(g, st, s.rev);
  }
  return null;
}

/** Leaving tile t through edge b: what comes next? */
function follow(g: Game, t: number, b: number): Frontier | null {
  const w = g.world;
  const sid = w.headAt(t, b);
  if (sid >= 0) {
    const s = w.structures.get(sid)!;
    const fromA = w.idx(s.ax, s.az) === t && b === s.dir;
    const seg = makeStructSeg(g, s, fromA);
    const other = fromA ? w.idx(s.bx, s.bz) : w.idx(s.ax, s.az);
    const e = fromA ? OPP[s.dir] : s.dir;
    if (!(w.railEdges(other) & (1 << e))) return null;
    return { via: [seg], node: { t: other, e } };
  }
  const n = w.neighbour(t, b);
  if (n < 0) return null;
  if (!(w.railEdges(n) & (1 << OPP[b]))) return null;
  return { via: [], node: { t: n, e: OPP[b] } };
}

function frontierOf(g: Game, s: TSeg): Frontier | null {
  const w = g.world;
  if (s.sid >= 0) {
    const st = w.structures.get(s.sid);
    if (!st) return null;
    const fromA = !s.rev;
    const other = fromA ? w.idx(st.bx, st.bz) : w.idx(st.ax, st.az);
    const e = fromA ? OPP[st.dir] : st.dir;
    if (!(w.railEdges(other) & (1 << e))) return null;
    return { via: [], node: { t: other, e } };
  }
  return follow(g, s.t, s.b);
}

/** Signal state for a train travelling a->b on tile t: 0 none, 1 facing signal, -1 one-way against. */
export function signalFor(g: Game, t: number, a: number, b: number): number {
  const sig = g.world.signal[t];
  if (!sig) return 0;
  const p = pieceOf(a, b);
  const fwd = PIECE_EDGES[p][0] === a;
  if (sig === 1) return 1;
  if (sig === 2) return fwd ? 1 : -1;
  if (sig === 3) return fwd ? -1 : 1;
  return 0;
}

class MinHeap {
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
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && f[c + 1] < f[c]) c++; if (f[c] >= lf) break; f[i] = f[c]; v[i] = v[c]; i = c; }
      f[i] = lf; v[i] = lv;
    }
    return top;
  }
}

export interface RouteResult { segs: TSeg[]; cost: number }

/** A* from a frontier to any platform of the target station (ending at the platform's far end). */
export function findRailRoute(g: Game, fr: Frontier, targetStation: number, selfId: number, maxExpand = 30000): RouteResult | null {
  const w = g.world;
  const V = g.vehicles;
  const tgt = g.stations.get(targetStation);
  if (!tgt) return null;
  let hx = tgt.x + 0.5, hz = tgt.z + 0.5;
  const heur = (t: number) => Math.hypot(w.tx(t) + 0.5 - hx, w.tz(t) + 0.5 - hz) * 0.9;
  const NT: number[] = [], NE: number[] = [], NG: number[] = [], NP: number[] = [];
  const NV: TSeg[][] = [];
  const NGOAL: number[] = [];
  const best = new Map<number, number>();
  const heap = new MinHeap();
  const add = (t: number, e: number, gc: number, par: number, via: TSeg[], goal: number) => {
    if (!goal) {
      const k = t * 4 + e;
      const b = best.get(k);
      if (b !== undefined && b <= gc) return;
      best.set(k, gc);
    }
    const i = NT.length;
    NT.push(t); NE.push(e); NG.push(gc); NP.push(par); NV.push(via); NGOAL.push(goal);
    heap.push(i, gc + (goal ? 0 : heur(t)));
  };
  let viaCost = 0;
  for (const s of fr.via) viaCost += s.len + (s.res >= 0 && V.getRes(s.res) !== 0 && V.getRes(s.res) !== selfId ? 8 : 0);
  add(fr.node.t, fr.node.e, viaCost, -1, fr.via, 0);
  let n = 0;
  let goal = -1;
  while (heap.size) {
    const i = heap.pop();
    if (NGOAL[i]) { goal = i; break; }
    const t = NT[i], e = NE[i];
    if ((best.get(t * 4 + e) ?? Infinity) < NG[i]) continue;
    if (++n > maxExpand) break;
    const gc = NG[i];
    if (w.station[t] === targetStation && w.stationKind[t] === 1) {
      // extend along platform to its end
      const segs: TSeg[] = [];
      let cur = t, ent = e, occupied = false, ok = true;
      for (let k = 0; k < 16; k++) {
        const exit = OPP[ent];
        if (!(w.railExits(cur, ent) & (1 << exit))) { ok = k > 0; break; }
        const s = makeTileSeg(g, cur, ent, exit);
        segs.push(s);
        const r = V.getRes(s.res);
        if (r !== 0 && r !== selfId) occupied = true;
        if (w.headAt(cur, exit) >= 0) break;
        const nx = w.neighbour(cur, exit);
        if (nx < 0 || w.station[nx] !== targetStation || w.stationKind[nx] !== 1 || !(w.railEdges(nx) & (1 << OPP[exit]))) break;
        cur = nx; ent = OPP[exit];
      }
      if (ok && segs.length) {
        let len = 0;
        for (const s of segs) len += s.len;
        add(t, e, gc + len + (occupied ? 60 : 0), i, segs, 1);
      }
      // a train may also pass through this station without stopping (continue search)
    }
    const exits = w.railExits(t, e);
    for (let b = 0; b < 4; b++) {
      if (!(exits & (1 << b))) continue;
      const sg = signalFor(g, t, e, b);
      if (sg < 0) continue;
      const s = makeTileSeg(g, t, e, b);
      const r = V.getRes(s.res);
      let c = s.len + (isFinite(s.limit) ? 0.25 : 0) + (r !== 0 && r !== selfId ? 6 : 0);
      if (w.station[t] >= 0 && w.station[t] !== targetStation) c += 1.5;
      const f = follow(g, t, b);
      if (!f) continue;
      const via = [s, ...f.via];
      for (const x of f.via) c += x.len + (V.getRes(x.res) !== 0 && V.getRes(x.res) !== selfId ? 6 : 0);
      add(f.node.t, f.node.e, gc + c, i, via, 0);
    }
  }
  if (goal < 0) return null;
  const parts: TSeg[][] = [];
  for (let i = goal; i >= 0; i = NP[i]) parts.push(NV[i]);
  parts.reverse();
  const segs = parts.flat();
  return { segs, cost: NG[goal] };
}

// ---------------------------------------------------------------------------------------------

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

  constructor(game: Game, id: number, cars: VehicleModel[], depotId: number) {
    super(game, id);
    this.cars = cars;
    this.depotId = depotId;
    this.value = cars.reduce((s, c) => s + c.cost, 0);
    const dp = game.world.depots.get(depotId);
    if (dp) { this.homeX = dp.x + 0.5; this.homeZ = dp.z + 0.5; }
  }

  get length() { let l = 0; for (const c of this.cars) l += c.length + GAP; return l; }
  get capacity() { let c = 0; for (const m of this.cars) c += m.capacity; return c; }
  get maxSpeedKmh() { let v = Infinity; for (const m of this.cars) v = Math.min(v, m.speed); return v; }
  get maxSpeed() { return this.maxSpeedKmh * KMH_TO_TPS; }
  get speedKmh() { return this.speed / KMH_TO_TPS; }
  get runningCost() { let c = 0; for (const m of this.cars) c += m.running; return c; }
  get loco() { return this.cars.find((c) => c.kind === 'loco') ?? this.cars[0]; }
  get onMap() { return this.segs.length > 0; }

  // ---------------------------------------------------------------- geometry
  tailInfo(): { seg: number; pos: number } {
    let rem = this.length;
    let i = this.headSeg, p = this.headPos;
    while (rem > p && i > 0) { rem -= p; i--; p = this.segs[i].len; }
    return { seg: i, pos: Math.max(0, p - rem) };
  }

  /** Point at distance d behind the head. Returns the seg and the distance along it. */
  pointBehind(d: number, out: Vec3Like, dir?: Vec3Like): { seg: TSeg; sp: number } | null {
    if (!this.segs.length) return null;
    let i = this.headSeg, p = this.headPos;
    while (d > p && i > 0) { d -= p; i--; p = this.segs[i].len; }
    const s = this.segs[i];
    const sp = Math.max(0, p - d);
    curvePoint(s.curve, s.rev ? s.len - sp : sp, out, dir);
    if (dir && s.rev) { dir.x = -dir.x; dir.y = -dir.y; dir.z = -dir.z; }
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

  // ---------------------------------------------------------------- reservation
  private tryExtend(): boolean {
    if (!this.pending.length) return false;
    const V = this.game.vehicles;
    let j = this.pending.length;
    for (let k = 1; k < this.pending.length; k++) {
      const s = this.pending[k];
      if (s.sid === -1 && signalFor(this.game, s.t, s.a, s.b) > 0) { j = k; break; }
    }
    for (let k = 0; k < j; k++) {
      const r = this.pending[k].res;
      if (r < 0) continue;
      const o = V.getRes(r);
      if (o !== 0 && o !== this.id) { this.blockedBy = o; return false; }
    }
    for (let k = 0; k < j; k++) { const r = this.pending[k].res; if (r >= 0) V.setRes(r, this.id); }
    this.segs.push(...this.pending.splice(0, j));
    return true;
  }

  private releaseBehind() {
    const tail = this.tailInfo();
    if (tail.seg <= 0) return;
    const drop = this.segs.splice(0, tail.seg);
    this.headSeg -= tail.seg;
    const V = this.game.vehicles;
    for (const s of drop) {
      if (s.res < 0) continue;
      if (this.segs.some((x) => x.res === s.res)) continue;
      V.releaseRes(s.res, this.id);
    }
  }

  private releaseAhead() {
    const V = this.game.vehicles;
    const tail = this.tailInfo();
    const keep = this.segs.slice(tail.seg, this.headSeg + 1);
    for (let i = this.headSeg + 1; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (s.res >= 0 && !keep.some((x) => x.res === s.res)) V.releaseRes(s.res, this.id);
    }
    this.segs.length = this.headSeg + 1;
  }

  releaseAll() {
    const V = this.game.vehicles;
    for (const s of this.segs) if (s.res >= 0) V.releaseRes(s.res, this.id);
    this.segs = [];
    this.pending = [];
  }

  // ---------------------------------------------------------------- routing
  private reverseTrain(): boolean {
    if (!this.segs.length) return false;
    const tail = this.tailInfo();
    this.releaseAhead();
    const R: TSeg[] = [];
    for (let i = this.headSeg; i >= tail.seg; i--) {
      const f = flipSeg(this.game, this.segs[i]);
      if (!f) return false;
      R.push(f);
    }
    const V = this.game.vehicles;
    for (let i = 0; i < tail.seg; i++) {
      const s = this.segs[i];
      if (s.res >= 0 && !R.some((x) => x.res === s.res)) V.releaseRes(s.res, this.id);
    }
    this.segs = R;
    this.headSeg = R.length - 1;
    this.headPos = R[R.length - 1].len - tail.pos;
    this.cars.reverse();
    this.reversed = !this.reversed;
    return true;
  }

  /** Compute a route to the current target station. */
  private planRoute(allowReverse: boolean): boolean {
    const g = this.game;
    const target = this.targetStation();
    this.pending = [];
    if (!target) { this.state = 'stopped'; this.status = 'No line assigned'; return false; }
    this.routeTarget = target.id;
    const last = this.segs[this.segs.length - 1];
    const fr = last ? frontierOf(g, last) : null;
    let fwd = fr ? findRailRoute(g, fr, target.id, this.id) : null;
    let rev: RouteResult | null = null;
    let revFr: Frontier | null = null;
    if (allowReverse && this.speed < 0.01 && this.segs.length && this.headSeg === this.segs.length - 1) {
      const tail = this.tailInfo();
      const f = flipSeg(g, this.segs[tail.seg]);
      if (f) {
        revFr = frontierOf(g, f);
        if (revFr) rev = findRailRoute(g, revFr, target.id, this.id);
      }
    }
    if (!fwd && !rev) {
      this.state = 'noroute';
      this.status = 'No route to ' + target.name;
      // after repeated failures try the next stop of the line
      if (++this.failCount >= 3 && this.line && this.line.stops.length > 1) { this.advanceStop(); this.failCount = 0; }
      return false;
    }
    this.failCount = 0;
    const revPenalty = 6 + this.length * 2;
    if (rev && (!fwd || rev.cost + revPenalty < fwd.cost)) {
      this.reverseTrain();
      const last2 = this.segs[this.segs.length - 1];
      const fr2 = frontierOf(g, last2);
      if (!fr2) { this.state = 'noroute'; return false; }
      const r2 = findRailRoute(g, fr2, target.id, this.id);
      if (!r2) { this.state = 'noroute'; this.status = 'No route to ' + target.name; return false; }
      this.pending = r2.segs;
    } else if (fwd) {
      this.pending = fwd.segs;
    }
    this.state = 'running';
    this.status = 'Heading to ' + target.name;
    return true;
  }

  onLineChanged() {
    this.fixCargo();
    if (!this.onMap) { this.state = 'depot'; this.retryTimer = 0; return; }
    if (this.state === 'loading') return;
    this.atStation = -1;
    // the reserved path already ends at a platform of the current target: nothing to do
    const target = this.targetStation();
    const last = this.segs[this.segs.length - 1];
    if (target && !this.pending.length && last && last.sid === -1 && this.game.world.station[last.t] === target.id && this.game.world.stationKind[last.t] === 1) {
      this.routeTarget = target.id;
      if (this.state === 'noroute') { this.state = 'running'; this.status = 'Heading to ' + target.name; }
      return;
    }
    // otherwise replace the unreserved part of the plan
    this.planRoute(this.speed < 0.01);
  }

  private tryLeaveDepot() {
    const g = this.game;
    const dp = g.world.depots.get(this.depotId);
    if (!dp) { this.status = 'Depot missing'; return; }
    if (!this.line || this.line.stops.length < 1) { this.status = 'In depot (no line)'; return; }
    // only one train may occupy the depot exit at a time
    for (const v of g.vehicles.trains()) {
      if (v !== this && v.segs.some((s) => s.sid === -2 && s.t === g.world.idx(dp.x, dp.z))) { this.status = 'Waiting to leave depot'; return; }
    }
    const dseg = makeDepotSeg(g, dp, this.length + 0.2);
    this.segs = [dseg];
    this.headSeg = 0;
    this.headPos = dseg.len;
    this.speed = 0;
    if (!this.planRoute(false)) { this.segs = []; this.state = 'noroute'; return; }
    if (!this.tryExtend()) { this.state = 'waiting'; this.status = 'Waiting for free path'; }
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
    if (st && head && g.world.station[head.t] === st.id) {
      this.atStation = st.id;
      this.state = 'loading';
      this.loadTimer = this.serveStation(st, 0.02);
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
        // keep braking to the end of the reserved path instead of freezing
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

  private move(dt: number) {
    if (!this.segs.length) return;
    let dEnd = this.distToEnd();
    const vmax = this.maxSpeed;
    if (this.pending.length && dEnd < (this.speed * this.speed) / (2 * BRAKE) + 2.5) {
      if (this.tryExtend()) dEnd = this.distToEnd();
    }
    // target speed: braking to end of reservation and for curves ahead
    let vt = Math.min(vmax, Math.sqrt(2 * BRAKE * Math.max(0, dEnd)) + 0.06);
    let d = -this.headPos;
    const look = (this.speed * this.speed) / (2 * BRAKE) + 1;
    for (let i = this.headSeg; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (s.limit < vt) vt = Math.min(vt, Math.sqrt(s.limit * s.limit + 2 * BRAKE * Math.max(0, d)));
      d += s.len;
      if (d > look) break;
    }
    // level crossings: road traffic already on the crossing must clear it first
    {
      const world = this.game.world;
      let dd = -this.headPos;
      for (let i = this.headSeg; i < this.segs.length && dd < look + 0.5; i++) {
        const s = this.segs[i];
        if (i > this.headSeg && s.sid === -1 && world.road[s.t] && this.game.vehicles.roadBusy(s.t)) {
          vt = Math.min(vt, Math.sqrt(2 * BRAKE * Math.max(0, dd - 0.15)));
          break;
        }
        dd += s.len;
      }
    }
    // keep curve limit until the whole train passed
    const tail = this.tailInfo();
    for (let i = tail.seg; i < this.headSeg; i++) vt = Math.min(vt, this.segs[i].limit);
    const head = this.segs[this.headSeg];
    if (head.sid === -2) vt = Math.min(vt, 1.2);
    // acceleration
    let mass = 0, power = 0;
    for (const c of this.cars) { mass += c.weight; power += c.power; }
    mass += this.load * 0.075;
    const grade = head.grade;
    let acc = (0.07 + (power / mass) * 0.022) * Math.max(0.15, 1 - (0.7 * this.speed) / vmax) - grade * 0.6;
    if (acc < 0 && this.speed < 0.35) acc = 0.02;
    if (this.speed < vt) this.speed = Math.min(vt, this.speed + acc * dt);
    else this.speed = Math.max(vt, this.speed - BRAKE * 1.5 * dt);
    let mv = this.speed * dt;
    if (mv >= dEnd) { mv = dEnd; }
    this.headPos += mv;
    while (this.headPos > this.segs[this.headSeg].len && this.headSeg < this.segs.length - 1) {
      this.headPos -= this.segs[this.headSeg].len;
      this.headSeg++;
    }
    if (this.headPos > this.segs[this.headSeg].len) this.headPos = this.segs[this.headSeg].len;
    this.releaseBehind();
    const rem = this.distToEnd();
    if (rem < 0.004 && this.speed < 0.25) {
      this.speed = 0;
      if (this.state === 'noroute' || this.state === 'stopped') return;
      if (this.pending.length === 0) {
        this.waitTime = 0;
        this.arrive();
      } else {
        if (this.state !== 'waiting') { this.state = 'waiting'; this.waitTime = 0; }
        this.waitTime += dt;
        const bt = this.game.vehicles.get(this.blockedBy);
        this.status = 'Waiting for free path' + (bt ? ` (${bt.name} in the way)` : '');
        if (this.tryExtend()) { this.state = 'running'; this.status = 'Heading to ' + (this.game.stations.get(this.routeTarget)?.name ?? ''); }
        else if (this.waitTime > 4) {
          this.waitTime = 0;
          // look for an alternative path (e.g. another platform)
          const atSt = this.game.world.station[this.segs[this.headSeg].t] >= 0;
          if (this.planRoute(atSt)) this.state = 'waiting';
        }
      }
    } else if (this.state === 'waiting') {
      this.state = 'running';
      this.status = 'Heading to ' + (this.game.stations.get(this.routeTarget)?.name ?? '');
    }
  }

  destroy() { this.releaseAll(); }
}

/** Can a train leaving this depot reach the station? */
export function depotReaches(g: Game, dp: Depot, stationId: number): boolean {
  const fr = follow(g, g.world.idx(dp.x, dp.z), dp.dir);
  if (!fr) return false;
  return !!findRailRoute(g, fr, stationId, -1, 40000);
}
