// Road vehicles: buses on lines and ambient town traffic.
import { Vehicle } from './vehicle';
import type { Game } from './game';
import type { Structure, Depot } from './world';
import { PathCurve, curvePoint, roadLaneCurve, structureCurveCached, polylineCurve, Vec3Like } from './geom';
import { DX, DZ, OPP, KMH_TO_TPS, EDGE_MID_X, EDGE_MID_Z, LANE_OFFSET, HSTEP } from './constants';
import { VehicleModel } from './vehicle-types';
import { RNG } from './rng';

export interface RSeg {
  t: number; a: number; b: number;
  sid: number; // >=0 structure, -1 tile, -2 depot
  rev: boolean;
  curve: PathCurve;
  len: number;
  limit: number;
  stop: boolean;
  hidden: number;
}

interface Node { t: number; e: number }
interface Frontier { via: RSeg[]; node: Node }

const BRAKE = 1.6;
const ACC = 0.55;

function roadLimit(r: number): number {
  if (!isFinite(r)) return Infinity;
  return Math.max(20, 95 * Math.sqrt(r)) * KMH_TO_TPS;
}

export function makeRoadSeg(g: Game, t: number, a: number, b: number): RSeg {
  const c = roadLaneCurve(g.world, t, a, b);
  return { t, a, b, sid: -1, rev: false, curve: c, len: c.len, limit: roadLimit(c.minRadius), stop: false, hidden: 0 };
}

export function makeRoadStructSeg(g: Game, s: Structure, fromA: boolean): RSeg {
  const w = g.world;
  const c = structureCurveCached(w, s, fromA ? 1 : 2);
  const t = fromA ? w.idx(s.ax, s.az) : w.idx(s.bx, s.bz);
  return { t, a: -1, b: -1, sid: s.id, rev: !fromA, curve: c, len: c.len, limit: Infinity, stop: false, hidden: s.kind === 'tunnel' ? 2 : 0 };
}

export function makeRoadDepotSeg(g: Game, dp: Depot): RSeg {
  const w = g.world;
  const d = dp.dir;
  const rx = -DZ[d] * LANE_OFFSET, rz = DX[d] * LANE_OFFSET;
  const y = w.cornerH(dp.x, dp.z) * HSTEP;
  const pts = [dp.x + 0.5 + rx - DX[d] * 0.1, y, dp.z + 0.5 + rz - DZ[d] * 0.1, dp.x + EDGE_MID_X[d] + rx, y, dp.z + EDGE_MID_Z[d] + rz];
  const c = polylineCurve(pts, true);
  return { t: w.idx(dp.x, dp.z), a: OPP[d], b: d, sid: -2, rev: false, curve: c, len: c.len, limit: 0.6, stop: false, hidden: 1 };
}

function follow(g: Game, t: number, b: number): Frontier | null {
  const w = g.world;
  const sid = w.headAt(t, b);
  if (sid >= 0) {
    const s = w.structures.get(sid)!;
    if (s.transport !== 'road') return null;
    const fromA = w.idx(s.ax, s.az) === t && b === s.dir;
    const other = fromA ? w.idx(s.bx, s.bz) : w.idx(s.ax, s.az);
    const e = fromA ? OPP[s.dir] : s.dir;
    if (!(w.road[other] & (1 << e))) return null;
    return { via: [makeRoadStructSeg(g, s, fromA)], node: { t: other, e } };
  }
  const n = w.neighbour(t, b);
  if (n < 0 || !(w.road[n] & (1 << OPP[b]))) return null;
  return { via: [], node: { t: n, e: OPP[b] } };
}

function frontierOf(g: Game, s: RSeg): Frontier | null {
  const w = g.world;
  if (s.sid >= 0) {
    const st = w.structures.get(s.sid);
    if (!st) return null;
    const fromA = !s.rev;
    const other = fromA ? w.idx(st.bx, st.bz) : w.idx(st.ax, st.az);
    const e = fromA ? OPP[st.dir] : st.dir;
    return { via: [], node: { t: other, e } };
  }
  return follow(g, s.t, s.b);
}

function uTurnCost(g: Game, t: number, e: number): number {
  const w = g.world;
  const m = w.road[t];
  if (m === 1 << e) return w.rail[t] ? -1 : 0.6;
  if (w.rail[t] || w.station[t] >= 0) return -1;
  if (m === ((1 << e) | (1 << OPP[e]))) return 7;
  return -1;
}

