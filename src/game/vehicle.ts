// Base vehicle class with passenger handling.
import type { Game } from './game';
import type { Station } from './stations';
import type { Vec3Like } from './geom';

export interface CargoGroup { alight: number; dest: number; count: number; from: number; day: number }

export type VState = 'depot' | 'running' | 'loading' | 'waiting' | 'noroute' | 'stopped';

export const FARE_PER_TILE = 14;

export function fare(dist: number, days: number, count: number): number {
  if (dist < 1) return 0;
  const speed = dist / Math.max(0.4, days); // tiles per day
  const factor = Math.max(0.35, Math.min(1.45, 0.35 + speed / 9));
  return count * dist * FARE_PER_TILE * factor;
}

export abstract class Vehicle {
  readonly id: number;
  owner = 0;
  abstract readonly kind: 'train' | 'road';
  name = '';
  lineId: number | null = null;
  stopIndex = 0;
  cargo = new Map<string, CargoGroup>();
  load = 0;
  state: VState = 'depot';
  status = 'In depot';
  profitYear = 0;
  profitLast = 0;
  incomeYear = 0;
  boughtDay: number;
  value = 0;
  stateTime = 0;
  /** Tile x/z used for camera following when off-map. */
  homeX = 0; homeZ = 0;
  /** Passengers delivered (lifetime) */
  delivered = 0;

  constructor(protected game: Game, id: number) {
    this.id = id;
    this.boughtDay = game.day;
  }

  abstract get capacity(): number;
  /** Max speed in tiles/s */
  abstract get maxSpeed(): number;
  abstract get maxSpeedKmh(): number;
  abstract get runningCost(): number;
  abstract get speedKmh(): number;
  abstract update(dt: number): void;
  abstract worldPos(out: Vec3Like): boolean;
  abstract destroy(): void;
  /** Called when the line's stops changed or a new line was assigned */
  abstract onLineChanged(): void;

  get line() { return this.lineId != null ? this.game.lines.get(this.lineId) ?? null : null; }

  setLine(id: number | null) {
    const g = this.game;
    const old = this.line;
    if (old) old.vehicles = old.vehicles.filter((v) => v !== this.id);
    this.lineId = id;
    const nl = this.line;
    if (nl && !nl.vehicles.includes(this.id)) nl.vehicles.push(this.id);
    this.stopIndex = 0;
    g.lines.rebuild();
    this.onLineChanged();
  }

  targetStation(): Station | null {
    const l = this.line;
    if (!l || l.stops.length === 0) return null;
    if (this.stopIndex >= l.stops.length) this.stopIndex = 0;
    return this.game.stations.get(l.stops[this.stopIndex]) ?? null;
  }

  advanceStop() {
    const l = this.line;
    if (!l || l.stops.length === 0) return;
    this.stopIndex = (this.stopIndex + 1) % l.stops.length;
  }

  /** Unload and load passengers at a station. Returns dwell time in seconds. */
  serveStation(st: Station, perPax: number): number {
    const g = this.game;
    let moved = 0;
    let income = 0;
    const line = this.line;
    for (const [k, c] of this.cargo) {
      if (c.alight !== st.id) continue;
      const from = g.stations.get(c.from);
      const dist = from ? Math.hypot(from.x - st.x, from.z - st.z) : 0;
      income += fare(dist, g.day - c.day, c.count);
      if (c.dest === st.id) {
        st.arrivedMonth += c.count;
        this.delivered += c.count;
        const town = g.towns.list[st.townId];
        if (town) town.passTransMonth += c.count;
      } else {
        const hop = g.lines.nextHop(st.id, c.dest);
        if (hop) g.stations.addWaiting(st, hop.line, hop.alight, c.dest, c.count);
      }
      moved += c.count;
      this.load -= c.count;
      this.cargo.delete(k);
    }
    if (income > 0) {
      g.company(this.owner).economy.earn(income, 'income');
      this.profitYear += income;
      this.incomeYear += income;
      if (line) { line.incomeYear += income; }
      g.onIncome(income, this, st);
    }
    // load
    let picked = 0;
    if (line) {
      for (const [k, wg] of st.waiting) {
        if (wg.line !== line.id) continue;
        const room = this.capacity - this.load;
        if (room <= 0) break;
        const take = Math.min(room, wg.count);
        wg.count -= take;
        st.waitingTotal -= take;
        if (wg.count <= 0) st.waiting.delete(k);
        const ck = st.id + ':' + wg.alight + ':' + wg.dest;
        const cg = this.cargo.get(ck);
        if (cg) {
          cg.day = (cg.day * cg.count + g.day * take) / (cg.count + take);
          cg.count += take;
        } else this.cargo.set(ck, { alight: wg.alight, dest: wg.dest, count: take, from: st.id, day: g.day });
        this.load += take;
        picked += take;
      }
      line.passMonth += picked;
    }
    moved += picked;
    st.pickupMonth += picked;
    st.lastPickup = g.day;
    st.lastSpeed = Math.max(st.lastSpeed * 0.8, this.maxSpeedKmh);
    return 2.0 + moved * perPax;
  }

  /** Re-target passengers whose drop-off stop is no longer on this vehicle's line. */
  fixCargo() {
    const l = this.line;
    if (!l || !l.stops.length) { this.dumpCargo(); return; }
    const stops = new Set(l.stops);
    const next = this.targetStation();
    for (const c of this.cargo.values()) if (!stops.has(c.alight) && next) c.alight = next.id;
  }

  /** Drop all passengers (e.g. when sold or line removed). */
  dumpCargo() { this.cargo.clear(); this.load = 0; }

  get age(): number { return (this.game.day - this.boughtDay) / 360; }
}
