// Road vehicles: buses on lines and ambient town traffic, driving on lane curves of the road graph.
import { Vehicle } from './vehicle';
import type { Game } from './game';
import type { Depot } from './build-ops';
import { Curve3, curvePoint, makeCurve, NEdge } from './network';
import { KMH_TO_UPS, ROAD_TYPES } from './constants';
import { curveSpeed } from './construction';
import type { VehicleModel } from './vehicle-types';
import { closestOnPolyline, segIntersect, Vec3Like } from './geom';
import { RNG } from './rng';
import { Heap } from './train';

export interface RSeg {
  kind: 'lane' | 'conn';
  /** lane: edge and direction; conn: the edge/direction it leads to */
  e: number;
  dir: number;
  /** conn: junction node and the edge/direction it comes from */
  node: number;
  from: number;
  fromDir: number;
  curve: Curve3;
  len: number;
  limit: number;
  tunnels: [number, number][];
  crossings: { id: number; pos: number }[];
  /** bus stop position along this lane */
  stopAt?: number;
  depot?: boolean;
}

const BRAKE = 0.3;
const G = 0.981;

export function laneTrim(g: Game, e: NEdge): [number, number] {
  const net = g.world.net;
  const ra = net.junctionRadius(e.a), rb = net.junctionRadius(e.b);
  return [Math.min(ra, e.len * 0.45), Math.max(e.len - rb, e.len * 0.55)];
}

export function makeLaneSeg(g: Game, e: NEdge, dir: number): RSeg {
  const net = g.world.net;
  const curve = net.lane(e, dir);
  const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
  let kmh = Math.min(rt.speed, curveSpeed(curve.minRadius));
  if (e.depot >= 0) kmh = Math.min(kmh, 15);
  const [s0, s1] = laneTrim(g, e);
  const map = (s: number) => (dir > 0 ? s - s0 : s1 - s);
  const tunnels: [number, number][] = [];
  for (const sec of e.sections) if (sec.type === 'tunnel') {
    const a = map(sec.s0), b = map(sec.s1);
    tunnels.push([Math.min(a, b), Math.max(a, b)]);
  }
  const crossings: { id: number; pos: number }[] = [];
  for (const c of net.crossings.values()) if (c.kind === 'level' && c.e2 === e.id) crossings.push({ id: c.id, pos: map(c.s2) });
  return {
    kind: 'lane', e: e.id, dir, node: -1, from: -1, fromDir: 0, curve, len: curve.len, limit: Math.max(8, kmh) * KMH_TO_UPS,
    tunnels, crossings, depot: e.depot >= 0,
  };
}

function endPoint(c: Curve3, out: Vec3Like, dir: Vec3Like, atEnd: boolean) {
  const p = c.pts, n = c.cum.length;
  const i = atEnd ? n - 1 : 0, j = atEnd ? n - 2 : 1;
  out.x = p[i * 3]; out.y = p[i * 3 + 1]; out.z = p[i * 3 + 2];
  let dx = p[i * 3] - p[j * 3], dz = p[i * 3 + 2] - p[j * 3 + 2];
  if (!atEnd) { dx = -dx; dz = -dz; }
  const l = Math.hypot(dx, dz) || 1;
  dir.x = dx / l; dir.y = 0; dir.z = dz / l;
}