export function findRoadRoute(g: Game, fr: Frontier, target: number, maxExpand = 20000): { segs: RSeg[]; cost: number } | null {
  const w = g.world;
  const st = g.stations.get(target);
  if (!st) return null;
  const heur = (t: number) => Math.hypot(w.tx(t) - st.x, w.tz(t) - st.z) * 0.9;
  const NT: number[] = [], NE: number[] = [], NG: number[] = [], NP: number[] = [], NGOAL: number[] = [];
  const NV: RSeg[][] = [];
  const best = new Map<number, number>();
  const heap: { f: number; i: number }[] = [];
  const push = (i: number, f: number) => {
    heap.push({ f, i });
    let k = heap.length - 1;
    while (k > 0) { const p = (k - 1) >> 1; if (heap[p].f <= f) break; [heap[p], heap[k]] = [heap[k], heap[p]]; k = p; }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      let k = 0;
      for (;;) {
        let c = 2 * k + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++;
        if (heap[c].f >= heap[k].f) break;
        [heap[c], heap[k]] = [heap[k], heap[c]]; k = c;
      }
    }
    return top.i;
  };
  const add = (t: number, e: number, gc: number, par: number, via: RSeg[], goal: number) => {
    if (!goal) {
      const k = t * 4 + e;
      const b = best.get(k);
      if (b !== undefined && b <= gc) return;
      best.set(k, gc);
    }
    const i = NT.length;
    NT.push(t); NE.push(e); NG.push(gc); NP.push(par); NV.push(via); NGOAL.push(goal);
    push(i, gc + (goal ? 0 : heur(t)));
  };
  let c0 = 0;
  for (const s of fr.via) c0 += s.len;
  add(fr.node.t, fr.node.e, c0, -1, fr.via, 0);
  let n = 0, goal = -1;
  while (heap.length) {
    const i = pop();
    if (NGOAL[i]) { goal = i; break; }
    const t = NT[i], e = NE[i];
    if ((best.get(t * 4 + e) ?? Infinity) < NG[i]) continue;
    if (++n > maxExpand) break;
    const gc = NG[i];
    const m = w.road[t];
    if (w.station[t] === target && w.stationKind[t] === 2) {
      if ((m & (1 << OPP[e])) && follow(g, t, OPP[e])) {
        const s = makeRoadSeg(g, t, e, OPP[e]);
        s.stop = true;
        add(t, e, gc + s.len * 0.5, i, [s], 1);
      } else if (m & (1 << e)) {
        // dead-end stop: turn around at the stop
        const s = makeRoadSeg(g, t, e, e);
        s.stop = true;
        add(t, e, gc + s.len * 0.5, i, [s], 1);
      }
    }
    for (let b = 0; b < 4; b++) {
      if (!(m & (1 << b))) continue;
      let extra = 0;
      if (b === e) { extra = uTurnCost(g, t, e); if (extra < 0) continue; }
      const s = makeRoadSeg(g, t, e, b);
      const f = follow(g, t, b);
      if (!f) continue;
      let c = s.len + extra + (b !== e && b !== OPP[e] ? 0.15 : 0);
      for (const x of f.via) c += x.len;
      add(f.node.t, f.node.e, gc + c, i, [s, ...f.via], 0);
    }
  }
  if (goal < 0) return null;
  const parts: RSeg[][] = [];
  for (let i = goal; i >= 0; i = NP[i]) parts.push(NV[i]);
  parts.reverse();
  return { segs: parts.flat(), cost: NG[goal] };
}

// -----------------------------------------------------------------------------------------------

export class RoadVehicle extends Vehicle {
  readonly kind = 'road' as const;
  model: VehicleModel | null;
  ambient: boolean;
  color: number;
  carStyle = 0;
  seg: RSeg | null = null;
  prev: RSeg | null = null;
  pos = 0;
  speed = 0;
  route: RSeg[] = [];
  depotId: number;
  loadTimer = 0;
  retryTimer = 0;
  blocked = 0;
  routeTarget = -1;
  life = 0;
  failCount = 0;
  private rng: RNG;

  constructor(game: Game, id: number, model: VehicleModel | null, depotId: number, ambient = false, seed = 1) {
    super(game, id);
    this.model = model;
    this.ambient = ambient;
    this.depotId = depotId;
    this.rng = new RNG(seed + id * 7919);
    this.color = model ? model.color : [0xc0392b, 0x2980b9, 0xf1c40f, 0xecf0f1, 0x2c3e50, 0x27ae60, 0x8e44ad, 0x7f8c8d, 0xd35400, 0x1abc9c][this.rng.int(10)];
    this.carStyle = this.rng.int(3);
    this.value = model ? model.cost : 0;
    this.life = 60 + this.rng.next() * 160;
    const dp = game.world.depots.get(depotId);
    if (dp) { this.homeX = dp.x + 0.5; this.homeZ = dp.z + 0.5; }
  }

