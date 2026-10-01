// Vehicle manager: ownership, reservations, spatial hash, purchases and ambient traffic.
import type { Game } from './game';
import { Vehicle } from './vehicle';
import { Train } from './train';
import { RoadVehicle } from './roadvehicle';
import { VehicleModel } from './vehicle-types';
import { RNG } from './rng';

export class Vehicles {
  map = new Map<number, Vehicle>();
  nextId = 1;
  ambient: RoadVehicle[] = [];
  nextAmbientId = 1_000_000;
  readonly tileCount: number;
  private resv: Int32Array;
  private structRes = new Map<number, number>();
  roadHash = new Map<number, RoadVehicle[]>();
  private rng = new RNG(4242);
  ambientEnabled = true;

  constructor(private game: Game) {
    const s = game.world.size;
    this.tileCount = s * s;
    this.resv = new Int32Array(this.tileCount);
  }

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }
  trains(): Train[] { return [...this.map.values()].filter((v): v is Train => v.kind === 'train'); }
  roads(): RoadVehicle[] { return [...this.map.values()].filter((v): v is RoadVehicle => v.kind === 'road'); }

  // ---------------------------------------------------------------- reservations
  getRes(r: number): number {
    if (r < this.tileCount) return this.resv[r];
    return this.structRes.get(r) ?? 0;
  }
  setRes(r: number, id: number) {
    if (r < this.tileCount) this.resv[r] = id;
    else this.structRes.set(r, id);
  }
  releaseRes(r: number, id: number) {
    if (r < this.tileCount) { if (this.resv[r] === id) this.resv[r] = 0; }
    else if (this.structRes.get(r) === id) this.structRes.delete(r);
  }
  roadsOn(t: number): RoadVehicle[] { return this.roadHash.get(t) ?? []; }
  roadBusy(t: number): boolean { return (this.roadHash.get(t)?.length ?? 0) > 0; }

  /** Busy with a train or a company vehicle (ambient traffic does not block construction). */
  isTileBusy(t: number): boolean {
    if (this.resv[t] !== 0) return true;
    const list = this.roadHash.get(t);
    if (list) for (const v of list) if (!v.ambient) return true;
    // a train still partly inside a depot
    for (const v of this.map.values()) if (v.kind === 'train' && (v as Train).segs.some((s) => s.sid === -2 && s.t === t)) return true;
    return false;
  }

  /** Remove ambient cars standing on tiles that lost their road. */
  pruneAmbient() {
    const w = this.game.world;
    this.ambient = this.ambient.filter((a) => {
      if (!a.seg) return false;
      if (a.seg.sid === -1 && !w.road[a.seg.t]) return false;
      if (a.seg.sid >= 0 && !w.structures.has(a.seg.sid)) return false;
      if (a.prev && a.prev.sid >= 0 && !w.structures.has(a.prev.sid)) a.prev = null;
      a.route = [];
      return true;
    });
  }
  isStructureBusy(sid: number): boolean {
    if (this.structRes.has(this.tileCount + sid)) return true;
    for (const v of this.map.values()) {
      if (v.kind !== 'road') continue;
      const r = v as RoadVehicle;
      if (r.seg?.sid === sid || r.prev?.sid === sid || r.route.some((s) => s.sid === sid)) return true;
    }
    return false;
  }

  // ---------------------------------------------------------------- road following
  private rebuildHash() {
    this.roadHash.clear();
    const add = (v: RoadVehicle) => {
      if (!v.seg) return;
      const t = v.seg.t;
      let a = this.roadHash.get(t);
      if (!a) { a = []; this.roadHash.set(t, a); }
      a.push(v);
      if (v.prev && v.prev.t !== t && v.pos < v.length) {
        let b = this.roadHash.get(v.prev.t);
        if (!b) { b = []; this.roadHash.set(v.prev.t, b); }
        b.push(v);
      }
    };
    for (const v of this.map.values()) if (v.kind === 'road') add(v as RoadVehicle);
    for (const v of this.ambient) add(v);
  }

  private tmpA = { x: 0, y: 0, z: 0 };
  private tmpB = { x: 0, y: 0, z: 0 };
  private tmpD = { x: 0, y: 0, z: 0 };
  private tmpE = { x: 0, y: 0, z: 0 };

  /** Distance to the rear of the nearest vehicle ahead in the same lane, or Infinity. */
  gapAhead(v: RoadVehicle, look: number): number {
    if (!v.seg) return Infinity;
    const p = this.tmpA, d = this.tmpD;
    v.pointBehind(0, p, d);
    const tiles = [v.seg.t];
    for (let i = 0; i < Math.min(3, v.route.length); i++) if (!tiles.includes(v.route[i].t)) tiles.push(v.route[i].t);
    let best = Infinity;
    const q = this.tmpB, qd = this.tmpE;
    for (const t of tiles) {
      const list = this.roadHash.get(t);
      if (!list) continue;
      for (const o of list) {
        if (o === v || !o.seg) continue;
        o.pointBehind(o.length, q, qd); // rear of other vehicle
        const rx = q.x - p.x, rz = q.z - p.z;
        const along = rx * d.x + rz * d.z;
        if (along <= -0.05 || along > look) continue;
        const lat = Math.abs(rx * d.z - rz * d.x);
        if (lat > 0.085) continue;
        if (qd.x * d.x + qd.z * d.z < 0.2) continue;
        if (along < best) best = along;
      }
    }
    return best;
  }

  // ---------------------------------------------------------------- update
  update(dt: number) {
    this.rebuildHash();
    for (const v of this.map.values()) v.update(dt);
    if (this.ambientEnabled) {
      for (const a of this.ambient) a.update(dt);
      this.ambient = this.ambient.filter((a) => a.state !== 'stopped' && a.seg);
    }
    // keep the spatial index current for queries made between ticks (construction checks)
    this.rebuildHash();
  }

  /** Keep the ambient traffic population in line with town sizes. */
  manageAmbient() {
    if (!this.ambientEnabled) { this.ambient = []; return; }
    const g = this.game;
    const w = g.world;
    const byTown = new Map<number, number>();
    for (const a of this.ambient) {
      const t = a.seg ? a.seg.t : -1;
      const town = t >= 0 ? w.townOf[t] : -1;
      byTown.set(town, (byTown.get(town) ?? 0) + 1);
    }
    let budget = 260 - this.ambient.length;
    for (const town of g.towns.list) {
      const want = Math.min(28, Math.floor(town.pop / 140));
      let have = byTown.get(town.id) ?? 0;
      let tries = 0;
      while (have < want && budget > 0 && tries++ < 20) {
        if (!town.roads.length) break;
        const t = town.roads[this.rng.int(town.roads.length)];
        const m = w.road[t];
        if (!m || w.station[t] >= 0 || this.roadBusy(t)) continue;
        const edges: number[] = [];
        for (let e = 0; e < 4; e++) if (m & (1 << e)) edges.push(e);
        const e = edges[this.rng.int(edges.length)];
        const v = new RoadVehicle(g, this.nextAmbientId++, null, -1, true, this.rng.int(1e9));
        v.placeAt(t, e);
        this.ambient.push(v);
        have++; budget--;
      }
    }
  }

  // ---------------------------------------------------------------- purchase
  buyTrain(depotId: number, cars: VehicleModel[], lineId: number | null): Train | string {
    const g = this.game;
    const dp = g.world.depots.get(depotId);
    if (!dp || dp.kind !== 'rail') return 'Invalid depot';
    if (!cars.length || cars[0].kind !== 'loco') return 'A train needs a locomotive';
    const cost = cars.reduce((s, c) => s + c.cost, 0);
    if (!g.economy.spend(cost, 'vehicles')) return 'Not enough money';
    const t = new Train(g, this.nextId++, cars, depotId);
    t.name = 'Train ' + t.id;
    this.map.set(t.id, t);
    if (lineId != null) t.setLine(lineId);
    return t;
  }

  buyRoad(depotId: number, model: VehicleModel, lineId: number | null): RoadVehicle | string {
    const g = this.game;
    const dp = g.world.depots.get(depotId);
    if (!dp || dp.kind !== 'road') return 'Invalid depot';
    if (!g.economy.spend(model.cost, 'vehicles')) return 'Not enough money';
    const v = new RoadVehicle(g, this.nextId++, model, depotId, false);
    v.name = 'Bus ' + v.id;
    this.map.set(v.id, v);
    if (lineId != null) v.setLine(lineId);
    return v;
  }

  sell(id: number) {
    const v = this.map.get(id);
    if (!v) return;
    const g = this.game;
    const resale = v.value * Math.max(0.1, 0.75 - v.age * 0.06);
    g.economy.earn(resale, 'vehicles');
    v.destroy();
    v.dumpCargo();
    const l = v.line;
    if (l) l.vehicles = l.vehicles.filter((x) => x !== id);
    this.map.delete(id);
    g.lines.rebuild();
  }

  resaleValue(v: Vehicle) { return v.value * Math.max(0.1, 0.75 - v.age * 0.06); }

  monthly() {
    const g = this.game;
    for (const v of this.map.values()) {
      const c = v.runningCost / 12;
      g.economy.spend(c, 'running', true);
      v.profitYear -= c;
      const l = v.line;
      if (l) l.costYear += c;
    }
    this.manageAmbient();
  }

  yearly() {
    for (const v of this.map.values()) { v.profitLast = v.profitYear; v.profitYear = 0; v.incomeYear = 0; }
  }

  clearAll() {
    this.map.clear();
    this.ambient = [];
    this.resv.fill(0);
    this.structRes.clear();
  }
}
