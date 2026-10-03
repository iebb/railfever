// Base vehicle class: passengers (boarding by service pattern, fares with the value of time and a no-transfer
// bonus) and mail (mail.ts: loading, unloading and mail fares), the stop sequence (a vehicle targets only the stops
// of its service pattern) and the odometer for the operating costs (opcosts.ts).
import type { Game } from './game';
import type { Station } from './stations';
import type { Vec3Like } from './geom';
import { fareFor, distanceFare, legacyFare, simNow, NO_TRANSFER_BONUS, WAIT_CAP_HEADWAYS, stationFareContext, type FareMode } from './fares';
import { stopsAt, nextStopIndex, servesStation, boarding, patternHeadway } from './patterns';
import { noteServe, OpCost } from './opcosts';
import { DAY_SECONDS, type Cargo } from './constants';
import { unloadMail, loadMail, fixMail } from './mail';

/**
 * Passengers aboard, by boarding stop / drop-off / destination. `day`: game day they boarded (older saves);
 * `t0`: sim time (s) they started waiting at the boarding stop (the leg's time = wait + ride); `transfers`: how many
 * of them changed vehicles earlier on this journey (the others get the no-transfer bonus at their destination).
 */
export interface CargoGroup { alight: number; dest: number; count: number; from: number; day: number; t0?: number; transfers?: number; rail?: number }
/**
 * Mail aboard, by loading station / drop-off / destination (key from:alight:dest): `count` units (MAIL_UNIT_T); `t0`:
 * sim time (s) the leg began (the mail was posted, or reached the station it was loaded at). See mail.ts.
 */
export interface MailGroup { alight: number; dest: number; count: number; from: number; t0: number }

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
  /** Mail aboard (MailGroup by from:alight:dest), its total and mail delivered (lifetime), in units of MAIL_UNIT_T. */
  mailCargo = new Map<string, MailGroup>();
  mailLoad = 0;
  mailDelivered = 0;
  /** seconds this vehicle has held at its stop for a faster train to pass (patterns.ts holdForOvertake) */
  holdTime = 0;
  /** Hold/boarding clocks and the stop awaiting an actual departure (persisted by save.ts). */
  spacing = { until: -1, boardIn: 0, departureIndex: -1 };
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
  /** Room for mail (units of MAIL_UNIT_T; 0: carries none). */
  abstract get mailCapacity(): number;
  /** No seats and room for mail: a mail van or truck, a mail train, the postal unit (Cargo 'mail' only). */
  get mailOnly(): boolean { return this.capacity === 0 && this.mailCapacity > 0; }
  /** Does the vehicle carry this cargo? Passengers: every vehicle but a mail-only one (a lone locomotive too). */
  carries(cargo: Cargo): boolean { return cargo === 'mail' ? this.mailCapacity > 0 : !this.mailOnly; }
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
    this.resetSpacing();
    g.lines.rebuild(false);
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

  resetSpacing() { this.spacing.until = -1; this.spacing.boardIn = 0; this.spacing.departureIndex = -1; }

  restoreSpacing(d?: { until: number; boardIn: number; departureIndex?: number }) {
    this.spacing = { until: Number.isFinite(d?.until) ? d!.until : -1, boardIn: Number.isFinite(d?.boardIn) ? d!.boardIn : 0,
      departureIndex: Number.isInteger(d?.departureIndex) ? d!.departureIndex! : -1 };
  }

  /** Ending a dwell requests departure; the clock is committed only when the vehicle actually moves. */
  queueSpacingDeparture() {
    this.resetSpacing();
    this.spacing.departureIndex = this.stopIndex;
  }

  /** Board during a hold without recording another arrival, unloading or charging fares again. */
  continueBoarding(dt: number) {
    this.spacing.boardIn -= dt;
    if (this.spacing.boardIn > 0) return;
    this.spacing.boardIn = 1;
    const st = this.targetStation();
    if (st) {
      this.boardStation(st);
      if (this.mailCapacity > 0) loadMail(this.game, this, st);
    }
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
      // one rail fare whatever the track or station style; road vehicles: tram or bus fares
      const mode: FareMode = this.kind === 'road' ? (line?.kind === 'tram' ? 'tram' : 'bus') : 'rail';
      // the rail minimum once per journey: the distance fares of their earlier rail legs count towards it
      const ctx = stationFareContext(g, from, st, mode), before = c.rail ?? 0;
      let f = fareFor(dist, leg, c.count, mode === 'rail' && before > 0 ? { ...ctx, railBefore: before } : ctx);
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
        const rail = mode === 'rail' ? before + distanceFare(dist) : before;
        if (hop) g.lines.distribute(hop, c.count, (line, n) => g.stations.addWaiting(st, line, hop.alight, c.dest, n, 0, now, n, rail));
      }
      moved += c.count;
      this.load -= c.count;
      this.cargo.delete(k);
    }
    if (income > 0) {
      g.company(this.owner).economy.earn(income, 'income');
      this.profitYear += income;
      this.incomeYear += income;
      if (line) {
        line.incomeYear += income;
        if (line.kind === 'rail') g.ais.find((a) => a.companyId === this.owner)?.railPolicy.operating(line.id, income);
      }
      g.onIncome(income, this, st);
    }
    // mail: off (delivered, or waiting for its next leg), then on; handling a unit of mail takes 1.5 x a passenger
    const mailOff = this.mailCargo.size ? unloadMail(g, this, st, now) : 0;
    moved += this.boardStation(st);
    const mailMoved = mailOff + (this.mailCapacity > 0 ? loadMail(g, this, st) : 0);
    return 2.0 + (mailMoved > 0 ? Math.max(moved * perPax, mailMoved * perPax * 1.5) : moved * perPax);
  }

  /** Boarding is shared by the arrival dwell and headway holds. Returns passengers picked up. */
  private boardStation(st: Station): number {
    const g = this.game, now = simNow(g), line = this.line;
    // a mail-only vehicle takes no passengers; its call still counts as service (town growth: Station.lastCall)
    if (this.mailOnly) { st.lastCall = g.day; return 0; }
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
          if (cg.rail || wg.rail) cg.rail = ((cg.rail ?? 0) * cg.count + (wg.rail ?? 0) * take) / (cg.count + take);
          cg.count += take;
        } else this.cargo.set(ck, wg.rail ? { alight: wg.alight, dest: wg.dest, count: take, from: st.id, day: g.day, t0, transfers: tr, rail: wg.rail }
          : { alight: wg.alight, dest: wg.dest, count: take, from: st.id, day: g.day, t0, transfers: tr });
        this.load += take;
        picked += take;
      }
      line.passMonth += picked;
    }
    st.pickupMonth += picked;
    st.lastPickup = g.day;
    st.lastCall = g.day;
    st.lastSpeed = Math.max(st.lastSpeed * 0.8, this.maxSpeedKmh);
    return picked;
  }

  /** Re-target passengers and mail whose drop-off stop is no longer served by this vehicle (line or pattern changed). */
  fixCargo() {
    const l = this.line;
    if (!l || !l.stops.length) { this.dumpCargo(); return; }
    const next = this.targetStation();
    for (const c of this.cargo.values()) if (!servesStation(l, this.pattern, c.alight) && next) c.alight = next.id;
    if (this.mailCargo.size) fixMail(this, l, next);
  }

  /** Drop all passengers and mail (e.g. when sold or line removed). */
  dumpCargo() {
    this.cargo.clear(); this.load = 0;
    if (this.mailCargo.size || this.mailLoad) { this.mailCargo.clear(); this.mailLoad = 0; }
  }

  get age(): number { return (this.game.day - this.boughtDay) / 360; }
}