  get length() { return this.model ? this.model.length : this.carStyle === 2 ? 0.36 : 0.28; }
  get capacity() { return this.model ? this.model.capacity : 0; }
  get maxSpeedKmh() { return this.model ? this.model.speed : 50; }
  get maxSpeed() { return this.maxSpeedKmh * KMH_TO_TPS; }
  get speedKmh() { return this.speed / KMH_TO_TPS; }
  get runningCost() { return this.model ? this.model.running : 0; }
  get onMap() { return this.seg !== null; }

  /** Place an ambient vehicle on a road tile. */
  placeAt(t: number, e: number) {
    this.seg = null;
    this.route = [];
    const g = this.game;
    const m = g.world.road[t];
    const exits: number[] = [];
    for (let b = 0; b < 4; b++) if (b !== e && m & (1 << b) && follow(g, t, b)) exits.push(b);
    const b = exits.length ? exits[this.rng.int(exits.length)] : e;
    this.seg = makeRoadSeg(g, t, e, b);
    this.pos = this.rng.next() * this.seg.len * 0.5;
    this.state = 'running';
  }

  pointBehind(d: number, out: Vec3Like, dir?: Vec3Like): RSeg | null {
    let s = this.seg;
    if (!s) return null;
    let p = this.pos - d;
    if (p < 0 && this.prev) { s = this.prev; p = s.len + p; }
    if (p < 0) p = 0;
    curvePoint(s.curve, s.rev ? s.len - p : p, out, dir);
    if (dir && s.rev) { dir.x = -dir.x; dir.y = -dir.y; dir.z = -dir.z; }
    return s;
  }

  worldPos(out: Vec3Like): boolean {
    if (!this.seg) { out.x = this.homeX; out.y = 0; out.z = this.homeZ; return false; }
    this.pointBehind(this.length / 2, out);
    return true;
  }

  onLineChanged() {
    if (this.ambient) return;
    this.fixCargo();
    if (!this.seg) { this.state = 'depot'; return; }
    if (this.state === 'loading') return;
    this.planRoute();
  }

  /** The road ahead is gone: turn around within the current tile. */
  turnAround(): boolean {
    const s = this.seg;
    if (!s || s.sid !== -1 || s.a === s.b || s.a < 0) return false;
    const ut = makeRoadSeg(this.game, s.t, s.a, s.a);
    this.pos = Math.min(this.pos, ut.len * 0.3);
    this.prev = null;
    this.seg = ut;
    this.route = [];
    return true;
  }

  private planRoute(): boolean {
    const g = this.game;
    const target = this.targetStation();
    this.route = [];
    if (!target) { this.state = 'stopped'; this.status = 'No line assigned'; return false; }
    this.routeTarget = target.id;
    if (!this.seg) return false;
    let fr = frontierOf(g, this.seg);
    if (!fr && this.turnAround()) fr = frontierOf(g, this.seg);
    const res = fr ? findRoadRoute(g, fr, target.id) : null;
    if (!res) {
      this.state = 'noroute';
      this.status = 'No route to ' + target.name;
      if (++this.failCount >= 3 && this.line && this.line.stops.length > 1) { this.advanceStop(); this.failCount = 0; }
      return false;
    }
    this.failCount = 0;
    this.route = res.segs;
    this.state = 'running';
    this.status = 'Heading to ' + target.name;
    return true;
  }

  private tryLeaveDepot() {
    const g = this.game;
    const dp = g.world.depots.get(this.depotId);
    if (!dp) { this.status = 'Depot missing'; return; }
    if (!this.line || this.line.stops.length < 1) { this.status = 'In depot (no line)'; return; }
    // wait if the exit lane is occupied
    const dt0 = g.world.idx(dp.x, dp.z);
    for (const v of g.vehicles.roads()) if (v !== this && v.seg && v.seg.t === dt0 && v.seg.sid === -2) { this.status = 'Waiting to leave depot'; return; }
    this.seg = makeRoadDepotSeg(g, dp);
    this.pos = 0;
    this.speed = 0;
    if (!this.planRoute()) { this.seg = null; this.state = 'noroute'; }
  }

  private nextAmbientSeg(): RSeg | null {
    const g = this.game;
    const last = this.route.length ? this.route[this.route.length - 1] : this.seg!;
    const fr = frontierOf(g, last);
    if (!fr) {
      // the road ahead disappeared: turn around where we are
      if (last === this.seg) this.turnAround();
      return null;
    }
    const { t, e } = fr.node;
    const w = g.world;
    const m = w.road[t];
    const opts: number[] = [];
    for (let b = 0; b < 4; b++) {
      if (b === e || !(m & (1 << b))) continue;
      if (!follow(g, t, b)) continue;
      opts.push(b);
      if (b === OPP[e]) opts.push(b, b); // prefer straight on
    }
    const b = opts.length ? opts[this.rng.int(opts.length)] : e;
    this.route.push(...fr.via);
    return makeRoadSeg(g, t, e, b);
  }

