// Vehicle manager: ownership, reservations, spatial hash, purchases and ambient traffic.
import type { Game } from './game';
import { Vehicle } from './vehicle';
import { Train, CROSS_BASE, type TSeg } from './train';
import { RoadVehicle, RSeg, makeLaneSeg, connsConflict } from './roadvehicle';
import { VehicleModel } from './vehicle-types';
import { RNG } from './rng';
import { curvePoint, type NEdge } from './network';
import { closestOnPolyline, type Vec3Like } from './geom';
import { chargeVehicles } from './opcosts';
import { spacingSchedule } from './patterns';
import { simNow } from './fares';

/** Occupancy key: a lane (edge, direction) or one connector (from lane -> to lane) through a junction. */
const segKey = (s: RSeg) => (s.kind === 'lane' ? s.e * 2 + (s.dir > 0 ? 1 : 0)
  : -1 - ((s.from * 2 + (s.fromDir > 0 ? 1 : 0)) * 4194304 + s.e * 2 + (s.dir > 0 ? 1 : 0)));

/** Vehicles on one lane/connector with the start of the stretch they occupy (pooled, rebuilt per tick). */
interface Occ { v: RoadVehicle[]; s: number[]; n: number }

/** Previous committed pose, only for rendering; absent from saves and simulation decisions. */
interface RenderPose { segs: (TSeg | RSeg)[]; head: number; pos: number; reversed: boolean; length: number; speed: number; tick: number }
interface RenderPoint<S> { seg: S; pos: number }

export class Vehicles {
  map = new Map<number, Vehicle>();
  nextId = 1;
  ambient: RoadVehicle[] = [];
  nextAmbientId = 1_000_000;
  private res = new Map<number, number>();
  /** level crossings currently closed for road traffic */
  crossingClosed = new Set<number>();
  private occ = new Map<number, Occ>();
  private occUsed: Occ[] = [];
  /** vehicles inside a junction (on a connector) per node */
  private nodeOcc = new Map<number, Occ>();
  private nodeUsed: Occ[] = [];
  private rng = new RNG(4242);
  private failedUpdates = new WeakSet<Vehicle>();
  ambientEnabled = true;
  private ambientTicks = 0;
  // Keep the save field in seconds for compatibility; its countdown is an integer number of ticks.
  private get ambientTimer() { return this.ambientTicks * this.game.tickSeconds; }
  private set ambientTimer(seconds: number) { this.ambientTicks = Math.max(0, Math.round(seconds / this.game.tickSeconds)); }
  private renderPoses = new WeakMap<Vehicle, RenderPose>();
  private prevPoint = { x: 0, y: 0, z: 0 };
  private prevDir = { x: 0, y: 0, z: 0 };
  private renderPoint: RenderPoint<TSeg | RSeg> = { seg: null!, pos: 0 };

