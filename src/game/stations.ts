// Stations: parts, catchment areas, ratings and waiting passengers.
import type { Game } from './game';
import { STATION_RADIUS_BUS, STATION_RADIUS_RAIL } from './constants';

export interface WaitGroup { line: number; alight: number; dest: number; count: number }

export interface Station {
  id: number;
  name: string;
  townId: number;
  x: number; z: number;
  tiles: number[];
  waiting: Map<string, WaitGroup>;
  waitingTotal: number;
  rating: number;
  lastPickup: number;
  lastSpeed: number;
  catchPop: number;
  genAccum: number;
  genMonth: number; genLast: number;
  pickupMonth: number; pickupLast: number;
  arrivedMonth: number; arrivedLast: number;
  built: number;
}

const SUFFIXES = ['Central', 'North', 'South', 'East', 'West', 'Park', 'Market', 'Bridge', 'Heights', 'Square', 'Junction', 'Gardens', 'Cross', 'Halt'];

export class Stations {
  map = new Map<number, Station>();
  nextId = 1;
  constructor(private game: Game) {}

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  create(x: number, z: number): Station {
    const g = this.game;
    const town = g.towns.nearest(x, z);
    const used = new Set([...this.map.values()].map((s) => s.name));
    let name = town ? town.name : 'Station';
    if (used.has(name)) {
      let dirName = '';
      if (town) {
        const dx = x - town.x, dz = z - town.z;
        if (Math.hypot(dx, dz) < 3) dirName = 'Central';
        else if (Math.abs(dx) > Math.abs(dz)) dirName = dx > 0 ? 'East' : 'West';
        else dirName = dz > 0 ? 'South' : 'North';
      }
      const tries = [dirName, ...SUFFIXES].filter(Boolean);
      name = '';
      for (const s of tries) { const n = `${town ? town.name : 'Station'} ${s}`; if (!used.has(n)) { name = n; break; } }
      if (!name) name = `${town ? town.name : 'Station'} ${this.nextId}`;
    }
    const st: Station = {
      id: this.nextId++, name, townId: town ? town.id : -1, x, z, tiles: [],
      waiting: new Map(), waitingTotal: 0, rating: 0.65, lastPickup: g.day, lastSpeed: 0,
      catchPop: 0, genAccum: 0, genMonth: 0, genLast: 0, pickupMonth: 0, pickupLast: 0, arrivedMonth: 0, arrivedLast: 0,
      built: g.day,
    };
    this.map.set(st.id, st);
    return st;
  }

  /** Find a station with a tile within `dist` (Chebyshev) of the given rectangle. */
  findNear(x0: number, z0: number, x1: number, z1: number, dist: number): Station | null {
    const w = this.game.world;
    for (let z = z0 - dist; z <= z1 + dist; z++) for (let x = x0 - dist; x <= x1 + dist; x++) {
      if (!w.inBounds(x, z)) continue;
      const s = w.station[w.idx(x, z)];
      if (s >= 0) return this.map.get(s) ?? null;
    }
    return null;
  }

  addTile(st: Station, t: number, kind: 1 | 2) {
    const w = this.game.world;
    w.station[t] = st.id;
    w.stationKind[t] = kind;
    st.tiles.push(t);
    this.updateSign(st);
    w.markTile(w.tx(t), w.tz(t));
  }

  removeTile(t: number) {
    const w = this.game.world;
    const id = w.station[t];
    if (id < 0) return;
    const st = this.map.get(id);
    w.station[t] = -1;
    w.stationKind[t] = 0;
    w.markTile(w.tx(t), w.tz(t));
    if (!st) return;
    st.tiles = st.tiles.filter((x) => x !== t);
    if (st.tiles.length === 0) this.deleteStation(st.id);
    else this.updateSign(st);
  }

  deleteStation(id: number) {
    this.map.delete(id);
    this.game.lines.onStationRemoved(id);
  }

  updateSign(st: Station) {
    const w = this.game.world;
    let sx = 0, sz = 0;
    for (const t of st.tiles) { sx += w.tx(t); sz += w.tz(t); }
    st.x = sx / st.tiles.length;
    st.z = sz / st.tiles.length;
  }

  hasRail(st: Station) { const w = this.game.world; return st.tiles.some((t) => w.stationKind[t] === 1); }
  hasRoad(st: Station) { const w = this.game.world; return st.tiles.some((t) => w.stationKind[t] === 2); }

  /** Tiles covered by a station's catchment. */
  catchmentTiles(st: Station): Set<number> {
    const w = this.game.world;
    const out = new Set<number>();
    for (const t of st.tiles) {
      const r = w.stationKind[t] === 1 ? STATION_RADIUS_RAIL : STATION_RADIUS_BUS;
      const x0 = w.tx(t), z0 = w.tz(t);
      for (let z = z0 - r; z <= z0 + r; z++) for (let x = x0 - r; x <= x0 + r; x++) {
        if (w.inBounds(x, z)) out.add(w.idx(x, z));
      }
    }
    return out;
  }

  /** Recompute catchment population of every station, sharing buildings between stations by rating. */
  recomputeCatchment() {
    const w = this.game.world;
    const cover = new Map<number, Station[]>();
    for (const st of this.map.values()) {
      st.catchPop = 0;
      const active = this.game.lines.stationServed(st.id);
      for (const t of this.catchmentTiles(st)) {
        const b = w.building[t];
        if (b < 0) continue;
        let arr = cover.get(b);
        if (!arr) { arr = []; cover.set(b, arr); }
        if (!arr.includes(st)) arr.push(st);
      }
      (st as any)._active = active;
    }
    for (const [bid, arr] of cover) {
      const b = w.buildings[bid];
      if (!b) continue;
      const act = arr.filter((s) => (s as any)._active);
      const list = act.length ? act : arr;
      let sum = 0;
      for (const s of list) sum += s.rating + 0.05;
      for (const s of list) s.catchPop += (b.pop * (s.rating + 0.05)) / sum;
    }
  }

  addWaiting(st: Station, line: number, alight: number, dest: number, count: number) {
    if (count <= 0) return;
    const key = line + ':' + alight + ':' + dest;
    const g = st.waiting.get(key);
    if (g) g.count += count;
    else st.waiting.set(key, { line, alight, dest, count });
    st.waitingTotal += count;
  }

  /** Remove passengers (e.g. on overflow) proportionally. */
  trimWaiting(st: Station, max: number) {
    if (st.waitingTotal <= max) return;
    const f = max / st.waitingTotal;
    let tot = 0;
    for (const [k, g] of st.waiting) {
      g.count = Math.floor(g.count * f);
      if (g.count <= 0) st.waiting.delete(k); else tot += g.count;
    }
    st.waitingTotal = tot;
  }

  /** Re-assign waiting passengers after routing changes. */
  rerouteWaiting(st: Station) {
    const lines = this.game.lines;
    const old = [...st.waiting.values()];
    st.waiting.clear();
    st.waitingTotal = 0;
    for (const g of old) {
      const hop = lines.nextHop(st.id, g.dest);
      if (hop) this.addWaiting(st, hop.line, hop.alight, g.dest, g.count);
    }
  }
}