/** Connector curve through a junction from the end of lane a to the start of lane b (null if contiguous). */
export function makeConn(a: RSeg, b: RSeg, node: number): RSeg | null {
  const p0 = { x: 0, y: 0, z: 0 }, d0 = { x: 0, y: 0, z: 0 }, p3 = { x: 0, y: 0, z: 0 }, d3 = { x: 0, y: 0, z: 0 };
  endPoint(a.curve, p0, d0, true);
  endPoint(b.curve, p3, d3, false);
  const dist = Math.hypot(p3.x - p0.x, p3.z - p0.z);
  if (dist < 0.03) return null;
  const dot = d0.x * d3.x + d0.z * d3.z;
  const k = dot < -0.5 ? Math.max(0.36, dist * 0.9) : dist * 0.42;
  const c1x = p0.x + d0.x * k, c1z = p0.z + d0.z * k, c2x = p3.x - d3.x * k, c2z = p3.z - d3.z * k;
  const pts: number[] = [];
  const N = 12;
  for (let i = 0; i <= N; i++) {
    const t = i / N, u = 1 - t;
    const x = u * u * u * p0.x + 3 * u * u * t * c1x + 3 * u * t * t * c2x + t * t * t * p3.x;
    const z = u * u * u * p0.z + 3 * u * u * t * c1z + 3 * u * t * t * c2z + t * t * t * p3.z;
    pts.push(x, p0.y + (p3.y - p0.y) * t, z);
  }
  const curve = makeCurve(pts);
  const straight = dot > 0.97;
  const kmh = straight ? Math.min(a.limit, b.limit) / KMH_TO_UPS : Math.max(10, Math.min(35, curveSpeed(curve.minRadius)));
  return {
    kind: 'conn', e: b.e, dir: b.dir, node, from: a.e, fromDir: a.dir, curve, len: curve.len, limit: kmh * KMH_TO_UPS,
    tunnels: [], crossings: [],
  };
}

export interface RCont { edge: number; dir: number }

/** Road continuations at the end of (e, dir); U-turns get a penalty (cheap at dead ends). */
export function roadNext(g: Game, e: NEdge, dir: number): { edge: NEdge; dir: number; uturn: boolean }[] {
  const net = g.world.net;
  const nodeId = dir > 0 ? e.b : e.a;
  const node = net.nodes.get(nodeId);
  if (!node) return [];
  const out: { edge: NEdge; dir: number; uturn: boolean }[] = [];
  for (const fid of node.edges) {
    if (fid === e.id) continue;
    const f = net.edges.get(fid);
    if (!f || f.depot >= 0) continue;
    out.push({ edge: f, dir: f.a === nodeId ? 1 : -1, uturn: false });
  }
  if (e.depot < 0) out.push({ edge: e, dir: -dir, uturn: true });
  return out;
}

/** A* from the end of lane (edge, dir) to an edge carrying a stop of the target station. */
export function findRoadRoute(g: Game, edge: NEdge, dir: number, target: number, maxExpand = 40000): RCont[] | null {
  const net = g.world.net;
  const st = g.stations.get(target);
  if (!st || !st.stops.length) return null;
  const goals = new Set(st.stops.map((p) => p.edge));
  const tx = st.x, tz = st.z;
  const NE: number[] = [], ND: number[] = [], NG: number[] = [], NP: number[] = [];
  const best = new Map<number, number>();
  const heap = new Heap();
  const key = (e: number, d: number) => e * 2 + (d > 0 ? 1 : 0);
  const heur = (e: NEdge, d: number) => {
    const n = net.nodes.get(d > 0 ? e.b : e.a)!;
    return Math.hypot(n.x - tx, n.z - tz) * 0.98;
  };
  const cost = (e: NEdge) => e.len * (90 / (ROAD_TYPES[e.type] ?? ROAD_TYPES.road).speed) + 0.6;
  const push = (e: NEdge, d: number, gc: number, parent: number) => {
    const k = key(e.id, d);
    if ((best.get(k) ?? Infinity) <= gc) return;
    best.set(k, gc);
    NE.push(e.id); ND.push(d); NG.push(gc); NP.push(parent);
    heap.push(NE.length - 1, gc + heur(e, d));
  };
  const nodeDeg = (e: NEdge, d: number) => net.nodes.get(d > 0 ? e.b : e.a)?.edges.length ?? 0;
  for (const c of roadNext(g, edge, dir)) {
    push(c.edge, c.dir, cost(c.edge) + (c.uturn ? (nodeDeg(edge, dir) <= 1 ? 2 : 40) : 0), -1);
  }
  let n = 0;
  while (heap.size) {
    const i = heap.pop();
    const e = net.edges.get(NE[i])!;
    const d = ND[i];
    if ((best.get(key(e.id, d)) ?? Infinity) < NG[i]) continue;
    if (goals.has(e.id)) {
      const out: RCont[] = [];
      for (let j = i; j >= 0; j = NP[j]) out.push({ edge: NE[j], dir: ND[j] });
      return out.reverse();
    }
    if (++n > maxExpand) break;
    for (const c of roadNext(g, e, d)) {
      push(c.edge, c.dir, NG[i] + cost(c.edge) + (c.uturn ? (nodeDeg(e, d) <= 1 ? 2 : 40) : 0), i);
    }
  }
  return null;
}

