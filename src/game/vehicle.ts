// Base vehicle class: passengers (boarding by service pattern, fares with the value of time, less after each change
// of vehicle) and mail (mail.ts: loading, unloading and mail fares), the stop sequence (a vehicle targets only the
// stops of its service pattern) and the odometer for the operating costs (opcosts.ts).
import type { Game } from './game';
import type { Station } from './stations';
import { WALK_LINE } from './stations';
import type { Vec3Like } from './geom';
import { fareFor, distanceFare, legacyFare, simNow, fareGroupKey, railHistory, changeClass, transferFareFactor, WAIT_CAP_HEADWAYS, stationFareContext, type FareMode } from './fares';
import { stopsAt, nextStopIndex, servesStation, boarding, patternHeadway, patternOf } from './patterns';
import { noteServe, OpCost } from './opcosts';
import { DAY_SECONDS, type Cargo } from './constants';
import { unloadMail, loadMail, fixMail, type MailLeg } from './mail';

/**
 * Passengers aboard, by boarding stop / drop-off / destination. `day`: game day they boarded (older saves);
 * `t0`: sim time (s) they started waiting at the boarding stop (the leg's time = wait + ride); `transfers`: the changes
 * of vehicle they made earlier on this journey, in all (transfers / count each: each change takes 10% off the leg
 * ending in it and every later leg); `rail`: their rail fares so far (fares.ts railHistory); `ic`: 1 for an inter-city
 * trip, absent for a city trip (fares.ts setFlag). Groups never mix different fare histories, change classes or demand
 * sets (fares.ts fareGroupKey).
 */
export interface CargoGroup { alight: number; dest: number; count: number; from: number; day: number; t0?: number; transfers?: number; rail?: number; ic?: number }
/**
 * Mail aboard, by loading station / drop-off / destination / origin (key from:alight:dest:o): `count` units
 * (MAIL_UNIT_T) and their journey (mail.ts MailJourney: origin `o`, its distance `od` to the destination, posting time
 * `p`, changes `c`, earlier `legs`).
 */
export interface MailGroup { alight: number; dest: number; count: number; from: number; o: number; od: number; p: number; c: number; legs: MailLeg[] }

