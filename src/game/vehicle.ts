// Base vehicle class: passengers (boarding by service pattern, fares with the value of time and a no-transfer
// bonus), the stop sequence (a vehicle targets only the stops of its service pattern) and the odometer for the
// operating costs (opcosts.ts).
import type { Game } from './game';
import type { Station } from './stations';
import type { Vec3Like } from './geom';
import { fareFor, legacyFare, simNow, NO_TRANSFER_BONUS, WAIT_CAP_HEADWAYS, stationFareContext, type UrbanMode } from './fares';
import { stopsAt, nextStopIndex, servesStation, boarding, patternHeadway } from './patterns';
import { noteServe, OpCost } from './opcosts';
import { DAY_SECONDS } from './constants';

/**
 * Passengers aboard, by boarding stop / drop-off / destination. `day`: game day they boarded (older saves);
 * `t0`: sim time (s) they started waiting at the boarding stop (the leg's time = wait + ride); `transfers`: how many
 * of them changed vehicles earlier on this journey (the others get the no-transfer bonus at their destination).
 */
export interface CargoGroup { alight: number; dest: number; count: number; from: number; day: number; t0?: number; transfers?: number }

export type VState = 'depot' | 'running' | 'loading' | 'waiting' | 'noroute' | 'stopped';

/** Fare per world unit (v2.2 distance fares; see fares.ts FARE_RATE for the current rate). */
export const FARE_PER_TILE = 9.5;

/**
 * Legacy fare (v2.2 signature, kept for callers such as AI estimates): `count` passengers carried `dist` units
 * (straight line) in `days` game days aboard. See fares.ts fareFor / estimateLegFare.
 */
export function fare(dist: number, days: number, count: number): number { return legacyFare(dist, days, count); }

