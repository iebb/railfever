// Trains on the free-form rail network: routing, path reservation, physics and movement.
import { Vehicle } from './vehicle';
import type { Game } from './game';
import type { Depot } from './build-ops';
import { Curve3, curvePoint, makeCurve, NEdge, NNode } from './network';
import { KMH_TO_UPS, TRACK_TYPES } from './constants';
import { curveSpeed } from './construction';
import { HEAVY_RAIL_TRACKS, aeroOf, auxKwOf } from './vehicle-types';
import type { VehicleModel } from './vehicle-types';
import type { Vec3Like } from './geom';
import { PLATFORM_PASS_KMH, holdForOvertake } from './patterns';
import { trackPassage } from './opcosts';

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

// ---------------------------------------------------------------- physics (UPDATE 9j)
/**
 * Service braking (units/s^2; 1 unit/s^2 = 10 m/s^2): 0.7 m/s^2 up to 160 km/h, easing to 0.5 m/s^2 from 300 km/h
 * (high-speed trains brake gentler at speed: adhesion, brake heat).
 */
export const TRAIN_BRAKE = 0.07, TRAIN_BRAKE_HS = 0.05;
const BV1 = 160 * KMH_TO_UPS, BV2 = 300 * KMH_TO_UPS, BK = (TRAIN_BRAKE - TRAIN_BRAKE_HS) / (BV2 - BV1), BC = TRAIN_BRAKE + BK * BV1;
const BD1 = (BV1 * BV1) / (2 * TRAIN_BRAKE), BD2 = (BC * Math.log(TRAIN_BRAKE / TRAIN_BRAKE_HS) - (TRAIN_BRAKE - TRAIN_BRAKE_HS)) / (BK * BK);
/** Service braking rate (units/s^2) at speed v (units/s). */
export function brakeRate(v: number): number { return v <= BV1 ? TRAIN_BRAKE : v >= BV2 ? TRAIN_BRAKE_HS : BC - BK * v; }
/** Distance (units) a train needs to stop from v (units/s) braking at brakeRate (400 km/h: ~11 km). */
export function brakeDistance(v: number): number {
  if (v <= BV1) return (v * v) / (2 * TRAIN_BRAKE);
  if (v <= BV2) return BD1 + (BC * Math.log(TRAIN_BRAKE / (BC - BK * v)) - (TRAIN_BRAKE - (BC - BK * v))) / (BK * BK);
  return BD1 + BD2 + (v * v - BV2 * BV2) / (2 * TRAIN_BRAKE_HS);
}
/** Highest speed (units/s) from which a train stops within d units (the inverse of brakeDistance). */
export function brakeSpeed(d: number): number {
  if (d <= 0) return 0;
  if (d <= BD1) return Math.sqrt(2 * TRAIN_BRAKE * d);
  if (d >= BD1 + BD2) return Math.sqrt(BV2 * BV2 + 2 * TRAIN_BRAKE_HS * (d - BD1 - BD2));
  let lo = BV1, hi = BV2;
  for (let i = 0; i < 24; i++) { const m = (lo + hi) / 2; if (brakeDistance(m) < d) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
/** Davis running resistance per kg: a0 (N/kg, bearings and rolling) + a1 (N/kg per m/s, flange and track). */
export const DAVIS = { a0: 0.0075, a1: 0.0002 };
/** Power reaching the wheels; rotating masses add to the inertia. */
const TRANSMISSION = 0.92, ROTATING = 1.06;
/**
 * Starting acceleration (m/s^2) a consist is designed for (traction equipment, passenger comfort): metro and
 * light-rail sets 1.2, multiple units and loco-hauled trains 1.0 (adhesion permitting), high-speed sets 0.7.
 */
function accelCap(cars: VehicleModel[]): number {
  if (!cars.length || !cars.every((c) => c.kind === 'emu')) return 1.0;
  if (cars.some((c) => c.speed >= 200)) return 0.7;
  return cars.every((c) => c.speed <= 110) ? 1.2 : 1.0;
}

/**
 * Forces on a train at speed v (m/s) on level track (N): the most its traction can pull (power at the wheels,
 * adhesion by Curtius-Kniffler, the design acceleration) and the Davis running resistance m (a0 + a1 v) + c v^2
 * with its own aerodynamics.
 */
export function trainForces(t: Train, v: number): { traction: number; resistance: number } {
  const ph = t.phys, m = t.mass * 1000;
  const mu = 0.161 + 7.5 / (v * 3.6 + 44);
  const traction = Math.min(mu * 9.81 * ph.driven * 1000, (t.power * 1000 * TRANSMISSION) / Math.max(2, v), m * ROTATING * ph.accel);
  return { traction, resistance: m * (DAVIS.a0 + DAVIS.a1 * v) + ph.aero * v * v };
}
/** Share of a multiple unit's mass on driven axles. */
const EMU_DRIVEN = 0.6;
const GAP = 0.1;

export function makeSeg(g: Game, e: NEdge, dir: number): TSeg {
  const net = g.world.net;
  const geo = net.geo(e);
  const tt = TRACK_TYPES[e.type] ?? TRACK_TYPES.standard;
  let kmh = Math.min(tt.speed, curveSpeed(geo.minRadius, e.type));
  if (e.depot >= 0) kmh = Math.min(kmh, 25);
  // (ops) a platform track is passed at reduced speed; non-stopping trains prefer the through tracks
  if (e.station >= 0) kmh = Math.min(kmh, PLATFORM_PASS_KMH);
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

// ---------------------------------------------------------------- track compatibility
/**
 * What a consist may run on: the track types every one of its vehicles allows (null: any), and whether one of
 * them needs overhead wire (electric traction).
 */
export interface TrackRule { types: Set<string> | null; wire: boolean }

/** The track rule of a consist (VehicleModel.tracks; heavy rail by default; electric traction needs wire). */
export function consistRule(cars: VehicleModel[]): TrackRule {
  let types: Set<string> | null = null, wire = false;
  for (const m of cars) {
    const allowed: string[] | null = m.tracks ?? (m.kind === 'loco' || m.kind === 'wagon' ? HEAVY_RAIL_TRACKS : null);
    if (allowed) types = types ? new Set([...types].filter((t: string) => allowed.includes(t))) : new Set(allowed);
    if (m.traction === 'electric') wire = true;
  }
  return { types, wire };
}

/** May a consist with this rule run on the edge? (depot tracks: always) */
export function ruleAllows(rule: TrackRule | null | undefined, e: NEdge): boolean {
  if (!rule || e.depot >= 0) return true;
  if (rule.types && !rule.types.has(e.type)) return false;
  return !rule.wire || !!TRACK_TYPES[e.type]?.electrified;
}

/** May every vehicle of the consist run on the edge (track type, overhead wire)? */
export function trackAllows(cars: VehicleModel[], e: NEdge): boolean { return ruleAllows(consistRule(cars), e); }

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
export function railNext(g: Game, e: NEdge, dir: number, owner: number, anyOwner = false, rule: TrackRule | null = null, ignoreSignals = false): Cont[] {
  const net = g.world.net;
  const out: Cont[] = [];
  for (const c of net.nextRail(e, dir)) {
    if (c.edge.depot >= 0 || (!anyOwner && !g.canUse(owner, c.edge.owner))) continue;
    if (rule && !ruleAllows(rule, c.edge)) continue;
    if (!ignoreSignals && net.signalFor(c.node, net.sideAt(c.edge, c.node.id)) < 0) continue;
    out.push({ edge: c.edge, dir: c.dir });
  }
  return out;
}

function frontier(g: Game, seg: TSeg, owner: number, anyOwner = false, rule: TrackRule | null = null, ignoreSignals = false): Cont[] {
  const net = g.world.net;
  if (seg.e < 0) {
    const dp = g.depots.get(seg.depot!);
    const stub = dp ? net.edges.get(dp.edge) : undefined;
    return stub ? [{ edge: stub, dir: 1 }] : [];
  }
  const e = net.edges.get(seg.e);
  return e ? railNext(g, e, seg.dir, owner, anyOwner, rule, ignoreSignals) : [];
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
export function findRailRoute(g: Game, start: Cont[], target: number, owner: number, selfId: number, maxExpand = 60000, exit = false, rule: TrackRule | null = null): RouteResult | null {
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
    // (passing a station: its through tracks rather than a platform track another train may want to stop at)
    if (e.station >= 0 && e.station !== target) c += 25;
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
    for (const c of railNext(g, e, d, owner, exit, rule)) push(c.edge, c.dir, NG[i] + cost(c.edge), i);
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
  /** game seconds standing while waiting for a free path (since it last moved; congestion and deadlocks) */
  stuckTime = 0;
  /** current gradient under the train (for UI) */
  grade = 0;
  // energy accounting (physics, UPDATE 9j; opcosts.ts reads and resets them monthly)
  /** traction energy delivered at the wheels (J) */
  tractionJ = 0;
  /** energy taken by the brakes (J): what regenerative braking could return (opcosts applies the share) */
  regenJ = 0;
  /** hotel / auxiliary energy (J): heating, air conditioning, lighting while in service */
  auxJ = 0;
  /** distance run (km) */
  km = 0;
  /** hours in service (on the map) */
  hours = 0;

  constructor(game: Game, id: number, cars: VehicleModel[], depotId: number) {
    super(game, id);
    this.cars = cars;
    this.depotId = depotId;
    this.value = cars.reduce((s, c) => s + c.cost, 0);
    const dp = game.depots.get(depotId);
    if (dp) { this.homeX = dp.x; this.homeZ = dp.z; this.owner = dp.owner; }
  }

  private ruleKey = '';
  private ruleCache: TrackRule | null = null;
  /** Track types and wire this train needs (from its vehicles; see consistRule). */
  get rule(): TrackRule {
    const key = this.cars.map((c) => c.id).sort().join(',');
    if (key !== this.ruleKey || !this.ruleCache) { this.ruleKey = key; this.ruleCache = consistRule(this.cars); }
    return this.ruleCache;
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

  private physKey: unknown[] = [];
  private physCache = { aero: 0, aux: 0, driven: 0, accel: 1 };
  /**
   * Consist physics: aerodynamic c (N per (m/s)^2: the leading nose plus the length), hotel load (kW), driven mass
   * (t), design acceleration (m/s^2).
   */
  get phys(): { aero: number; aux: number; driven: number; accel: number } {
    const c0 = this.cars, n = c0.length, k = this.physKey;
    if (k[0] !== c0 || k[1] !== n || k[2] !== c0[0] || k[3] !== c0[n - 1]) {
      const key = [c0, n, c0[0], c0[n - 1]];
      let aero = this.cars.length ? aeroOf(this.cars[0]).nose : 0, aux = 0, driven = 0;
      for (const c of this.cars) {
        aero += aeroOf(c).len * c.length;
        aux += auxKwOf(c);
        if (c.power > 0) driven += c.kind === 'emu' ? c.weight * EMU_DRIVEN : c.weight;
      }
      this.physKey = key;
      this.physCache = { aero, aux, driven, accel: accelCap(c0) };
    }
    return this.physCache;
  }

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
    // (ops) wear of the passage for the owner's bill, metered for track access by that wear
    if (e && e.owner >= 0) trackPassage(g, this, e, s.len);
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
    const reserved = this.segs.find((sg) => sg.e === old.id);
    const net = g.world.net;
    // Plain one-way track up to a signal that prevents an opposing train entering. Do not split the
    // reservation of a junction or a platform exit (a train there may turn past its one-way starter).
    const oneWay = (edge: NEdge, dir: number) => {
      if (edge.station >= 0 || edge.depot >= 0) return false;
      let e = edge, n = net.nodes.get(dir > 0 ? e.b : e.a)!;
      for (let k = 0; k < 200; k++) {
        if (n.edges.length !== 2) return false;
        const next = net.edges.get(n.edges.find((id) => id !== e.id)!);
        if (!next || next.kind !== 'rail' || next.station >= 0 || next.depot >= 0
          || net.sideAt(next, n.id) !== -net.sideAt(e, n.id)) return false;
        if (n.signal) return !n.signalPass && net.signalFor(n, net.sideAt(e, n.id)) < 0;
        e = next;
        n = net.nodes.get(e.a === n.id ? e.b : e.a)!;
      }
      return false;
    };
    const mayYield = reserved && oneWay(reserved.dir > 0 ? e2 : e1, reserved.dir);
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
    if (mayYield && this.segs.length) {
      // A long reserved edge split for construction need not keep every new piece locked. Keep enough track
      // to brake safely, and queue the rest so a possession can hold free track beyond the stopping distance.
      const horizon = brakeDistance(this.speed);
      let d = this.segs[this.headSeg].len - this.headPos, i = this.headSeg + 1;
      while (i < this.segs.length) {
        const sg = this.segs[i], e = net.edges.get(sg.e);
        const n = e && net.nodes.get(sg.dir > 0 ? e.a : e.b);
        if (d >= horizon && (this.startsAtSignal(sg) || (e && n?.edges.length === 2 && oneWay(e, sg.dir)))) break;
        d += this.segs[i++].len;
      }
      const drop = this.segs.splice(i);
      this.pending.unshift(...drop);
      for (const sg of drop) this.release(sg, this.segs);
    }
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

  /**
   * Break a deadlock this train is part of: drop what it reserved ahead and take another way to its target,
   * turning back where it can (true if it found one).
   */
  breakDeadlock(): boolean {
    if (!this.segs.length || this.state !== 'waiting' || this.headSeg !== this.segs.length - 1) return false;
    this.pending = [];
    const before = this.reversed;
    this.forceTurn = true;
    const ok = this.planRoute(true);
    this.forceTurn = false;
    if (ok) { this.state = 'waiting'; this.waitTime = 0; this.stuckTime = 0; }
    return ok && this.reversed !== before;
  }
  private forceTurn = false;

  private planRoute(allowReverse: boolean): boolean {
    const g = this.game;
    const target = this.targetStation();
    this.pending = [];
    if (!target) { this.state = 'stopped'; this.status = 'No line assigned'; return false; }
    if (!target.rail) { this.state = 'noroute'; this.status = target.name + ' has no platforms'; return false; }
    this.routeTarget = target.id;
    const rule = this.rule;
    const last = this.segs[this.segs.length - 1];
    const fr = last ? frontier(g, last, this.owner, false, rule) : [];
    let fwd = fr.length ? findRailRoute(g, fr, target.id, this.owner, this.id, 60000, false, rule) : null;
    let rev: RouteResult | null = null;
    const canTurn = allowReverse && this.speed < 0.01 && this.segs.length && this.headSeg === this.segs.length - 1;
    // turning at a station (a terminus, or a short-turn pattern on double track): back off the platform past the
    // one-way signal at its end (the station's crossovers lead onto the other track; signals beyond keep their way)
    const turnAtPlatform = (ts: TSeg) => (g.world.net.edges.get(ts.e)?.station ?? -1) >= 0;
    if (canTurn) {
      const tail = this.tailInfo();
      const ts = this.segs[tail.seg];
      if (ts.e >= 0 && g.world.net.edges.get(ts.e)) {
        const rf = frontier(g, { ...ts, dir: -ts.dir }, this.owner, false, rule, turnAtPlatform(ts));
        if (rf.length) rev = findRailRoute(g, rf, target.id, this.owner, this.id, 60000, false, rule);
      }
    }
    if (!fwd && !rev && this.onForeignTrack()) {
      // caught on tracks we may no longer use (an access agreement ended): find the way off them
      const fx = last ? frontier(g, last, this.owner, true, rule) : [];
      fwd = fx.length ? findRailRoute(g, fx, target.id, this.owner, this.id, 60000, true, rule) : null;
      if (!fwd && canTurn) {
        const ts = this.segs[this.tailInfo().seg];
        if (ts.e >= 0 && g.world.net.edges.get(ts.e)) {
          const rf = frontier(g, { ...ts, dir: -ts.dir }, this.owner, true, rule, turnAtPlatform(ts));
          if (rf.length) rev = findRailRoute(g, rf, target.id, this.owner, this.id, 60000, true, rule);
        }
      }
    }
    if (!fwd && !rev) {
      this.state = 'noroute';
      // a way there for other trains, not for this one: say why
      let any = last && (rule.types || rule.wire) ? findRailRoute(g, frontier(g, last, this.owner), target.id, this.owner, this.id, 20000) : null;
      if (!any && canTurn && (rule.types || rule.wire)) {
        const ts = this.segs[this.tailInfo().seg];
        if (ts.e >= 0 && g.world.net.edges.has(ts.e)) {
          any = findRailRoute(g, frontier(g, { ...ts, dir: -ts.dir }, this.owner, false, null, turnAtPlatform(ts)), target.id, this.owner, this.id, 20000);
        }
      }
      this.status = any ? `No compatible route to ${target.name} (${rule.wire ? 'needs electrified track' : `needs ${[...rule.types!].join('/')} track`})` : 'No route to ' + target.name;
      if (++this.failCount >= 3 && this.line && this.line.stops.length > 1) { this.advanceStop(); this.failCount = 0; }
      return false;
    }
    this.failCount = 0;
    const penalty = 10 + this.length * 2;
    // a loop line keeps circulating: turning back only where the way ahead leads nowhere
    const loop = !!this.line && g.lines.isLoop(this.line);
    let route = fwd;
    if (rev && (!fwd || this.forceTurn || (!loop && rev.cost + penalty < fwd.cost))) {
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
    if (this.segs.length) this.account(dt);
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
        // (ops) a faster train about to pass: wait for it on this platform (bounded), then leave
        if (this.loadTimer <= 0 && !holdForOvertake(this.game, this, dt)) this.depart();
        return;
    }
    this.move(dt);
  }

  private tmpA = { x: 0, y: 0, z: 0 };
  private tmpB = { x: 0, y: 0, z: 0 };

  /** Physics accounting while in service (on the map): hotel energy and hours. */
  private account(dt: number) {
    this.auxJ += this.phys.aux * 1000 * dt;
    this.hours += dt / 3600;
  }

  private move(dt: number) {
    if (!this.segs.length) return;
    const g = this.game;
    let dEnd = this.distToEnd();
    const vmax = this.maxSpeed;
    // the path is reserved at least a braking distance ahead (cab signalling; block by block), else the speed
    // is held to what the reserved path allows
    const brakeDist = brakeDistance(this.speed);
    for (let k = 0; k < 16 && this.pending.length && dEnd < brakeDist + 6; k++) {
      if (!this.tryExtend()) break;
      dEnd = this.distToEnd();
    }
    // target speed from the braking curve to the end of the reserved path and speed limits ahead
    let vt = Math.min(vmax, brakeSpeed(dEnd - this.speed * dt));
    const look = brakeDist + 3;
    let d = -this.headPos;
    for (let i = this.headSeg; i < this.segs.length; i++) {
      const s = this.segs[i];
      if (i > this.headSeg && s.limit < vt) vt = Math.min(vt, brakeSpeed(Math.max(0, d - this.speed * dt) + brakeDistance(s.limit)));
      if (s.e >= 0 && s.res.length > 1) {
        for (const r of s.res) {
          if (r < CROSS_BASE) continue;
          const c = g.world.net.crossings.get(r - CROSS_BASE);
          if (!c || c.kind !== 'level') continue;
          const sp = s.dir > 0 ? c.s1 : s.len - c.s1;
          const dist = d + sp;
          if (dist < 0.2 || dist > look + 2) continue;
          if (g.vehicles.roadBusyNear(c.e2, c.x, c.z, 0.55)) vt = Math.min(vt, brakeSpeed(dist - 0.7));
        }
      }
      d += s.len;
      if (d > look) break;
    }
    // the whole train must respect the limits of the track it occupies
    const tail = this.tailInfo();
    for (let i = tail.seg; i <= this.headSeg; i++) vt = Math.min(vt, this.segs[i].limit);
    // physics (SI): tractive effort limited by power, adhesion (Curtius-Kniffler) and comfort; Davis running
    // resistance m (a0 + a1 v) + c v^2 with the train's own aerodynamics (nose and length, not mass); gradient;
    // service braking (more on a falling gradient). Energy at the wheels is accounted.
    const A = this.tmpA, B = this.tmpB;
    this.pointBehind(0, A);
    this.pointBehind(Math.min(this.length, 8), B);
    const span = Math.max(0.5, Math.min(this.length, 8));
    this.grade = (A.y - B.y) / span;
    const m = this.mass * 1000, mEff = m * ROTATING;
    const v0 = this.speed * 10, vT = Math.max(0, vt) * 10;
    const fGrade = m * 9.81 * this.grade;
    const initial = trainForces(this, v0);
    const accel = Math.max(-brakeRate(this.speed) * 10, Math.min((vT - v0) / dt, (initial.traction - initial.resistance - fGrade) / mEff));
    const { traction: fMax, resistance: fRes } = trainForces(this, Math.max(0, v0 + accel * dt / 2));
    // the force at the wheels that brings the train to the target speed this step, within what it can do
    const need = (mEff * (vT - v0)) / dt + fRes + fGrade;
    const fBrake = Math.max(0, mEff * brakeRate(this.speed) * 10 - fRes - fGrade);
    const F = Math.min(fMax, Math.max(need, -fBrake));
    let v1 = v0 + ((F - fRes - fGrade) / mEff) * dt;
    // A train too weak for the gradient creeps on, within the speed its reserved path allows.
    if (this.power > 0 && vT > v0 && v0 < 3 && v1 < v0 + 0.04 * dt) v1 = Math.min(vT, v0 + 0.04 * dt);
    if (vT >= v0 && v1 > vT) v1 = vT;
    this.speed = Math.max(0, v1) / 10;
    if (this.speed > vt && this.speed - vt < 0.002) this.speed = vt;
    let mv = (v0 / 10 + this.speed) * dt / 2;
    // Finish the low-speed approach exactly at the reserved boundary (station or signal).
    const finish = mv >= dEnd || (dEnd - mv < 0.02 && this.speed < 0.15);
    if (finish) mv = dEnd;
    // energy at the wheels: traction work, braking work (regenerable), distance
    const wheelJ = finish ? -0.5 * mEff * v0 * v0 + (fRes + fGrade) * mv * 10 : F * mv * 10;
    if (finish) this.speed = 0;
    if (wheelJ > 0) this.tractionJ += wheelJ; else this.regenJ -= wheelJ;
    this.km += mv / 100;
    if (this.speed > 0.05) this.stuckTime = 0;
    else if (this.state === 'waiting') this.stuckTime += dt;
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

/** Can a train leaving this depot reach the station? (`cars`: such a train, by its track rule) */
export function depotReaches(g: Game, dp: Depot, stationId: number, cars?: VehicleModel[]): boolean {
  const stub = g.world.net.edges.get(dp.edge);
  if (!stub) return false;
  return !!findRailRoute(g, [{ edge: stub, dir: 1 }], stationId, dp.owner, -1, 80000, false, cars ? consistRule(cars) : null);
}

/**
 * Can trains from this depot serve a line between stations a and b: reach one of them (a depot on a siding sends its
 * trains off one way) and go on from the platform they arrive at — straight on, or reversing there — to the other?
 * Returns the station to call at first, or -1 (e.g. a depot behind a platform track that leads nowhere else).
 */
export function depotServes(g: Game, dp: Depot, a: number, b: number, cars?: VehicleModel[]): number {
  const stub = g.world.net.edges.get(dp.edge);
  if (!stub) return -1;
  const rule = cars ? consistRule(cars) : null;
  for (const [x, y] of [[a, b], [b, a]]) {
    const r = findRailRoute(g, [{ edge: stub, dir: 1 }], x, dp.owner, -1, 80000, false, rule);
    const lc = r?.conts[r.conts.length - 1];
    if (!lc) continue;
    // on the way it came in, or turning back off the platform (past the one-way signal at its end, as trains do)
    if (findRailRoute(g, railNext(g, lc.edge, lc.dir, dp.owner, false, rule), y, dp.owner, -1, 80000, false, rule)
      || findRailRoute(g, railNext(g, lc.edge, -lc.dir, dp.owner, false, rule, lc.edge.station >= 0), y, dp.owner, -1, 80000, false, rule)) return x;
  }
  return -1;
}

/**
 * Can these vehicles run the line: from each stop to the next, some way their track rule allows? Null if
 * so, else why not (for a warning before buying, and for the AI).
 */
export function lineCompatibility(g: Game, lineId: number, cars: VehicleModel[]): string | null {
  const l = g.lines.get(lineId);
  if (!l || l.kind !== 'rail' || l.stops.length < 2) return null;
  const rule = consistRule(cars), net = g.world.net;
  if (!rule.types && !rule.wire) return null;
  for (let i = 0; i < l.stops.length; i++) {
    const a = g.stations.get(l.stops[i]), b = g.stations.get(l.stops[(i + 1) % l.stops.length]);
    if (!a?.rail || !b?.rail || a === b) continue;
    let ok = false;
    for (const eid of a.rail.edges) {
      const e = net.edges.get(eid);
      if (!e || !ruleAllows(rule, e)) continue;
      if ([1, -1].some((d) => !!findRailRoute(g, railNext(g, e, d, l.owner, false, rule), b.id, l.owner, -1, 40000, false, rule))) { ok = true; break; }
    }
    if (!ok) return `${cars[0]?.name ?? 'This train'} cannot run from ${a.name} to ${b.name}: the track there is not ${rule.wire ? 'electrified ' : ''}${rule.types ? [...rule.types].join(' / ') : ''} track`;
  }
  return null;
}

/**
 * Who runs the track a line uses (through services across several companies' networks): per owner, the route
 * length on its track between consecutive stops and the share of the whole, longest first.
 */
export function lineOperators(g: Game, lineId: number): { owner: number; distance: number; share: number }[] {
  const l = g.lines.get(lineId);
  if (!l || l.kind !== 'rail' || l.stops.length < 2) return [];
  const net = g.world.net;
  const v = l.vehicles.map((id) => g.vehicles.get(id)).find((x): x is Train => x instanceof Train);
  const rule = v ? v.rule : null;
  const by = new Map<number, number>();
  for (let i = 0; i < l.stops.length; i++) {
    const a = g.stations.get(l.stops[i]), b = g.stations.get(l.stops[(i + 1) % l.stops.length]);
    if (!a?.rail || !b?.rail || a === b) continue;
    let best: RouteResult | null = null;
    for (const eid of a.rail.edges) {
      const e = net.edges.get(eid);
      if (!e) continue;
      for (const d of [1, -1]) {
        const r = findRailRoute(g, railNext(g, e, d, l.owner, false, rule), b.id, l.owner, -1, 40000, false, rule);
        if (r && (!best || r.cost < best.cost)) best = r;
      }
    }
    for (const c of best?.conts ?? []) by.set(c.edge.owner, (by.get(c.edge.owner) ?? 0) + c.edge.len);
  }
  const total = [...by.values()].reduce((x, y) => x + y, 0) || 1;
  return [...by].map(([owner, distance]) => ({ owner, distance, share: distance / total })).sort((p, q) => q.distance - p.distance);
}

// ------------------------------------------------------------------------------------------- congestion
export type CongestionFix = 'none' | 'signals' | 'platforms' | 'loops' | 'double' | 'fewer-trains';
export interface LineCongestion {
  /** 0 flowing, 1 some waiting, 2 congested, 3 stuck (a deadlock or trains not moving for long) */
  level: 0 | 1 | 2 | 3;
  /** trains of the line waiting for a free path a while (> 30 s), and how long the longest has waited */
  waits: number; longestWait: number;
  /** trains of the line in a circle of trains each waiting for the next */
  deadlock: boolean;
  /** where they wait: the reserved stretch each waiting train needs next (edge ids) */
  blockedStretches: number[][];
  edgeIds: number[];
  /** stations the line's waiting trains are held before (waiting for a free platform there): trains per station */
  platformWaits: { station: number; trains: number }[];
  /** what would help: signals (none on the line yet), more platforms (most wait for one), passing loops / double
   * track (single track), fewer trains */
  suggestion: CongestionFix;
}

/** Trains held for a platform at a station (see platformWaits). */
export interface PlatformWait {
  station: number;
  /** trains waiting a while (minWait) for a free path into the station they head for, and their ids */
  trains: number; trainIds: number[];
  /** seconds the longest of them has waited */
  longestWait: number;
}

/** Is a waiting train held for a platform of the station it heads for (its blocked path runs into the station, or it waits within reach of it)? */
export function waitsForPlatform(g: Game, t: Train): boolean {
  if (t.state !== 'waiting' || t.routeTarget < 0) return false;
  const net = g.world.net, target = t.routeTarget;
  if (t.pending.slice(0, 12).some((x) => x.e >= 0 && net.edges.get(x.e)?.station === target)) return true;
  const r = g.stations.get(target)?.rail;
  if (!r) return false;
  const p = { x: 0, y: 0, z: 0 };
  t.worldPos(p);
  return Math.hypot(p.x - r.x, p.z - r.z) <= r.length / 2 + 25;
}

/**
 * Trains held for a platform, per station (all companies): trains waiting at least `minWait` seconds for a free
 * path into the station they head for. Stations without such trains are left out.
 */
export function platformWaits(g: Game, minWait = 10): Map<number, PlatformWait> {
  const out = new Map<number, PlatformWait>();
  for (const t of g.vehicles.trains()) {
    if (t.stuckTime < minWait || !waitsForPlatform(g, t)) continue;
    let w = out.get(t.routeTarget);
    if (!w) out.set(t.routeTarget, w = { station: t.routeTarget, trains: 0, trainIds: [], longestWait: 0 });
    w.trains++;
    w.trainIds.push(t.id);
    w.longestWait = Math.max(w.longestWait, t.stuckTime);
  }
  return out;
}

/** Trains in circles of mutual waiting (each waits for the next one's reserved track): the circles. */
export function deadlockCycles(g: Game, minWait = 20): Train[][] {
  const by = new Map<number, Train>();
  for (const t of g.vehicles.trains()) if (t.state === 'waiting' && t.blockedBy && t.stuckTime >= minWait) by.set(t.id, t);
  const out: Train[][] = [], done = new Set<number>();
  for (const t of by.values()) {
    if (done.has(t.id)) continue;
    const path: Train[] = [], seen = new Map<number, number>();
    let cur: Train | undefined = t;
    while (cur && !seen.has(cur.id) && !done.has(cur.id)) { seen.set(cur.id, path.length); path.push(cur); cur = by.get(cur.blockedBy); }
    if (cur && seen.has(cur.id)) out.push(path.slice(seen.get(cur.id)));
    for (const x of path) done.add(x.id);
  }
  return out;
}

/** Break each deadlock: the train that waited longest takes another way (turning back); true if any moved. */
export function resolveDeadlocks(g: Game, minWait = 40): boolean {
  let any = false;
  for (const cyc of deadlockCycles(g, minWait)) {
    const order = [...cyc].sort((a, b) => b.stuckTime - a.stuckTime || a.id - b.id);
    for (const t of order) if (t.breakDeadlock()) { any = true; break; }
  }
  return any;
}

/** How congested a railway line is (all its operators' trains) and what would help. */
export function lineCongestion(g: Game, lineId: number): LineCongestion {
  const res: LineCongestion = { level: 0, waits: 0, longestWait: 0, deadlock: false, blockedStretches: [], edgeIds: [], platformWaits: [], suggestion: 'none' };
  const l = g.lines.get(lineId);
  if (!l || l.kind !== 'rail') return res;
  const trains = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train);
  const ids = new Set(trains.map((t) => t.id));
  const edges = new Set<number>();
  for (const t of trains) {
    if (t.state !== 'waiting') continue;
    res.longestWait = Math.max(res.longestWait, t.stuckTime);
    if (t.stuckTime < 30) continue;
    res.waits++;
    if (waitsForPlatform(g, t)) {
      const pw = res.platformWaits.find((q) => q.station === t.routeTarget);
      if (pw) pw.trains++; else res.platformWaits.push({ station: t.routeTarget, trains: 1 });
    }
    const stretch = t.pending.slice(0, 12).map((x) => x.e).filter((e) => e >= 0);
    res.blockedStretches.push(stretch);
    for (const e of stretch) edges.add(e);
  }
  res.edgeIds = [...edges];
  res.deadlock = deadlockCycles(g, 20).some((c) => c.some((t) => ids.has(t.id)));
  res.level = res.deadlock || res.longestWait > 240 ? 3 : res.waits >= 2 || (res.waits >= 1 && res.longestWait > 90) ? 2 : res.waits ? 1 : 0;
  if (res.level < 2) return res;
  // what the waiting stretches lack: signals, a second track (loops first), else there are too many trains
  const net = g.world.net;
  let signals = 0, single = 0, n = 0;
  for (const e of edges) {
    const ed = net.edges.get(e);
    if (!ed) continue;
    n++;
    if (net.nodes.get(ed.a)?.signal || net.nodes.get(ed.b)?.signal) signals++;
    if (!twinTrack(g, ed)) single++;
  }
  const atPlatforms = res.platformWaits.reduce((a, q) => a + q.trains, 0);
  res.suggestion = n && signals === 0 ? 'signals' : atPlatforms * 2 > res.waits ? 'platforms' : single > n / 2 ? (trains.length > 2 ? 'double' : 'loops') : 'fewer-trains';
  return res;
}

/** Is there a second track beside this one (double track, a passing loop)? */
function twinTrack(g: Game, e: NEdge): boolean {
  const net = g.world.net, p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  net.pointAt(e, e.len / 2, p, d);
  const l = Math.hypot(d.x, d.z) || 1;
  const tx = d.x / l, tz = d.z / l;
  for (const o of net.edgesNear(p.x - 2, p.z - 2, p.x + 2, p.z + 2)) {
    if (o.id === e.id || o.kind !== 'rail' || o.depot >= 0) continue;
    const ne = net.nearestEdge(p.x, p.z, 1.6, 'rail', (x) => x.id === o.id);
    if (!ne || ne.d < 0.2) continue;
    const q = { x: 0, y: 0, z: 0 }, dd = { x: 0, y: 0, z: 0 };
    net.pointAt(o, ne.s, q, dd);
    const ol = Math.hypot(dd.x, dd.z) || 1;
    if (Math.abs((dd.x * tx + dd.z * tz) / ol) > 0.95) return true;
  }
  return false;
}
