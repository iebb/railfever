// Road vehicles: buses on lines and ambient town traffic, driving on lane curves of the road graph.
import { Vehicle } from './vehicle';
import { holdForSpacing, noteSpacingDeparture } from './patterns';
import type { Game } from './game';
import { Depot, tramUsable } from './build-ops';
import { Curve3, curvePoint, makeCurve, NEdge } from './network';
import { KMH_TO_UPS, ROAD_TYPES, MAIL_UNIT_T } from './constants';
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
  /** local curve speed limits along a lane: [pos0, pos1, speed] (units/s) */
  slow?: [number, number, number][];
}

/** Local curve speed limits along a lane curve (windowed radius), below `base` (units/s). */
function slowZones(c: Curve3, base: number): [number, number, number][] {
  const out: [number, number, number][] = [];
  const p = c.pts, cum = c.cum, n = cum.length;
  let j = 0, k = 0;
  for (let i = 1; i < n - 1; i++) {
    while (j < i - 1 && cum[i] - cum[j + 1] >= 0.4) j++;
    if (k < i + 1) k = i + 1;
    while (k < n - 1 && cum[k] - cum[i] < 0.4) k++;
    const ax = p[i * 3] - p[j * 3], az = p[i * 3 + 2] - p[j * 3 + 2], bx = p[k * 3] - p[i * 3], bz = p[k * 3 + 2] - p[i * 3 + 2];
    const la = Math.hypot(ax, az), lb = Math.hypot(bx, bz);
    if (la < 1e-6 || lb < 1e-6) continue;
    const ang = Math.abs(Math.atan2(ax * bz - az * bx, ax * bx + az * bz));
    if (ang < 1e-4) continue;
    const v = Math.max(8, curveSpeed((la + lb) / 2 / ang)) * KMH_TO_UPS;
    if (v >= base) continue;
    const a = cum[i] - 0.3, b = cum[i] + 0.3;
    const last = out[out.length - 1];
    if (last && a <= last[1]) { last[1] = b; last[2] = Math.min(last[2], v); } else out.push([a, b, v]);
  }
  return out;
}

const BRAKE = 0.3;
const G = 0.981;
/** Pure runtime acceleration (units/s²); forecast callers convert SI speed to units/s. */
export function roadAcceleration(power: number, mass: number, speed: number, grade: number): number {
  const tract = Math.min(1.6, power / (mass * Math.max(3, speed * 10)));
  return (tract - 0.02) / 10 - G * grade;
}
const brakeTo = (dist: number) => Math.sqrt(2 * BRAKE * Math.max(0, dist));

export function laneTrim(g: Game, e: NEdge): [number, number] {
  const net = g.world.net;
  const ra = net.junctionRadius(e.a), rb = net.junctionRadius(e.b);
  return [Math.min(ra, e.len * 0.45), Math.max(e.len - rb, e.len * 0.55)];
}