  constructor(private game: Game) {
    const net = game.world.net;
    net.onSplit.push((old, e1, e2, s) => this.onSplit(old, e1, e2, s));
    net.onRemove.push((e) => this.onRemove(e));
  }

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }
  trains(): Train[] { return [...this.map.values()].filter((v): v is Train => v.kind === 'train'); }
  roads(): RoadVehicle[] { return [...this.map.values()].filter((v): v is RoadVehicle => v.kind === 'road'); }
  ofOwner(owner: number) { return [...this.map.values()].filter((v) => v.owner === owner); }

  resetRenderPoses() { this.renderPoses = new WeakMap(); }

  private rememberPose(v: Vehicle) {
    if (!(v instanceof Train || v instanceof RoadVehicle)) return;
    let p = this.renderPoses.get(v);
    if (!p) { p = { segs: [], head: 0, pos: 0, reversed: false, length: 0, speed: 0, tick: 0 }; this.renderPoses.set(v, p); }
    p.segs.length = 0;
    if (v instanceof Train) {
      for (let i = 0; i <= v.headSeg && i < v.segs.length; i++) p.segs.push(v.segs[i]);
      p.head = v.headSeg; p.pos = v.headPos; p.reversed = v.reversed;
    } else {
      for (let i = v.trail.length - 1; i >= 0; i--) p.segs.push(v.trail[i]);
      if (v.seg) p.segs.push(v.seg);
      p.head = p.segs.length - 1; p.pos = v.pos;
    }
    p.length = v.length; p.speed = v.speed; p.tick = this.game.tick;
  }

  /** Acceleration in units/s² of the last committed tick, stable between rendered frames. */
  renderAcceleration(v: Train | RoadVehicle): number {
    const p = this.renderPoses.get(v);
    return p && p.tick === this.game.tick - 1 ? (v.speed - p.speed) / this.game.tickSeconds : 0;
  }

  /** Interpolate committed poses without changing simulation state. Returned metadata is scratch: consume before the next query. */
  renderPointBehind(v: Train, d: number, out: Vec3Like, dir?: Vec3Like): RenderPoint<TSeg> | null;
  renderPointBehind(v: RoadVehicle, d: number, out: Vec3Like, dir?: Vec3Like): RenderPoint<RSeg> | null;
  renderPointBehind(v: Train | RoadVehicle, d: number, out: Vec3Like, dir?: Vec3Like): RenderPoint<TSeg | RSeg> | null;
  renderPointBehind(v: Train | RoadVehicle, d: number, out: Vec3Like, dir?: Vec3Like): RenderPoint<TSeg | RSeg> | null {
    const current = this.renderPoint;
    if (v instanceof Train) {
      if (!v.segs.length) return null;
      let i = v.headSeg, pos = v.headPos, behind = d;
      while (behind > pos && i > 0) { behind -= pos; pos = v.segs[--i].len; }
      const s = v.segs[i];
      pos = Math.max(0, pos - behind);
      curvePoint(s.curve, s.dir > 0 ? pos : s.len - pos, out, dir);
      if (dir && s.dir < 0) { dir.x = -dir.x; dir.y = -dir.y; dir.z = -dir.z; }
      current.seg = s; current.pos = pos;
    } else {
      if (!v.seg) return null;
      let s = v.seg, pos = v.pos, k = 0, behind = d;
      while (behind > pos && k < v.trail.length) { behind -= pos; s = v.trail[k++]; pos = s.len; }
      pos = Math.max(0, Math.min(s.len, pos - behind));
      curvePoint(s.curve, pos, out, dir);
      current.seg = s; current.pos = pos;
    }
    const p = this.renderPoses.get(v), alpha = this.game.alpha;
    if (!p || !p.segs.length || p.tick !== this.game.tick - 1 || p.length !== v.length) return current;
    const reversed = v instanceof Train && p.reversed !== v.reversed;
    let behind = reversed ? p.length - d : d, i = p.head, pos = p.pos;
    while (behind > pos && i > 0) { behind -= pos; pos = p.segs[--i].len; }
    const s = p.segs[i];
    pos = Math.max(0, Math.min(s.len, pos - behind));
    const rail = v instanceof Train, sign = rail && s.dir < 0 ? -1 : 1;
    curvePoint(s.curve, rail && s.dir < 0 ? s.len - pos : pos, this.prevPoint, dir ? this.prevDir : undefined);
    out.x = this.prevPoint.x + (out.x - this.prevPoint.x) * alpha;
    out.y = this.prevPoint.y + (out.y - this.prevPoint.y) * alpha;
    out.z = this.prevPoint.z + (out.z - this.prevPoint.z) * alpha;
    if (dir) {
      const sg = reversed ? -sign : sign, q = this.prevDir;
      dir.x = q.x * sg + (dir.x - q.x * sg) * alpha;
      dir.y = q.y * sg + (dir.y - q.y * sg) * alpha;
      dir.z = q.z * sg + (dir.z - q.z * sg) * alpha;
      const len = Math.hypot(dir.x, dir.y, dir.z) || 1;
      dir.x /= len; dir.y /= len; dir.z /= len;
    }
    if (s === current.seg) current.pos = pos + (current.pos - pos) * alpha;
    else if (alpha < 0.5) { current.seg = s; current.pos = pos; }
    return current;
  }

  /** Camera follow uses the same interpolated centre as the vehicle bodies. */
  renderWorldPos(v: Vehicle, out: Vec3Like): boolean {
    if (v instanceof Train || v instanceof RoadVehicle) {
      if (this.renderPointBehind(v, v.length / 2, out)) return true;
    }
    return v.worldPos(out);
  }

  // ---------------------------------------------------------------- reservations
  getRes(r: number): number { return this.res.get(r) ?? 0; }
  setRes(r: number, id: number) { this.res.set(r, id); }
  releaseRes(r: number, id: number) { if (this.res.get(r) === id) this.res.delete(r); }
  crossingReservedBy(cid: number) { return this.getRes(CROSS_BASE + cid); }

  /** Physically occupied by a train or a company vehicle (ambient traffic never blocks construction). */
  isEdgeBusy(eid: number): boolean {
    for (const v of this.map.values()) {
      if (v instanceof Train) { if (v.occupiedEdges().includes(eid)) return true; }
      else if (v instanceof RoadVehicle) { if (v.seg && v.occupiedEdges().includes(eid)) return true; }
    }
    return false;
  }

  // ---------------------------------------------------------------- network changes
  private onSplit(old: NEdge, e1: NEdge, e2: NEdge, s: number) {
    for (const v of this.map.values()) if (v instanceof Train) v.onEdgeSplit(old, e1, e2, s);
    const fixRoad = (v: RoadVehicle): boolean => {
      if (!v.seg) return true;
      const net = this.game.world.net;
      const remapConn = (c: RSeg) => {
        if (c.kind !== 'conn') return;
        if (c.e === old.id) c.e = c.dir > 0 ? e1.id : e2.id;
        if (c.from === old.id) c.from = c.fromDir > 0 ? e2.id : e1.id;
      };
      remapConn(v.seg);
      for (const t of v.trail) remapConn(t);
      if (v.seg.kind === 'lane' && v.seg.e === old.id) {
        const p = { x: 0, y: 0, z: 0 };
        v.pointBehind(0, p);
        let best: { seg: RSeg; pos: number; d: number } | null = null;
        for (const e of [e1, e2]) {
          if (!net.edges.has(e.id)) continue;
          const seg = makeLaneSeg(this.game, e, v.seg.dir);
          const c = seg.curve;
          const r = closestOnPolyline(p.x, p.z, c.pts, 3, c.cum.length);
          const pos = c.cum[r.i] + (c.cum[Math.min(c.cum.length - 1, r.i + 1)] - c.cum[r.i]) * r.f;
          if (!best || r.d < best.d) best = { seg, pos, d: r.d };
        }
        if (!best || best.d > 0.6) return false;
        v.seg = best.seg;
        v.pos = best.pos;
        v.trail = [];
      }
      if (v.ahead.some((a) => a.e === old.id || a.from === old.id)) {
        const k = v.ahead.findIndex((a) => a.e === old.id || a.from === old.id);
        v.ahead.length = k;
        v.route = [];
      }
      v.trail = v.trail.filter((t) => t.e !== old.id);
      return true;
    };
    for (const v of this.map.values()) if (v instanceof RoadVehicle && !fixRoad(v)) v.returnToDepot('Returned to depot');
    this.ambient = this.ambient.filter((a) => fixRoad(a));
  }

  private onRemove(e: NEdge) {
    for (const v of this.map.values()) {
      if (v instanceof Train) v.onEdgeRemoved(e);
      else if (v instanceof RoadVehicle && v.seg && v.occupiedEdges().includes(e.id)) v.returnToDepot('Returned to depot (road removed)');
    }
    this.ambient = this.ambient.filter((a) => !a.seg || !a.occupiedEdges().includes(e.id));
  }

  /** After construction: refresh geometry, drop stale look-ahead. */
  onNetworkChanged() {
    for (const v of this.map.values()) {
      if (v instanceof Train) v.refreshGeometry();
      else if (v instanceof RoadVehicle && !v.onNetworkChanged()) v.returnToDepot('Returned to depot (road removed)');
    }
    this.ambient = this.ambient.filter((a) => a.onNetworkChanged());
    const net = this.game.world.net;
    net.dirtyNodes.clear();
    net.dirtyEdges.clear();
  }

  private replanQueue: number[] = [];
  /** After a network change: vehicles that lost their plan re-plan now, the others gradually (budget per tick). */
  replanAfterNetworkChange() {
    this.replanQueue.length = 0;
    for (const v of this.map.values()) {
      if (v.state !== 'running' && v.state !== 'waiting' && v.state !== 'noroute') continue;
      if (v.state === 'noroute' || (v instanceof RoadVehicle && v.needsReplan)) { if (v instanceof RoadVehicle) v.needsReplan = false; v.onLineChanged(); }
      else this.replanQueue.push(v.id);
    }
  }

  private replanSome(n: number) {
    while (n-- > 0 && this.replanQueue.length) {
      const v = this.map.get(this.replanQueue.pop()!);
      if (v && (v.state === 'running' || v.state === 'waiting' || v.state === 'noroute')) v.onLineChanged();
    }
  }

  // ---------------------------------------------------------------- road spatial hash
  private pushOcc(map: Map<number, Occ>, used: Occ[], k: number, v: RoadVehicle, start: number) {
    let o = map.get(k);
    if (!o) { o = { v: [], s: [], n: 0 }; map.set(k, o); }
    if (o.n === 0) used.push(o);
    o.v[o.n] = v; o.s[o.n] = start; o.n++;
  }

  private addOcc(v: RoadVehicle) {
    const seg = v.seg;
    if (!seg) return;
    const L = v.length;
    // start of the occupied stretch = rear of the body along the segment (negative: it extends further back)
    this.pushOcc(this.occ, this.occUsed, segKey(seg), v, v.pos - L);
    if (seg.kind === 'conn') this.pushOcc(this.nodeOcc, this.nodeUsed, seg.node, v, 0);
    let rem = L - v.pos;
    for (let i = 0; i < v.trail.length && rem > 0; i++) {
      const t = v.trail[i];
      this.pushOcc(this.occ, this.occUsed, segKey(t), v, t.len - rem);
      if (i === 0 && t.kind === 'conn') this.pushOcc(this.nodeOcc, this.nodeUsed, t.node, v, 0);
      rem -= t.len;
    }
  }

  /** Register a vehicle that was just placed on the road (depot exit, spawn) for the rest of this tick. */
  noteOnRoad(v: RoadVehicle) { this.addOcc(v); }

  /** Rebuild the per-lane occupancy (once per tick). */
  private rebuildOcc() {
    for (const o of this.occUsed) o.n = 0;
    for (const o of this.nodeUsed) o.n = 0;
    this.occUsed.length = 0;
    this.nodeUsed.length = 0;
    if (this.occ.size > 20000) this.occ.clear();
    for (const v of this.map.values()) if (v instanceof RoadVehicle) this.addOcc(v);
    for (const v of this.ambient) this.addOcc(v);
  }

  private tA = { x: 0, y: 0, z: 0 };
  private tB = { x: 0, y: 0, z: 0 };

  /** Distance from v's front to the rear of the nearest vehicle ahead in the same lane, or Infinity. */
  gapAhead(v: RoadVehicle, look: number): number {
    const seg = v.seg;
    if (!seg) return Infinity;
    let best = Infinity;
    let o = this.occ.get(segKey(seg));
    if (o) for (let i = 0; i < o.n; i++) {
      if (o.v[i] === v) continue;
      const gap = o.s[i] - v.pos;
      if (gap > -0.05 && gap < best) best = gap;
    }
    let d = seg.len - v.pos;
    const ahead = v.ahead;
    for (let k = 0; k < ahead.length && k < 3 && d <= look; k++) {
      const s = ahead[k];
      o = this.occ.get(segKey(s));
      if (o) for (let i = 0; i < o.n; i++) {
        if (o.v[i] === v) continue;
        const gap = d + o.s[i];
        if (gap > -0.05 && gap < best) best = gap;
      }
      d += s.len;
    }
    return best <= look ? best : Infinity;
  }

  /** A blocked/braking train already needs this path; road vehicles must not queue behind a spacing hold. */
  spacingBlocked(v: Vehicle): boolean {
    if (v instanceof Train) {
      for (const o of this.map.values()) if (o instanceof Train && o !== v && o.blockedBy === v.id &&
        (o.state === 'waiting' || o.state === 'running')) return true;
    } else if (v instanceof RoadVehicle && v.seg) {
      let s = v.seg, rear = v.pos - v.length, k = 0;
      while (true) {
        const list = this.occ.get(segKey(s));
        if (list) for (let i = 0; i < list.n; i++) {
          const o = list.v[i];
          if (o === v || !o.seg || segKey(o.seg) !== segKey(s) || o.state === 'loading' || o.speed >= 0.05) continue;
          const gap = rear - o.pos;
          if (gap >= -0.05 && gap < 0.8) return true;
        }
        if (rear >= 0.8 || k >= v.trail.length) break;
        s = v.trail[k++]; rear += s.len;
      }
    }
    return false;
  }

  private spacingReleaseKey(v: Vehicle): string {
    v.targetStation(); // normalise an old / skipped stop index before choosing the entry direction
    return (v instanceof Train || v instanceof RoadVehicle ? v.depotId : -1) + ':' + v.stopIndex;
  }

  /** A depot's releases into the same pattern/direction are staggered; failed exits consume no slot. */
  waitForSpacingRelease(v: Vehicle): boolean {
    const s = spacingSchedule(this.game, v);
    const released = s?.clock.released?.[this.spacingReleaseKey(v)];
    if (s && s.vehicles >= 2 && released !== undefined && simNow(this.game) - released < s.headway) {
      v.status = 'Waiting to depart (spacing)';
      return true;
    }
    return false;
  }

  noteSpacingRelease(v: Vehicle) {
    v.resetSpacing(); // returning to a depot cancels any unfinished station departure
    const s = spacingSchedule(this.game, v);
    if (s) (s.clock.released ??= {})[this.spacingReleaseKey(v)] = simNow(this.game);
  }

  /** May v enter connector c (no conflicting vehicle inside the junction)? */
  junctionFree(v: RoadVehicle, c: RSeg): boolean {
    const list = this.nodeOcc.get(c.node);
    if (!list) return true;
    for (let i = 0; i < list.n; i++) {
      const o = list.v[i];
      if (o === v) continue;
      const oc = o.seg && o.seg.kind === 'conn' && o.seg.node === c.node ? o.seg
        : o.trail[0] && o.trail[0].kind === 'conn' && o.trail[0].node === c.node ? o.trail[0] : null;
      if (!oc) continue;
      if (oc.from === c.from && oc.fromDir === c.fromDir) continue;
      if (connsConflict(c, oc)) return false;
    }
    return true;
  }

  /** Any road vehicle on edge eid within r of (x,z)? */
  roadBusyNear(eid: number, x: number, z: number, r: number): boolean {
    const a = this.tA, b = this.tB;
    for (let k = eid * 2; k <= eid * 2 + 1; k++) {
      const list = this.occ.get(k);
      if (!list) continue;
      for (let i = 0; i < list.n; i++) {
        const v = list.v[i];
        v.pointBehind(0, a);
        v.pointBehind(v.length, b);
        const dx = b.x - a.x, dz = b.z - a.z;
        const l2 = dx * dx + dz * dz;
        let f = l2 > 1e-9 ? ((x - a.x) * dx + (z - a.z) * dz) / l2 : 0;
        f = Math.max(0, Math.min(1, f));
        if (Math.hypot(a.x + dx * f - x, a.z + dz * f - z) < r) return true;
      }
    }
    return false;
  }

  private updateCrossings() {
    this.crossingClosed.clear();
    const net = this.game.world.net;
    if (!net.crossings.size) return;
    for (const v of this.map.values()) {
      if (!(v instanceof Train) || !v.segs.length) continue;
      const warn = 6 + v.speed * 10;
      const tail = v.tailInfo();
      let off = -v.headPos;
      for (let i = v.headSeg - 1; i >= tail.seg; i--) off -= v.segs[i].len;
      for (let i = tail.seg; i < v.segs.length; i++) {
        const s = v.segs[i];
        if (off > warn) break;
        for (const r of s.res) {
          if (r < CROSS_BASE) continue;
          const c = net.crossings.get(r - CROSS_BASE);
          if (!c || c.kind !== 'level') continue;
          const sp = s.dir > 0 ? c.s1 : s.len - c.s1;
          const dist = off + sp;
          if (dist > -(v.length + 0.6) && dist < warn) this.crossingClosed.add(c.id);
        }
        off += s.len;
      }
    }
  }

  // ---------------------------------------------------------------- update
  private updateVehicle(v: Vehicle, dt: number) {
    this.rememberPose(v);
    if (v.state === 'stopped' && this.failedUpdates.has(v)) return;
    try { v.update(dt); }
    catch (e) {
      if (!this.failedUpdates.has(v)) {
        this.failedUpdates.add(v);
        console.error(`Vehicle ${v.id} (${v.name || 'ambient traffic'}) update failed`, e);
      }
      // An interrupted reservation may not have reached the train's path yet. Release every key it owns.
      for (const [r, id] of this.res) if (id === v.id) this.res.delete(r);
      if (v instanceof Train) {
        v.segs = []; v.pending = []; v.headSeg = 0; v.headPos = 0; v.speed = 0;
        v.atStation = -1; v.routeTarget = -1; v.blockedBy = 0; v.waitTime = 0; v.stuckTime = 0;
      } else if (v instanceof RoadVehicle) v.returnToDepot('Stopped in depot after an update error');
      v.state = 'stopped';
      v.status = 'Stopped in depot after an update error';
    }
  }

  update(dt: number) {
    if (this.replanQueue.length) this.replanSome(6);
    this.rebuildOcc();
    this.updateCrossings();
    for (const v of this.map.values()) this.updateVehicle(v, dt);
    if (this.ambientEnabled) {
      const amb = this.ambient;
      let n = 0;
      for (let i = 0; i < amb.length; i++) {
        const a = amb[i];
        this.updateVehicle(a, dt);
        if (a.state !== 'stopped' && a.seg) amb[n++] = a;
      }
      amb.length = n;
      if (--this.ambientTicks <= 0) { this.ambientTicks = Math.round(8 / this.game.tickSeconds); this.manageAmbient(); }
    } else if (this.ambient.length) this.ambient = [];
    // A follower updated later this tick may have just found this platform/lane blocked. End the hold now,
    // before a committed tick (or a save) can contain a spacing hold obstructing another vehicle's path.
    for (const v of this.map.values()) if (v.state === 'loading' && v.status === 'Holding for even spacing' && this.spacingBlocked(v)) {
      if (v instanceof Train || v instanceof RoadVehicle) v.depart();
    }
  }

  /** Keep the ambient traffic population in line with town sizes. */
  manageAmbient() {
    if (!this.ambientEnabled) { this.ambient = []; return; }
    const g = this.game;
    const count = new Map<number, number>();
    const p = { x: 0, y: 0, z: 0 };
    for (const a of this.ambient) {
      a.worldPos(p);
      const t = g.towns.nearest(p.x, p.z);
      if (t) count.set(t.id, (count.get(t.id) ?? 0) + 1);
    }
    let budget = 320 - this.ambient.length;
    for (const town of g.towns.list) {
      if (budget <= 0) break;
      const want = Math.min(32, Math.floor(town.pop / 110));
      let have = count.get(town.id) ?? 0;
      if (have >= want) continue;
      const streets = g.towns.streets(town, 0);
      if (!streets.length) continue;
      let tries = 0;
      while (have < want && budget > 0 && tries++ < 12) {
        const e = streets[this.rng.int(streets.length)];
        if (e.len < 1.2) continue;
        const dir = this.rng.next() < 0.5 ? 1 : -1;
        const seg = makeLaneSeg(g, e, dir);
        if (seg.len < 0.8) continue;
        const pos = 0.3 + this.rng.next() * (seg.len - 0.6);
        const q = { x: 0, y: 0, z: 0 };
        const c = seg.curve;
        const idx = Math.min(c.cum.length - 1, Math.max(0, Math.round((pos / seg.len) * (c.cum.length - 1))));
        q.x = c.pts[idx * 3]; q.z = c.pts[idx * 3 + 2];
        if (this.roadBusyNear(e.id, q.x, q.z, 1.2)) continue;
        const v = new RoadVehicle(g, this.nextAmbientId++, null, -1, true, this.rng.int(1e9));
        v.placeAt(seg, pos);
        this.ambient.push(v);
        this.addOcc(v);
        have++; budget--;
      }
    }
  }

  // ---------------------------------------------------------------- purchase
  buyTrain(depotId: number, cars: VehicleModel[], lineId: number | null): Train | string {
    const g = this.game;
    const dp = g.depots.get(depotId);
    if (!dp || dp.kind !== 'rail') return 'Invalid depot';
    // a locomotive hauling coaches, or one or more electric multiple units coupled together
    const emu = cars.length > 0 && cars[0].kind === 'emu';
    if (!cars.length || (!emu && cars[0].kind !== 'loco')) return 'A train needs a locomotive';
    if (emu ? cars.some((c) => c.kind !== 'emu') : cars.some((c) => c.kind === 'emu')) return 'Multiple units only couple with multiple units';
    // (companies: an operator of the line owning one of its stations, lines.operateError)
    const tl = lineId != null ? g.lines.get(lineId) : undefined;
    const opErr = tl ? g.lines.operateError(tl, dp.owner) : null;
    if (opErr) return opErr;
    const cost = cars.reduce((s, c) => s + c.cost, 0);
    if (!g.company(dp.owner).economy.spend(cost, 'vehicles')) return 'Not enough money';
    const t = new Train(g, this.nextId++, cars, depotId);
    t.owner = dp.owner;
    t.name = (dp.owner === 0 ? 'Train ' : g.company(dp.owner).name.split(' ')[0] + ' Train ') + t.id;
    this.map.set(t.id, t);
    if (lineId != null) t.setLine(lineId);
    return t;
  }

  /** Buy a bus (at a road depot) or a tram (model.kind 'tram', at a tram depot). */
  buyRoad(depotId: number, model: VehicleModel, lineId: number | null): RoadVehicle | string {
    const g = this.game;
    const dp = g.depots.get(depotId);
    const tram = model.kind === 'tram';
    if (!dp || dp.kind !== (tram ? 'tram' : 'road')) return tram ? 'Trams are bought at a tram depot' : 'Invalid depot';
    const line = lineId != null ? g.lines.get(lineId) : undefined;
    if (line && line.kind !== (tram ? 'tram' : 'road')) return tram ? 'Not a tram line' : 'Not a bus line';
    // (companies: an operator of the line owning one of its stations, lines.operateError)
    const opErr = line ? g.lines.operateError(line, dp.owner) : null;
    if (opErr) return opErr;
    if (!g.company(dp.owner).economy.spend(model.cost, 'vehicles')) return 'Not enough money';
    const v = new RoadVehicle(g, this.nextId++, model, depotId, false);
    v.owner = dp.owner;
    const word = tram ? 'Tram ' : 'Bus ';
    v.name = (dp.owner === 0 ? word : g.company(dp.owner).name.split(' ')[0] + ' ' + word) + v.id;
    this.map.set(v.id, v);
    if (lineId != null) v.setLine(lineId);
    return v;
  }

  resaleValue(v: Vehicle) { return v.value * Math.max(0.1, 0.75 - v.age * 0.06); }

  sell(id: number) {
    const v = this.map.get(id);
    if (!v) return;
    const g = this.game;
    g.company(v.owner).economy.earn(this.resaleValue(v), 'vehicles');
    v.destroy();
    v.dumpCargo();
    const l = v.line;
    if (l) l.vehicles = l.vehicles.filter((x) => x !== id);
    this.map.delete(id);
    g.lines.rebuild();
  }

  /** Month end: operating costs of every vehicle (overheads, crew, energy, maintenance; opcosts.ts). */
  monthly() { chargeVehicles(this.game); }

  yearly() {
    for (const v of this.map.values()) { v.profitLast = v.profitYear; v.profitYear = 0; v.incomeYear = 0; }
  }

  clearAll() {
    this.map.clear();
    this.ambient = [];
    this.res.clear();
  }
}