/** Position of a station's stop along a lane segment (or -1). */
function stopPosOnLane(g: Game, seg: RSeg, stationId: number): number {
  const st = g.stations.get(stationId);
  if (!st || seg.kind !== 'lane') return -1;
  let best = -1;
  for (const p of st.stops) {
    if (p.edge !== seg.e) continue;
    const c = seg.curve;
    const r = closestOnPolyline(p.x, p.z, c.pts, 3, c.cum.length);
    const pos = c.cum[r.i] + (c.cum[Math.min(c.cum.length - 1, r.i + 1)] - c.cum[r.i]) * r.f;
    if (best < 0 || pos < best) best = pos;
  }
  return best;
}

export class RoadVehicle extends Vehicle {
  readonly kind = 'road' as const;
  model: VehicleModel | null;
  ambient: boolean;
  seg: RSeg | null = null;
  pos = 0;
  trail: RSeg[] = [];
  ahead: RSeg[] = [];
  route: RCont[] = [];
  speed = 0;
  depotId: number;
  loadTimer = 0;
  retryTimer = 0;
  junctionWait = 0;
  stuck = 0;
  ttl = 0;
  rng: RNG;
  /** ambient: car style index and colour */
  style = 0;
  tint = 0;
  cruise: number;
  grade = 0;

  constructor(game: Game, id: number, model: VehicleModel | null, depotId: number, ambient = false, seed = 1) {
    super(game, id);
    this.model = model;
    this.ambient = ambient;
    this.depotId = depotId;
    this.rng = new RNG(seed);
    this.value = model ? model.cost : 0;
    this.style = this.rng.int(4);
    this.tint = this.rng.int(1 << 24);
    this.cruise = (model ? model.speed : 45 + this.rng.next() * 30) * KMH_TO_UPS;
    this.ttl = 40 + this.rng.next() * 120;
    const dp = depotId >= 0 ? game.depots.get(depotId) : undefined;
    if (dp) { this.homeX = dp.x; this.homeZ = dp.z; this.owner = dp.owner; }
    if (ambient) { this.state = 'running'; this.status = ''; this.owner = -1; }
  }

  get length() { return this.model ? this.model.length : this.style === 3 ? 0.7 : 0.45; }
  get capacity() { return this.model?.capacity ?? 0; }
  get maxSpeedKmh() { return this.model?.speed ?? 60; }
  get maxSpeed() { return this.cruise; }
  get speedKmh() { return this.speed / KMH_TO_UPS; }
  get runningCost() { return this.model?.running ?? 0; }
  get onMap() { return !!this.seg; }

  placeAt(seg: RSeg, pos: number) {
    this.seg = seg;
    this.pos = pos;
    this.trail = [];
    this.ahead = [];
    this.route = [];
  }

  // ---------------------------------------------------------------- geometry
  pointBehind(d: number, out: Vec3Like, dir?: Vec3Like): RSeg | null {
    if (!this.seg) return null;
    let s = this.seg, p = this.pos;
    let k = 0;
    while (d > p && k < this.trail.length) { d -= p; s = this.trail[k++]; p = s.len; }
    curvePoint(s.curve, Math.max(0, p - d), out, dir);
    return s;
  }

  worldPos(out: Vec3Like): boolean {
    if (!this.seg) { out.x = this.homeX; out.y = 0; out.z = this.homeZ; return false; }
    this.pointBehind(this.length / 2, out);
    return true;
  }

  hiddenAt(seg: RSeg, pos: number): boolean {
    if (seg.depot && seg.dir > 0 && pos < 0.9) return true;
    if (seg.depot && seg.dir < 0 && pos > seg.len - 0.9) return true;
    for (const [a, b] of seg.tunnels) if (pos > a + 0.5 && pos < b - 0.5) return true;
    return false;
  }