export abstract class Vehicle {
  readonly id: number;
  owner = 0;
  abstract readonly kind: 'train' | 'road';
  name = '';
  lineId: number | null = null;
  stopIndex = 0;
  /** service pattern (patterns.ts; an id of Line.patterns), unset: the line's first pattern */
  pattern?: number;
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
  /** seconds this vehicle has held at its stop for a faster train to pass (patterns.ts holdForOvertake) */
  holdTime = 0;
  /**
   * Odometer for the operating costs (opcosts.ts), since the last monthly charge: seconds in service, distance
   * (units) and energy estimates (J at the wheels, dissipated braking) of the hops between stops; the sim time of
   * the last accounting point while in service (-1: not in service) and the last station served.
   */
  opSec = 0; opDist = 0; opJ = 0; opBrakeJ = 0; opMark = -1; opLastSt = -1;
  /** last month's operating costs (opcosts.ts) */
  opLast: OpCost | null = null;

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
    // a line merged into another as a service pattern (canonicalizeLines): the vehicle runs that pattern
    const rd = id != null && !g.lines.map.has(id) ? g.lines.redirect.get(id) : undefined;
    if (rd && g.lines.map.has(rd.line)) id = rd.line;
    if (!old || old.id !== id) this.pattern = rd ? rd.pattern : undefined;
    this.lineId = id;
    const nl = this.line;
    if (nl && !nl.vehicles.includes(this.id)) nl.vehicles.push(this.id);
    this.stopIndex = 0;
    g.lines.rebuild();
    this.onLineChanged();
  }

  /** The stop the vehicle heads for: the current stop of its line, moved on to one its pattern serves. */
  targetStation(): Station | null {
    const l = this.line;
    if (!l || l.stops.length === 0) return null;
    if (this.stopIndex >= l.stops.length || this.stopIndex < 0) this.stopIndex = 0;
    if (!stopsAt(l, this.pattern, this.stopIndex)) this.stopIndex = nextStopIndex(l, this.pattern, this.stopIndex);
    return this.game.stations.get(l.stops[this.stopIndex]) ?? null;
  }

  /** On to the next stop of the vehicle's pattern (stops it does not serve are passed). */
  advanceStop() {
    const l = this.line;
    if (!l || l.stops.length === 0) return;
    this.stopIndex = nextStopIndex(l, this.pattern, this.stopIndex % l.stops.length);
  }

  /** Unload and load passengers at a station. Returns dwell time in seconds. */
  serveStation(st: Station, perPax: number): number {
    const g = this.game;
    const now = simNow(g);
    let moved = 0;
    let income = 0;
    const line = this.line;
    g.recordStop(this, st);
    // odometer (the hop just run, with the load it carried)
    noteServe(g, this, st.id, st.x, st.z);
    for (const [k, c] of this.cargo) {
      if (c.alight !== st.id) continue;
      const from = g.stations.get(c.from);
      const dist = from ? Math.hypot(from.x - st.x, from.z - st.z) : 0;
      // the leg's time: waiting at the boarding stop and riding (older saves: the ride since boarding)
      const leg = now - (c.t0 ?? c.day * DAY_SECONDS);
      const track = from?.rail?.trackType;
      const mode: UrbanMode | undefined = this.kind === 'road' ? (line?.kind === 'tram' ? 'tram' : 'bus')
        : track === 'metro' || track === 'lightrail' ? track : undefined;
      let f = fareFor(dist, leg, c.count, stationFareContext(g, from, st, mode));
      const tr = Math.min(c.count, Math.max(0, c.transfers ?? 0));
      if (c.dest === st.id && tr < c.count) f *= 1 + (NO_TRANSFER_BONUS * (c.count - tr)) / c.count;
      income += f;
      if (c.dest === st.id) {
        st.arrivedMonth += c.count;
        this.delivered += c.count;
        const town = g.towns.list[st.townId];
        if (town) town.passTransMonth += c.count;
      } else {
        // changing here: they wait for their next leg (all of them have transferred now)
        const hop = g.lines.nextHop(st.id, c.dest);
        if (hop) g.lines.distribute(hop, c.count, (line, n) => g.stations.addWaiting(st, line, hop.alight, c.dest, n, 0, now, n));
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
    // load: passengers for stops this vehicle's pattern serves (and for which it is a service worth taking)
    let picked = 0;
    if (line) {
      const may = boarding(g, line, this.pattern, this.stopIndex, st.id);
      // the wait a leg counts: at most WAIT_CAP_HEADWAYS of this service's headway (a backlog is lost demand)
      const hw = patternHeadway(g, line, this.pattern);
      const earliest = hw > 0 ? now - WAIT_CAP_HEADWAYS * hw : -Infinity;
      for (const [k, wg] of st.waiting) {
        if (wg.line !== line.id) continue;
        const room = this.capacity - this.load;
        if (room <= 0) break;
        if (!may(wg.alight)) continue;
        const take = Math.min(room, wg.count);
        const t0 = Math.max(wg.t ?? now, earliest);
        const tr = wg.count > 0 ? ((wg.transfers ?? 0) * take) / wg.count : 0;
        wg.count -= take;
        if (wg.transfers) wg.transfers = Math.max(0, wg.transfers - tr);
        st.waitingTotal -= take;
        if (wg.count <= 0) st.waiting.delete(k);
        const ck = st.id + ':' + wg.alight + ':' + wg.dest;
        const cg = this.cargo.get(ck);
        if (cg) {
          cg.day = (cg.day * cg.count + g.day * take) / (cg.count + take);
          cg.t0 = ((cg.t0 ?? now) * cg.count + t0 * take) / (cg.count + take);
          cg.transfers = (cg.transfers ?? 0) + tr;
          cg.count += take;
        } else this.cargo.set(ck, { alight: wg.alight, dest: wg.dest, count: take, from: st.id, day: g.day, t0, transfers: tr });
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

  /** Re-target passengers whose drop-off stop is no longer served by this vehicle (line or pattern changed). */
  fixCargo() {
    const l = this.line;
    if (!l || !l.stops.length) { this.dumpCargo(); return; }
    const next = this.targetStation();
    for (const c of this.cargo.values()) if (!servesStation(l, this.pattern, c.alight) && next) c.alight = next.id;
  }

  /** Drop all passengers (e.g. when sold or line removed). */
  dumpCargo() { this.cargo.clear(); this.load = 0; }

  get age(): number { return (this.game.day - this.boughtDay) / 360; }
}