  update(dt: number) {
    this.stateTime += dt;
    if (this.ambient) this.life -= dt;
    switch (this.state) {
      case 'depot':
      case 'noroute':
        this.retryTimer -= dt;
        if (this.retryTimer <= 0) {
          this.retryTimer = 2;
          if (!this.seg) this.tryLeaveDepot();
          else this.planRoute();
        }
        if ((this.state as string) !== 'running') {
          if (this.state === 'noroute' && this.seg && this.speed > 0) this.move(dt);
          return;
        }
        break;
      case 'stopped':
        return;
      case 'loading':
        this.loadTimer -= dt;
        if (this.loadTimer <= 0) {
          this.advanceStop();
          if (this.seg) this.seg.stop = false;
          this.planRoute();
        }
        return;
    }
    this.move(dt);
  }

  private move(dt: number) {
    const g = this.game;
    const seg = this.seg;
    if (!seg) return;
    if (this.ambient) {
      while (this.route.length < 3) {
        const n = this.nextAmbientSeg();
        if (!n) break;
        this.route.push(n);
      }
    }
    const vmax = this.maxSpeed;
    let vt = vmax;
    const look = (this.speed * this.speed) / (2 * BRAKE) + 0.6;
    // stop point
    let dist = seg.len - this.pos;
    let stopDist = Infinity;
    if (seg.stop) stopDist = seg.len / 2 - this.pos;
    vt = Math.min(vt, seg.limit);
    for (let i = 0; i < this.route.length && dist < look + 1; i++) {
      const s = this.route[i];
      // level crossing: stop if a train has reserved it
      if (s.sid === -1 && g.world.rail[s.t] && g.vehicles.getRes(s.t) !== 0) { stopDist = Math.min(stopDist, dist - 0.08); break; }
      if (s.limit < vt) vt = Math.min(vt, Math.sqrt(s.limit * s.limit + 2 * BRAKE * Math.max(0, dist)));
      if (s.stop) { stopDist = Math.min(stopDist, dist + s.len / 2); break; }
      dist += s.len;
    }
    if (!this.route.length && !seg.stop) stopDist = Math.min(stopDist, seg.len - this.pos);
    // following
    const gap = g.vehicles.gapAhead(this, look + 0.6);
    if (gap < Infinity) {
      if (gap < 0.02) this.blocked += dt; else this.blocked = 0;
      if (this.blocked < 5) stopDist = Math.min(stopDist, gap - 0.04);
    } else this.blocked = 0;
    if (stopDist < Infinity) vt = Math.min(vt, Math.sqrt(2 * BRAKE * Math.max(0, stopDist)) + (stopDist > 0.01 ? 0.04 : 0));
    if (this.speed < vt) this.speed = Math.min(vt, this.speed + ACC * dt);
    else this.speed = Math.max(vt, this.speed - BRAKE * 1.6 * dt);
    let mv = this.speed * dt;
    if (stopDist < Infinity && mv > Math.max(0, stopDist)) mv = Math.max(0, stopDist);
    this.pos += mv;
    while (this.seg && this.pos >= this.seg.len) {
      const next = this.route.shift();
      if (!next) { this.pos = this.seg.len; break; }
      this.pos -= this.seg.len;
      this.prev = this.seg;
      this.seg = next;
      if (this.ambient && this.life < 0) { this.state = 'stopped'; return; }
    }
    const cur = this.seg!;
    if (cur.stop && this.pos >= cur.len / 2 - 0.02 && this.speed < 0.3) {
      this.speed = 0;
      const st = g.stations.get(this.routeTarget);
      if (st && g.world.station[cur.t] === st.id) {
        this.state = 'loading';
        this.loadTimer = this.serveStation(st, 0.045);
        this.status = 'Loading at ' + st.name;
      } else { cur.stop = false; this.planRoute(); }
    } else if (!this.route.length && this.pos >= cur.len - 0.001 && !this.ambient) {
      this.speed = 0;
      if (this.state === 'running') this.planRoute();
    }
  }

  destroy() { this.seg = null; this.route = []; }
}

/** Can a bus leaving this depot reach the station? */
export function roadDepotReaches(g: Game, dp: Depot, stationId: number): boolean {
  const fr = follow(g, g.world.idx(dp.x, dp.z), dp.dir);
  if (!fr) return false;
  return !!findRoadRoute(g, fr, stationId, 40000);
}