  /** Edges physically used by this vehicle (blocks construction). */
  occupiedEdges(): number[] {
    const out: number[] = [];
    const add = (s: RSeg | null | undefined) => {
      if (!s) return;
      out.push(s.e);
      if (s.kind === 'conn') out.push(s.from);
    };
    add(this.seg);
    if (this.pos < this.length) add(this.trail[0]);
    if (this.seg?.kind === 'conn') add(this.ahead[0]);
    return out;
  }

  // ---------------------------------------------------------------- planning
  private lastLane(): RSeg | null {
    for (let i = this.ahead.length - 1; i >= 0; i--) if (this.ahead[i].kind === 'lane') return this.ahead[i];
    return this.seg && this.seg.kind === 'lane' ? this.seg : null;
  }

  /** Append the next edge (lane + connector) to the look-ahead. */
  private appendCont(c: RCont): boolean {
    const g = this.game;
    const net = g.world.net;
    const last = this.lastLane();
    const e = net.edges.get(c.edge);
    if (!last || !e) return false;
    const le = net.edges.get(last.e);
    if (!le) return false;
    const node = last.dir > 0 ? le.b : le.a;
    const lane = makeLaneSeg(g, e, c.dir);
    const conn = makeConn(last, lane, node);
    if (conn) this.ahead.push(conn);
    this.ahead.push(lane);
    if (!this.ambient && this.route.length === 0) {
      const target = this.targetStation();
      if (target) { const p = stopPosOnLane(g, lane, target.id); if (p >= 0) lane.stopAt = p; }
    }
    return true;
  }

  private fill() {
    const g = this.game;
    const net = g.world.net;
    let guard = 0;
    while (this.ahead.length < 5 && guard++ < 6) {
      if (this.route.length) {
        if (!this.appendCont(this.route.shift()!)) { this.route = []; break; }
        continue;
      }
      if (!this.ambient) break;
      const last = this.lastLane();
      if (!last || last.stopAt !== undefined) break;
      const le = net.edges.get(last.e);
      if (!le) break;
      const opts = roadNext(g, le, last.dir);
      const fwd = opts.filter((o) => !o.uturn && o.edge.station < 0);
      const pick = fwd.length ? fwd[this.rng.int(fwd.length)] : opts.find((o) => o.uturn);
      if (!pick) break;
      if (!this.appendCont({ edge: pick.edge.id, dir: pick.dir })) break;
    }
  }

  private planRoute(): boolean {
    const g = this.game;
    const net = g.world.net;
    const target = this.targetStation();
    if (!target) { this.state = 'stopped'; this.status = 'No line assigned'; return false; }
    if (!target.stops.length) { this.state = 'noroute'; this.status = target.name + ' has no bus stop'; return false; }
    if (!this.seg) return false;
    // keep the current segment and, if inside a junction, the lane it leads to
    let base: RSeg;
    if (this.seg.kind === 'lane') { base = this.seg; this.ahead = []; }
    else if (this.ahead[0]?.kind === 'lane') { base = this.ahead[0]; this.ahead = [base]; }
    else { this.ahead = []; this.route = []; this.state = 'noroute'; this.status = 'Lost'; return false; }
    for (const s of [this.seg, ...this.ahead]) s.stopAt = undefined;
    this.route = [];
    const sp = stopPosOnLane(g, base, target.id);
    const cur = base === this.seg ? this.pos : -1;
    if (sp >= 0 && sp > cur + 0.15) {
      base.stopAt = sp;
      this.state = 'running';
      this.status = 'Heading to ' + target.name;
      return true;
    }
    const be = net.edges.get(base.e);
    const r = be ? findRoadRoute(g, be, base.dir, target.id) : null;
    if (!r) {
      this.state = 'noroute';
      this.status = 'No route to ' + target.name;
      return false;
    }
    this.route = r;
    this.state = 'running';
    this.status = 'Heading to ' + target.name;
    this.fill();
    return true;
  }

