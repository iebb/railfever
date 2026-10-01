// Vehicle manager: ownership, reservations, spatial hash, purchases and ambient traffic.
import type { Game } from './game';
import { Vehicle } from './vehicle';
import { Train, CROSS_BASE } from './train';
import { RoadVehicle, RSeg, makeLaneSeg, connsConflict } from './roadvehicle';
import { VehicleModel } from './vehicle-types';
import { RNG } from './rng';
import type { NEdge } from './network';
import { closestOnPolyline } from './geom';

const segKey = (s: RSeg) => (s.kind === 'lane' ? s.e * 2 + (s.dir > 0 ? 1 : 0) : -(s.node + 1));

export class Vehicles {
  map = new Map<number, Vehicle>();
  nextId = 1;
  ambient: RoadVehicle[] = [];
  nextAmbientId = 1_000_000;
  private res = new Map<number, number>();
  /** level crossings currently closed for road traffic */
  crossingClosed = new Set<number>();
  roadHash = new Map<number, RoadVehicle[]>();
  private rng = new RNG(4242);
  ambientEnabled = true;
  private ambientTimer = 0;

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
  }

  // ---------------------------------------------------------------- road spatial hash
  private rebuildHash() {
    this.roadHash.clear();
    const put = (k: number, v: RoadVehicle) => {
      let a = this.roadHash.get(k);
      if (!a) { a = []; this.roadHash.set(k, a); }
      if (!a.includes(v)) a.push(v);
    };
    const add = (v: RoadVehicle) => {
      if (!v.seg) return;
      put(segKey(v.seg), v);
      let rem = v.length - v.pos;
      for (const t of v.trail) {
        if (rem <= 0) break;
        put(segKey(t), v);
        rem -= t.len;
      }
    };
    for (const v of this.map.values()) if (v instanceof RoadVehicle) add(v);
    for (const v of this.ambient) add(v);
  }

  private tA = { x: 0, y: 0, z: 0 };
  private tB = { x: 0, y: 0, z: 0 };
  private tD = { x: 0, y: 0, z: 0 };
  private tE = { x: 0, y: 0, z: 0 };

  /** Distance to the rear of the nearest vehicle ahead in the same lane, or Infinity. */
  gapAhead(v: RoadVehicle, look: number): number {
    if (!v.seg) return Infinity;
    const p = this.tA, d = this.tD;
    v.pointBehind(0, p, d);
    const dl = Math.hypot(d.x, d.z) || 1;
    const dx = d.x / dl, dz = d.z / dl;
    const keys = [segKey(v.seg)];
    for (let i = 0; i < Math.min(3, v.ahead.length); i++) keys.push(segKey(v.ahead[i]));
    let best = Infinity;
    const q = this.tB, qd = this.tE;
    const seen = new Set<RoadVehicle>();
    for (const k of keys) {
      const list = this.roadHash.get(k);
      if (!list) continue;
      for (const o of list) {
        if (o === v || !o.seg || seen.has(o)) continue;
        seen.add(o);
        o.pointBehind(o.length, q, qd);
        const rx = q.x - p.x, rz = q.z - p.z;
        const along = rx * dx + rz * dz;
        if (along <= -0.05 || along > look) continue;
        const lat = Math.abs(rx * dz - rz * dx);
        if (lat > 0.11) continue;
        const ql = Math.hypot(qd.x, qd.z) || 1;
        if ((qd.x * dx + qd.z * dz) / ql < 0.2) continue;
        if (along < best) best = along;
      }
    }
    return best;
  }

  /** May v enter connector c (no conflicting vehicle inside the junction)? */
  junctionFree(v: RoadVehicle, c: RSeg): boolean {
    const list = this.roadHash.get(-(c.node + 1));
    if (!list) return true;
    for (const o of list) {
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
    for (const k of [eid * 2, eid * 2 + 1]) {
      const list = this.roadHash.get(k);
      if (!list) continue;
      for (const v of list) {
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
  update(dt: number) {
    this.rebuildHash();
    this.updateCrossings();
    for (const v of this.map.values()) v.update(dt);
    if (this.ambientEnabled) {
      for (const a of this.ambient) a.update(dt);
      this.ambient = this.ambient.filter((a) => a.state !== 'stopped' && a.seg);
      this.ambientTimer -= dt;
      if (this.ambientTimer <= 0) { this.ambientTimer = 8; this.manageAmbient(); }
    } else if (this.ambient.length) this.ambient = [];
    this.rebuildHash();
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
        have++; budget--;
      }
    }
  }

  // ---------------------------------------------------------------- purchase
  buyTrain(depotId: number, cars: VehicleModel[], lineId: number | null): Train | string {
    const g = this.game;
    const dp = g.depots.get(depotId);
    if (!dp || dp.kind !== 'rail') return 'Invalid depot';
    if (!cars.length || cars[0].kind !== 'loco') return 'A train needs a locomotive';
    const cost = cars.reduce((s, c) => s + c.cost, 0);
    if (!g.company(dp.owner).economy.spend(cost, 'vehicles')) return 'Not enough money';
    const t = new Train(g, this.nextId++, cars, depotId);
    t.owner = dp.owner;
    t.name = (dp.owner === 0 ? 'Train ' : g.company(dp.owner).name.split(' ')[0] + ' Train ') + t.id;
    this.map.set(t.id, t);
    if (lineId != null) t.setLine(lineId);
    return t;
  }

  buyRoad(depotId: number, model: VehicleModel, lineId: number | null): RoadVehicle | string {
    const g = this.game;
    const dp = g.depots.get(depotId);
    if (!dp || dp.kind !== 'road') return 'Invalid depot';
    if (!g.company(dp.owner).economy.spend(model.cost, 'vehicles')) return 'Not enough money';
    const v = new RoadVehicle(g, this.nextId++, model, depotId, false);
    v.owner = dp.owner;
    v.name = (dp.owner === 0 ? 'Bus ' : g.company(dp.owner).name.split(' ')[0] + ' Bus ') + v.id;
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

  monthly() {
    const g = this.game;
    for (const v of this.map.values()) {
      const c = v.runningCost / 12;
      g.company(v.owner).economy.spend(c, 'running', true);
      v.profitYear -= c;
      const l = v.line;
      if (l) l.costYear += c;
    }
  }

  yearly() {
    for (const v of this.map.values()) { v.profitLast = v.profitYear; v.profitYear = 0; v.incomeYear = 0; }
  }

  clearAll() {
    this.map.clear();
    this.ambient = [];
    this.res.clear();
  }
}