/** Re-key after retargeting/loading without combining groups whose drop-offs converged (or their clocks). */
export function cargoGroups(groups: Iterable<CargoGroup>): Map<string, CargoGroup> {
  const out = new Map<string, CargoGroup>();
  for (const c of groups) {
    if (c.rail !== undefined) c.rail = railHistory(c.rail) || undefined;
    const base = fareGroupKey(c.from, c.alight, c.dest, c.rail ?? 0, changeClass(c.transfers, c.count), c.ic ?? 0);
    let key = base;
    for (let i = 1; out.has(key); i++) key = base + ':' + i;
    out.set(key, c);
  }
  return out;
}

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
  /** Mail aboard (MailGroup by from:alight:dest:origin), its total and mail delivered (lifetime), in units of MAIL_UNIT_T. */
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
  /** Called after a timetable edit; indicesRemapped means the editor already preserved each call's occurrence. */
  abstract onLineChanged(indicesRemapped?: boolean): void;

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
    // passengers whose next leg is this vehicle's own onward run stay aboard (a line edit or a new pattern left a stale
    // drop-off here): no fare yet and no change of vehicle, their clocks and fare history kept
    let stay: ((alight: number) => boolean) | null = null, retargeted = false;
    for (const [k, c] of this.cargo) {
      if (c.alight !== st.id) continue;
      if (c.dest !== st.id && line) {
        const hop = g.lines.nextHop(st.id, c.dest);
        if (hop && (hop.line === line.id || hop.lines?.includes(line.id))) {
          stay ??= boarding(g, line, this.pattern, this.stopIndex, st.id);
          if (stay(hop.alight)) { c.alight = hop.alight; retargeted = true; continue; }
        }
      }
      const from = g.stations.get(c.from);
      const dist = from ? Math.hypot(from.x - st.x, from.z - st.z) : 0;
      // the leg's time: waiting at the boarding stop and riding (older saves: the ride since boarding)
      const leg = now - (c.t0 ?? c.day * DAY_SECONDS);
      // one rail fare whatever the track or station style; road vehicles: tram or bus fares
      const mode: FareMode = this.kind === 'road' ? (line?.kind === 'tram' ? 'tram' : 'bus') : 'rail';
      // the rail minimum once per journey: the distance fares of their earlier rail legs count towards it
      const ctx = stationFareContext(g, from, st, mode), before = c.rail ?? 0;
      let f = fareFor(dist, leg, c.count, mode === 'rail' && before > 0 ? { ...ctx, railBefore: before } : ctx);
      // each change of vehicle takes 10% off the leg ending in it and every later leg (fares.ts TRANSFER_FARE_FACTOR):
      // their changes so far, and one more for those changing here
      const changing = c.dest !== st.id;
      const hop = changing ? g.lines.nextHop(st.id, c.dest) : undefined;
      let next = hop, boardingAt = st.id;
      for (let n = 0; next?.line === WALK_LINE && n < 4; n++) {
        boardingAt = next.alight; next = g.lines.nextHop(boardingAt, c.dest);
      }
      const chargedChange = changing && !g.stations.isSameStationComplex(st.id, next ? boardingAt : c.dest);
      f *= transferFareFactor((c.transfers ?? 0) + (chargedChange ? c.count : 0), c.count);
      income += f;
      if (c.dest === st.id) {
        st.arrivedMonth += c.count;
        this.delivered += c.count;
        const town = g.towns.list[st.townId];
        if (town) town.passTransMonth += c.count;
      } else {
        // changing here: they wait for their next leg, each with one change of vehicle more
        const rail = railHistory(mode === 'rail' ? before + distanceFare(dist) : before);
        const changes = (chargedChange ? 1 : 0) + (c.count > 0 ? Math.max(0, c.transfers ?? 0) / c.count : 0);
        if (hop) g.lines.distribute(hop, c.count, (line, n) => g.stations.addWaiting(st, line, hop.alight, c.dest, n, 0, now, n * changes, rail, c.ic ?? 0));
      }
      moved += c.count;
      this.load -= c.count;
      this.cargo.delete(k);
    }
    if (retargeted) this.cargo = cargoGroups(this.cargo.values());
    if (income > 0) {
      g.company(this.owner).economy.earn(income, 'income');
      this.profitYear += income;
      this.incomeYear += income;
      if (line) {
        line.incomeYear += income;
        const observation = line.growth?.[this.owner + ':' + (patternOf(line, this.pattern)?.id ?? 0)];
        if (observation) observation.counter += income;
        if (line.kind === 'rail') g.ais.find((a) => a.companyId === this.owner)?.railPolicy.operating(line.id, income);
      }
      g.onIncome(income, this, st);
    }
    // mail: off (delivered, or waiting for its next leg), then on; handling a unit of mail takes 1.5 x a passenger
    const mailOff = this.mailCargo.size ? unloadMail(g, this, st) : 0;
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
    let picked = 0, inter = 0;
    if (line) {
      const may = boarding(g, line, this.pattern, this.stopIndex, st.id);
      // the wait a leg counts: at most WAIT_CAP_HEADWAYS of this service's headway (a backlog is lost demand)
      const hw = patternHeadway(g, line, this.pattern);
      const earliest = hw > 0 ? now - WAIT_CAP_HEADWAYS * hw : -Infinity;
      // (groups stay under their canonical keys, waiting and aboard, as a game loaded from a save keys them)
      let partial = false, stale = false;
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
        if (wg.count <= 0) st.waiting.delete(k); else partial = true;
        const ic = wg.ic ?? 0, ck = fareGroupKey(st.id, wg.alight, wg.dest, wg.rail ?? 0, changeClass(tr, take), ic);
        const cg = this.cargo.get(ck);
        if (cg) {
          cg.day = (cg.day * cg.count + g.day * take) / (cg.count + take);
          cg.t0 = ((cg.t0 ?? now) * cg.count + t0 * take) / (cg.count + take);
          cg.transfers = (cg.transfers ?? 0) + tr;
          cg.count += take;
          if (fareGroupKey(cg.from, cg.alight, cg.dest, cg.rail ?? 0, changeClass(cg.transfers, cg.count), cg.ic ?? 0) !== ck) stale = true;
        } else {
          const c: CargoGroup = wg.rail ? { alight: wg.alight, dest: wg.dest, count: take, from: st.id, day: g.day, t0, transfers: tr, rail: wg.rail }
            : { alight: wg.alight, dest: wg.dest, count: take, from: st.id, day: g.day, t0, transfers: tr };
          if (ic) c.ic = 1;
          this.cargo.set(ck, c);
        }
        this.load += take;
        picked += take;
        if (ic) inter += take;
      }
      if (partial) g.stations.rekeyWaiting(st);
      if (stale) this.cargo = cargoGroups(this.cargo.values());
      line.passMonth += picked;
      if (inter) line.icPassMonth = (line.icPassMonth ?? 0) + inter;
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
    let changed = false;
    for (const c of this.cargo.values()) if (!servesStation(l, this.pattern, c.alight) && next) { c.alight = next.id; changed = true; }
    if (changed) this.cargo = cargoGroups(this.cargo.values());
    if (this.mailCargo.size) fixMail(this, l, next);
  }

  /** Drop all passengers and mail (e.g. when sold or line removed). */
  dumpCargo() {
    this.cargo.clear(); this.load = 0;
    if (this.mailCargo.size || this.mailLoad) { this.mailCargo.clear(); this.mailLoad = 0; }
  }

  get age(): number { return (this.game.day - this.boughtDay) / 360; }
}