  onLineChanged() {
    this.fixCargo();
    if (!this.seg) { this.state = 'depot'; this.retryTimer = 0; return; }
    if (this.state === 'loading') return;
    this.planRoute();
  }

  /** Network changed: drop stale look-ahead; returns false if the vehicle lost its road. */
  onNetworkChanged(): boolean {
    const net = this.game.world.net;
    if (!this.seg) return true;
    const valid = (s: RSeg) => net.edges.has(s.e) && (s.kind === 'lane' || net.edges.has(s.from));
    if (!valid(this.seg)) return false;
    if (this.seg.kind === 'conn') {
      const nxt = this.ahead[0];
      if (!nxt || !valid(nxt)) return false;
      this.ahead = [nxt];
    } else this.ahead = [];
    this.trail = this.trail.filter(valid).slice(0, 2);
    this.route = [];
    if (this.ambient) this.fill();
    return true;
  }

  returnToDepot(reason: string) {
    this.seg = null;
    this.trail = [];
    this.ahead = [];
    this.route = [];
    this.speed = 0;
    this.state = 'depot';
    this.status = reason;
  }

  private tryLeaveDepot() {
    const g = this.game;
    const dp: Depot | undefined = g.depots.get(this.depotId);
    if (!dp) { this.status = 'Depot missing'; return; }
    if (!this.line || this.line.stops.length < 1) { this.status = 'In depot (no line)'; return; }
    const stub = g.world.net.edges.get(dp.edge);
    if (!stub) return;
    if (g.vehicles.roadBusyNear(stub.id, stub.bez.x0, stub.bez.z0, this.length + 0.4)) { this.status = 'Waiting to leave depot'; return; }
    this.placeAt(makeLaneSeg(g, stub, 1), 0);
    this.speed = 0;
    if (!this.planRoute()) { this.seg = null; this.state = 'noroute'; }
  }

  depart() {
    this.advanceStop();
    this.planRoute();
  }

  private arrive() {
    const g = this.game;
    const st = this.targetStation();
    if (!st) { this.state = 'stopped'; return; }
    if (this.seg) this.seg.stopAt = undefined;
    this.state = 'loading';
    this.loadTimer = this.serveStation(st, 0.05);
    this.status = 'Loading at ' + st.name;
    void g;
  }

  // ---------------------------------------------------------------- update
  update(dt: number) {
    this.stateTime += dt;
    if (this.ambient) { this.ttl -= dt; this.drive(dt); return; }
    switch (this.state) {
      case 'depot':
      case 'noroute':
        this.retryTimer -= dt;
        if (this.retryTimer <= 0) {
          this.retryTimer = 2;
          if (!this.seg) this.tryLeaveDepot();
          else this.planRoute();
        }
        if (this.seg) this.drive(dt);
        return;
      case 'stopped':
        if (this.seg) this.drive(dt);
        return;
      case 'loading':
        this.loadTimer -= dt;
        if (this.loadTimer <= 0) this.depart();
        return;
    }
    this.drive(dt);
  }

  private tmpA = { x: 0, y: 0, z: 0 };
  private tmpB = { x: 0, y: 0, z: 0 };