export function makeLaneSeg(g: Game, e: NEdge, dir: number): RSeg {
  const net = g.world.net;
  const curve = net.lane(e, dir);
  const rt = ROAD_TYPES[e.type] ?? ROAD_TYPES.road;
  // the lane's base limit is the road speed; tight bends only slow vehicles locally (slow zones)
  let kmh = rt.speed;
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
    tunnels, crossings, depot: e.depot >= 0, slow: slowZones(curve, Math.max(8, kmh) * KMH_TO_UPS),
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

/**
 * A* from the end of lane (edge, dir) to an edge carrying a stop of the target station. `allow` restricts
 * the edges (trams: tram tracks the owner may use); where nothing allowed continues, turning is cheap.
 */
export function findRoadRoute(g: Game, edge: NEdge, dir: number, target: number, maxExpand = 40000, allow?: (e: NEdge) => boolean, uturn = 40, profile?: { edge: number; dir: number }): RCont[] | null {
  const net = g.world.net;
  const st = g.stations.get(target);
  if (!st || !st.stops.length) return null;
  const goals = new Set(st.stops.filter((p) => { const e = net.edges.get(p.edge); return !!e && (!allow || allow(e)); }).map((p) => p.edge));
  if (!goals.size) return null;
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
  /**
   * Push the continuations of lane (e, d) in roadNext's order (no allocations): the (allowed) edges at its end
   * node, then the U-turn, which is cheap at a dead end (of the allowed network).
   */
  const expand = (e: NEdge, d: number, gc: number, parent: number) => {
    const nodeId = d > 0 ? e.b : e.a;
    const node = net.nodes.get(nodeId);
    if (!node) return;
    let open = false;
    if (allow) for (const fid of node.edges) {
      if (fid === e.id) continue;
      const f = net.edges.get(fid);
      if (f && f.depot < 0 && allow(f)) { open = true; break; }
    }
    for (const fid of node.edges) {
      if (fid === e.id) continue;
      const f = net.edges.get(fid);
      if (!f || f.depot >= 0 || (allow && !allow(f))) continue;
      push(f, f.a === nodeId ? 1 : -1, gc + cost(f), parent);
    }
    if (e.depot < 0) push(e, -d, gc + cost(e) + (allow ? (open ? uturn : 2) : node.edges.length <= 1 ? 2 : uturn), parent);
  };
  expand(edge, dir, 0, -1);
  let n = 0;
  while (heap.size) {
    const i = heap.pop();
    const e = net.edges.get(NE[i])!;
    const d = ND[i];
    if ((best.get(key(e.id, d)) ?? Infinity) < NG[i]) continue;
    if (goals.has(e.id) && (!profile || (e.id === profile.edge && d === profile.dir))) {
      const out: RCont[] = [];
      for (let j = i; j >= 0; j = NP[j]) out.push({ edge: NE[j], dir: ND[j] });
      return out.reverse();
    }
    if (profile && goals.has(e.id)) continue;
    if (++n > maxExpand) break;
    expand(e, d, NG[i], i);
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
  /** seconds between route searches while there is no route (doubles up to 32 s: no repeated full searches) */
  retryWait = 2;
  junctionWait = 0;
  stuck = 0;
  ttl = 0;
  rng: RNG;
  /** ambient: car style index and colour */
  style = 0;
  tint = 0;
  cruise: number;
  grade = 0;
  /** the look-ahead was dropped by a network change: re-plan before driving on */
  needsReplan = false;

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
  /** trams run only on tram tracks their owner may use */
  get isTram() { return this.model?.kind === 'tram'; }
  /** edge filter for route planning (null: any road) */
  routeFilter(): ((e: NEdge) => boolean) | undefined {
    if (!this.isTram) return undefined;
    const g = this.game, owner = this.owner;
    return (e: NEdge) => tramUsable(g, e, owner);
  }
  get capacity() { return this.model?.capacity ?? 0; }
  get mailCapacity() { return this.model?.mail ?? 0; }
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
      // town traffic mostly stays on the streets; now and then a car heads out along a country road
      const streets = fwd.filter((o) => o.edge.type === 'street');
      const from = streets.length && streets.length < fwd.length && this.rng.next() < 0.85 ? streets : fwd;
      const pick = from.length ? from[this.rng.int(from.length)] : opts.find((o) => o.uturn);
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
    // a loop line circulates: U-turns only at dead ends
    const line = this.line;
    const r = be ? findRoadRoute(g, be, base.dir, target.id, 40000, this.routeFilter(), line && g.lines.isLoop(line) ? 600 : 40) : null;
    if (!r) {
      this.state = 'noroute';
      this.status = (this.isTram && !target.stops.some((p) => { const e = net.edges.get(p.edge); return e && tramUsable(g, e, this.owner); }) ? target.name + ' has no tram stop' : 'No route to ' + target.name);
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
    this.retryWait = 2;
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
    // keep the plan if none of its lanes touch the changed part of the network
    const dn = net.dirtyNodes, de = net.dirtyEdges;
    const clean = (s: RSeg) => {
      if (!valid(s)) return false;
      const e = net.edges.get(s.e)!;
      if (de.has(e.id) || dn.has(e.a) || dn.has(e.b)) return false;
      if (s.kind === 'conn') { const f = net.edges.get(s.from)!; if (de.has(f.id) || dn.has(f.a) || dn.has(f.b)) return false; }
      return true;
    };
    let intact = clean(this.seg);
    for (let i = 0; intact && i < this.ahead.length; i++) intact = clean(this.ahead[i]);
    for (let i = 0; intact && i < this.route.length; i++) intact = net.edges.has(this.route[i].edge);
    if (intact) return true;
    this.needsReplan = !this.ambient;
    if (this.seg.kind === 'conn') {
      const nxt = this.ahead[0];
      if (!nxt || !valid(nxt)) return false;
      this.ahead = [nxt];
    } else this.ahead = [];
    this.trail = this.trail.filter(valid);
    this.trimTrail();
    this.route = [];
    if (this.ambient) this.fill();
    return true;
  }

  /** Keep the path behind as long as the body needs (+0.5), at least two segments: long articulated
   * trams place every section along it with pointBehind. */
  private trimTrail() {
    let keep = 0, behind = this.pos;
    while (keep < this.trail.length && (keep < 2 || behind < this.length + 0.5)) behind += this.trail[keep++].len;
    if (this.trail.length > keep) this.trail.length = keep;
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
    if (g.vehicles.waitForSpacingRelease(this)) return;
    const stub = g.world.net.edges.get(dp.edge);
    if (!stub) return;
    if (g.vehicles.roadBusyNear(stub.id, stub.bez.x0, stub.bez.z0, this.length + 0.4)) { this.status = 'Waiting to leave depot'; return; }
    this.placeAt(makeLaneSeg(g, stub, 1), 0);
    g.vehicles.noteOnRoad(this);
    this.speed = 0;
    if (!this.planRoute()) { this.seg = null; this.state = 'noroute'; }
    else g.vehicles.noteSpacingRelease(this);
  }

  depart() {
    this.queueSpacingDeparture();
    this.advanceStop();
    this.planRoute();
  }

  private arrive() {
    const g = this.game;
    const st = this.targetStation();
    if (!st) { this.state = 'stopped'; return; }
    if (this.seg) this.seg.stopAt = undefined;
    this.state = 'loading';
    this.resetSpacing();
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
          else {
            this.retryWait = this.planRoute() ? 2 : Math.min(32, this.retryWait * 2);
            this.retryTimer = this.retryWait;
          }
        }
        if (this.seg) this.drive(dt);
        return;
      case 'stopped':
        if (this.seg) this.drive(dt);
        return;
      case 'loading':
        this.loadTimer -= dt;
        if (this.loadTimer <= 0) {
          if (holdForSpacing(this.game, this)) this.continueBoarding(dt);
          else this.depart();
        }
        return;
    }
    this.drive(dt);
  }

  private tmpA = { x: 0, y: 0, z: 0 };
  private tmpB = { x: 0, y: 0, z: 0 };
  /** time to the next gradient sample (saved, so a loaded game drives exactly alike) */
  gradeTimer = 0;

  private drive(dt: number) {
    if (!this.seg) return;
    const g = this.game;
    const V = g.vehicles;
    if (this.ahead.length < 3) this.fill();
    const seg = this.seg;
    const v = this.speed;
    const look = (v * v) / (2 * BRAKE) + 1.5;
    let vt = Math.min(this.cruise, seg.limit);
    // walk the known path (current segment, then the look-ahead)
    let d = -this.pos;
    const ahead = this.ahead;
    let endKnown = true;
    for (let i = 0; i <= ahead.length; i++) {
      const s = i === 0 ? seg : ahead[i - 1];
      if (i > 0 && s.limit < vt) vt = Math.min(vt, Math.sqrt(s.limit * s.limit + 2 * BRAKE * Math.max(0, d)));
      if (s.slow) for (const z of s.slow) {
        if (d + z[1] < 0) continue;
        vt = Math.min(vt, d + z[0] <= 0 ? z[2] : Math.sqrt(z[2] * z[2] + 2 * BRAKE * (d + z[0])));
      }
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
    // physics (the gradient is sampled a few times per second)
    this.gradeTimer -= dt;
    if (this.gradeTimer <= 0) {
      this.gradeTimer = 0.25;
      const A = this.tmpA, B = this.tmpB;
      this.pointBehind(0, A);
      this.pointBehind(this.length, B);
      this.grade = this.length > 0.1 ? (A.y - B.y) / this.length : 0;
    }
    const P = this.model ? this.model.power : 80, M = this.model ? this.model.weight + this.load * 0.075 + (this.mailLoad ? this.mailLoad * MAIL_UNIT_T : 0) : 1.4;
    const acc = roadAcceleration(P, M, v, this.grade);
    if (v < vt) this.speed = Math.min(vt, v + Math.max(acc, 0.01) * dt);
    else this.speed = Math.max(vt, v - BRAKE * 1.6 * dt);
    if (this.speed < 0) this.speed = 0;
    this.pos += this.speed * dt;
    if (this.speed > 0 && this.spacing.departureIndex >= 0) noteSpacingDeparture(g, this);
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
      this.trimTrail();
      this.seg = this.ahead.shift()!;
      if (this.ahead.length < 3) this.fill();
    }
    if (this.speed < 0.01) this.stuck += dt; else this.stuck = 0;
  }

  destroy() { this.seg = null; }
}

/** Can a bus (tram, from a tram depot) leaving this depot reach the station? */
export function roadDepotReaches(g: Game, dp: Depot, stationId: number): boolean {
  const stub = g.world.net.edges.get(dp.edge);
  if (!stub) return false;
  return !!findRoadRoute(g, stub, 1, stationId, 60000, dp.kind === 'tram' ? (e) => tramUsable(g, e, dp.owner) : undefined);
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