  private drive(dt: number) {
    if (!this.seg) return;
    const g = this.game;
    const V = g.vehicles;
    if (this.ahead.length < 3) this.fill();
    const seg = this.seg;
    const v = this.speed;
    const look = (v * v) / (2 * BRAKE) + 1.5;
    let vt = Math.min(this.cruise, seg.limit);
    const brakeTo = (dist: number) => Math.sqrt(2 * BRAKE * Math.max(0, dist));
    // walk the known path
    let d = -this.pos;
    const segs = [seg, ...this.ahead];
    let endKnown = true;
    for (let i = 0; i < segs.length; i++) {
      const s = segs[i];
      if (i > 0 && s.limit < vt) vt = Math.min(vt, Math.sqrt(s.limit * s.limit + 2 * BRAKE * Math.max(0, d)));
      if (s.stopAt !== undefined && !this.ambient) {
        const dist = d + s.stopAt;
        if (dist >= -0.05) vt = Math.min(vt, brakeTo(dist) + 0.01);
        if (i === 0 && dist <= 0.03 && this.speed < 0.08) { this.pos = Math.max(this.pos, s.stopAt); this.speed = 0; this.arrive(); return; }
      }
      for (const c of s.crossings) {
        const dist = d + c.pos;
        if (dist < 0.45 || dist > look + 1) continue;
        if (V.crossingClosed.has(c.id)) vt = Math.min(vt, brakeTo(dist - 0.6));
      }
      // junction admission before entering a connector at a real junction
      if (s.kind === 'conn' && i > 0) {
        const dist = d;
        if (dist < look + 0.3) {
          const node = g.world.net.nodes.get(s.node);
          if (node && node.edges.length >= 3 && !V.junctionFree(this, s)) {
            if (dist < 0.6) this.junctionWait += dt;
            if (this.junctionWait < 5) vt = Math.min(vt, brakeTo(dist - 0.05));
          } else if (i === 1) this.junctionWait = 0;
        }
      }
      d += s.len;
      if (d > look + 2) { endKnown = false; break; }
    }
    if (endKnown) vt = Math.min(vt, brakeTo(d - 0.02));
    // car following
    const gap = V.gapAhead(this, look + 1);
    if (gap < Infinity) vt = Math.min(vt, gap < 0.18 ? 0 : brakeTo(gap - 0.18));
    // physics
    const A = this.tmpA, B = this.tmpB;
    this.pointBehind(0, A);
    this.pointBehind(this.length, B);
    this.grade = this.length > 0.1 ? (A.y - B.y) / this.length : 0;
    const P = this.model ? this.model.power : 80, M = this.model ? this.model.weight + this.load * 0.075 : 1.4;
    const tract = Math.min(1.6, P / (M * Math.max(3, v * 10)));
    const acc = (tract - 0.02) / 10 - G * this.grade;
    if (v < vt) this.speed = Math.min(vt, v + Math.max(acc, 0.01) * dt);
    else this.speed = Math.max(vt, v - BRAKE * 1.6 * dt);
    if (this.speed < 0) this.speed = 0;
    this.pos += this.speed * dt;
    // advance through segments
    while (this.seg && this.pos > this.seg.len) {
      if (!this.ahead.length) {
        this.fill();
        if (!this.ahead.length) {
          this.pos = this.seg.len;
          this.speed = 0;
          if (this.ambient) this.state = 'stopped';
          break;
        }
      }
      if (this.ambient && this.ttl < 0 && this.seg.kind === 'lane') { this.state = 'stopped'; return; }
      this.pos -= this.seg.len;
      this.trail.unshift(this.seg);
      if (this.trail.length > 3) this.trail.length = 3;
      this.seg = this.ahead.shift()!;
      if (this.ahead.length < 3) this.fill();
    }
    if (this.speed < 0.01) this.stuck += dt; else this.stuck = 0;
  }

  destroy() { this.seg = null; }
}

/** Can a bus leaving this depot reach the station? */
export function roadDepotReaches(g: Game, dp: Depot, stationId: number): boolean {
  const stub = g.world.net.edges.get(dp.edge);
  if (!stub) return false;
  return !!findRoadRoute(g, stub, 1, stationId, 60000);
}

/** Do two connector curves cross (2D)? */
export function connsConflict(a: RSeg, b: RSeg): boolean {
  if (a.e === b.e && a.dir === b.dir) return true;
  const pa = a.curve.pts, pb = b.curve.pts;
  const na = a.curve.cum.length, nb = b.curve.cum.length;
  for (let i = 0; i < na - 1; i += 2) {
    const i2 = Math.min(na - 1, i + 2);
    for (let j = 0; j < nb - 1; j += 2) {
      const j2 = Math.min(nb - 1, j + 2);
      if (segIntersect(pa[i * 3], pa[i * 3 + 2], pa[i2 * 3], pa[i2 * 3 + 2], pb[j * 3], pb[j * 3 + 2], pb[j2 * 3], pb[j2 * 3 + 2])) return true;
    }
  }
  return false;
}
