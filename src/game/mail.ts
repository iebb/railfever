// Mail, the second cargo. A station accepting mail posts it daily from its catchment (letters and parcels by building
// type, the era and its town's size) to the other towns the mail network reaches, in shares of a gravity model between
// the towns (MailModel.townShares), addressed to the station each town's mail is best routed to. Mail rides
// only vehicles with room for it (mail vans behind the locomotive, mail vans and trucks, postbuses, the postal unit)
// along its own routing (Lines.mailRouting: the passenger tables where the same vehicles carry both), waits in its own
// station queues (Station.mail) and pays per leg by distance and the time since it was posted or reached the station
// (fares.ts mailFare, booked as 'mailIncome'). Station, line and town mail state is created on first use and mail
// draws on its own random stream: a game without mail vehicles plays, and saves, exactly as before.
import type { Game } from './game';
import type { Station } from './stations';
import { WALK_LINE } from './stations';
import type { Vehicle, MailGroup } from './vehicle';
import type { Hop, Line } from './lines';
import type { Town } from './towns';
import { RNG } from './rng';
import { GEN_RATE } from './demand';
import { MAIL_PER_PAX, MAIL_ERA, MAIL_STATION } from './constants';
import { simNow, mailFare, mailTripFactor, transferWalkTime } from './fares';
import { boarding, servesStation } from './patterns';

/** Mail waiting at a station for `line` to `alight` on its way to `dest`: `count` units, waiting since `t` (sim s, mean). */
export interface MailWait { line: number; alight: number; dest: number; count: number; t: number }

/** A station's mail (Station.mail, created on first use). Counts are units of MAIL_UNIT_T (0.1 t). */
export interface StationMail {
  /** queues by line:alight:dest, and their total */
  waiting: Map<string, MailWait>;
  total: number;
  /** 0..1: scales posting (as the passenger rating scales generation); see MailModel.rate */
  rating: number;
  /** fraction of a unit posted but not yet queued */
  genAccum: number;
  /** posted here, loaded here, delivered here, lost here (queue overflow, no route any more): this / last month */
  genMonth: number; genLast: number;
  pickupMonth: number; pickupLast: number;
  arrivedMonth: number; arrivedLast: number;
  lostMonth: number; lostLast: number;
  /** day a vehicle with room for mail last called, and the speed of those vehicles (km/h, a decaying maximum) */
  lastPickup: number; lastKmh: number;
}

/** A line's mail (Line.mail, from its first mail on): loaded this / last month, income this / last year (part of incomeYear). */
export interface LineMail { month: number; last: number; incomeYear: number; incomeLast: number }
/** A town's mail (Town.mail): posted at and delivered to its stations, this / last month. */
export interface TownMail { postedMonth: number; postedLast: number; deliveredMonth: number; deliveredLast: number }
/** Where a station's mail goes: destination stations (one per town), their weights and their sum (the posting factor). */
export interface MailDemand { dest: number[]; w: number[]; served: number }

/** Mail per resident by building type (houses and apartments 1, shops 1.5, offices 2, towers 1.6, churches 0.3). */
export const MAIL_TYPE_WEIGHT = [1, 1, 1, 1.5, 1, 2, 1.6, 0.3, 0, 0];
/** Reach (units) of the building mix around a station (mailMix): about its walking catchment. */
const MIX_REACH = 34;

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const NO_MAIL: MailDemand = { dest: [], w: [], served: 0 };
/**
 * Can people reach the station (Station.roadAccess, kept up to date by the network listener)? Mail only reads the
 * flag: demand.ts stationActive would refresh the access on the way, a side effect mail must not add.
 */
const reachable = (st: Station) => st.roadAccess !== false;

/** Mail units posted per weighted catchment resident and game day, before the era, town size, rating and service. */
export function mailGenRate(): number { return MAIL_PER_PAX * GEN_RATE; }
/** Mail per person in `year` relative to 1950 (MAIL_ERA, piecewise linear). */
export function mailEra(year: number): number {
  const t = MAIL_ERA;
  if (year <= t[0][0]) return t[0][1];
  for (let i = 1; i < t.length; i++) if (year <= t[i][0]) { const [y0, a] = t[i - 1], [y1, b] = t[i]; return a + ((b - a) * (year - y0)) / (y1 - y0); }
  return t[t.length - 1][1];
}
/** Distance decay of mail between towns (d in units): the long-distance trips' (d / 100)^-0.8, flat below 300 m. */
export function mailDecay(d: number): number { return Math.pow(Math.max(30, d) / 100, -0.8); }
/** Bigger towns post more per head (business mail): clamp(1 + 0.15 log2(pop / 3000), 0.75, 1.3). */
export function townMailFactor(pop: number): number { return clamp(1 + 0.15 * Math.log2(Math.max(1, pop) / 3000), 0.75, 1.3); }

/** A station's mail state, created on first use. */
export function stationMail(g: Game, st: Station): StationMail {
  return st.mail ??= {
    waiting: new Map(), total: 0, rating: 0.65, genAccum: 0, genMonth: 0, genLast: 0, pickupMonth: 0, pickupLast: 0,
    arrivedMonth: 0, arrivedLast: 0, lostMonth: 0, lostLast: 0, lastPickup: g.day, lastKmh: 0,
  };
}
export function lineMail(l: Line): LineMail { return l.mail ??= { month: 0, last: 0, incomeYear: 0, incomeLast: 0 }; }
export function townMail(t: Town): TownMail { return t.mail ??= { postedMonth: 0, postedLast: 0, deliveredMonth: 0, deliveredLast: 0 }; }

/** Share of a station's mail lost (this and last month) rather than loaded, 0..1. */
export function mailLostShare(m: StationMail): number {
  const lost = m.lostMonth + m.lostLast;
  return lost > 0 ? lost / (lost + m.pickupMonth + m.pickupLast) : 0;
}

// ------------------------------------------------------------------------------ station queues
/**
 * `count` units of mail wait at `st` for `line` to `alight` on their way to `dest`, since `t` (default now). A walking
 * hop (WALK_LINE) carries them to the linked station `alight`: delivered there, or queued for their next leg.
 */
export function addMail(g: Game, st: Station, line: number, alight: number, dest: number, count: number, t?: number, depth = 0) {
  if (count <= 0) return;
  const at = t ?? simNow(g);
  if (line === WALK_LINE) { walkMail(g, st, alight, dest, count, at, depth); return; }
  const m = stationMail(g, st), key = line + ':' + alight + ':' + dest, w = m.waiting.get(key);
  if (w) { w.t = (w.t * w.count + at * count) / (w.count + count); w.count += count; }
  else m.waiting.set(key, { line, alight, dest, count, t: at });
  m.total += count;
}

/** Mail walked to the linked station `toId` (the walk counts towards its next leg). */
function walkMail(g: Game, from: Station, toId: number, dest: number, count: number, t: number, depth: number) {
  const to = g.stations.get(toId);
  if (!to || depth > 4) { stationMail(g, from).lostMonth += count; return; }
  if (toId === dest) { deliverMail(g, to, count); return; }
  const hop = g.lines.mailNextHop(toId, dest);
  if (!hop) { stationMail(g, to).lostMonth += count; return; }
  const at = t - transferWalkTime(g.stations.gap(from, to));
  g.lines.distribute(hop, count, (l, n) => addMail(g, to, l, hop.alight, dest, n, at, depth + 1), 'mail', g.mail.random);
}

/** Mail reached its destination station: delivered (station, town). */
export function deliverMail(g: Game, st: Station, count: number) {
  stationMail(g, st).arrivedMonth += count;
  const town = g.towns.list[st.townId];
  if (town) townMail(town).deliveredMonth += count;
}

/** Most mail (units) a station holds: min(cap, base + perPop x mailPop + perTrack x platforms + perStop x stops). */
export function mailQueueCap(g: Game, st: Station): number {
  const c = MAIL_STATION;
  return Math.max(0, Math.floor(Math.min(c.cap, c.base + c.perPop * g.mail.mailPop(st) + c.perTrack * (st.rail?.tracks ?? 0) + c.perStop * st.stops.length)));
}

/** Mail beyond the station's queue cap is lost (largest remainders keep exactly the cap; counted as lost). */
export function trimMail(g: Game, st: Station) {
  const m = st.mail;
  if (!m || m.total <= 0) return;
  const max = mailQueueCap(g, st);
  if (m.total <= max) return;
  const f = max / m.total;
  const groups = [...m.waiting].map(([key, w]) => { const scaled = w.count * f, count = Math.floor(scaled); return { key, w, count, remainder: scaled - count }; });
  let spare = max - groups.reduce((n, x) => n + x.count, 0);
  groups.sort((a, b) => b.remainder - a.remainder);
  for (const x of groups) if (spare > 0) { x.count++; spare--; }
  let total = 0, lost = 0;
  for (const x of groups) {
    lost += x.w.count - x.count;
    x.w.count = x.count;
    if (x.count <= 0) m.waiting.delete(x.key); else total += x.count;
  }
  m.total = total;
  m.lostMonth += lost;
}

/** After a routing rebuild: mail keeps its line where it still is a good first leg; mail without a route is lost. */
export function rerouteMail(g: Game, st: Station) {
  const m = st.mail;
  if (!m || !m.waiting.size) return;
  const old = [...m.waiting.values()];
  m.waiting.clear(); m.total = 0;
  for (const w of old) {
    const hop = g.lines.mailNextHop(st.id, w.dest);
    if (!hop) { m.lostMonth += w.count; continue; }
    if (hop.alight === w.alight && (hop.line === w.line || hop.lines?.includes(w.line))) addMail(g, st, w.line, w.alight, w.dest, w.count, w.t);
    else g.lines.distribute(hop, w.count, (line, n) => addMail(g, st, line, hop.alight, w.dest, n, w.t), 'mail', g.mail.random);
  }
}

/** Mail waiting for a line that was merged into another (patterns.ts) waits for that line. */
export function redirectMail(g: Game, from: number, into: number) {
  for (const st of g.stations.map.values()) {
    const m = st.mail;
    if (!m || ![...m.waiting.values()].some((w) => w.line === from)) continue;
    const old = [...m.waiting.values()];
    m.waiting.clear(); m.total = 0;
    for (const w of old) addMail(g, st, w.line === from ? into : w.line, w.alight, w.dest, w.count, w.t);
  }
}

/** Line `b` merged into `a`: its mail history joins a's. */
export function mergeLineMail(a: Line, b: Line) {
  if (!b.mail) return;
  const m = lineMail(a);
  m.month += b.mail.month; m.last += b.mail.last; m.incomeYear += b.mail.incomeYear; m.incomeLast += b.mail.incomeLast;
}

/**
 * Station `b` becomes part of `a` (Stations.absorb): its mail state joins a's, mail anywhere heading to or changing
 * at `b` heads for `a`, and mail aboard vehicles is re-addressed (`re` maps station ids).
 */
export function absorbMail(g: Game, a: Station, b: Station, re: (id: number) => number) {
  const moved = b.mail ? [...b.mail.waiting.values()] : [];
  if (b.mail) {
    const ma = stationMail(g, a), mb = b.mail;
    ma.genAccum += mb.genAccum; ma.genMonth += mb.genMonth; ma.genLast += mb.genLast;
    ma.pickupMonth += mb.pickupMonth; ma.pickupLast += mb.pickupLast; ma.arrivedMonth += mb.arrivedMonth; ma.arrivedLast += mb.arrivedLast;
    ma.lostMonth += mb.lostMonth; ma.lostLast += mb.lostLast;
    ma.rating = Math.max(ma.rating, mb.rating); ma.lastPickup = Math.max(ma.lastPickup, mb.lastPickup); ma.lastKmh = Math.max(ma.lastKmh, mb.lastKmh);
    delete b.mail;
  }
  for (const st of g.stations.map.values()) {
    const m = st.mail;
    if (st === b || !m || ![...m.waiting.values()].some((w) => w.alight === b.id || w.dest === b.id)) continue;
    const old = [...m.waiting.values()];
    m.waiting.clear(); m.total = 0;
    for (const w of old) {
      if (re(w.dest) === st.id) deliverMail(g, st, w.count);
      else addMail(g, st, w.line, re(w.alight), re(w.dest), w.count, w.t);
    }
  }
  for (const w of moved) {
    if (re(w.dest) === a.id) deliverMail(g, a, w.count);
    else addMail(g, a, w.line, re(w.alight), re(w.dest), w.count, w.t);
  }
  for (const v of g.vehicles.map.values()) {
    if (![...v.mailCargo.values()].some((c) => c.alight === b.id || c.dest === b.id || c.from === b.id)) continue;
    const old = [...v.mailCargo.values()];
    v.mailCargo.clear();
    for (const c of old) putMail(v, { ...c, alight: re(c.alight), dest: re(c.dest), from: re(c.from) });
  }
}

/** Mail waiting at a station by destination town (and the lines it waits for), most first (for the station window). */
export function mailByTown(g: Game, stationId: number): { town: number; count: number; lines: { line: number; count: number }[] }[] {
  const m = g.stations.get(stationId)?.mail;
  if (!m) return [];
  const byTown = new Map<number, { town: number; count: number; lines: Map<number, number> }>();
  for (const w of m.waiting.values()) {
    const t = g.stations.get(w.dest)?.townId ?? -1;
    let e = byTown.get(t);
    if (!e) { e = { town: t, count: 0, lines: new Map() }; byTown.set(t, e); }
    e.count += w.count;
    e.lines.set(w.line, (e.lines.get(w.line) ?? 0) + w.count);
  }
  return [...byTown.values()]
    .map((e) => ({ town: e.town, count: e.count, lines: [...e.lines].map(([line, count]) => ({ line, count })).sort((a, b) => b.count - a.count) }))
    .sort((a, b) => b.count - a.count);
}

// ------------------------------------------------------------------------------ vehicles
/** Add a group to a vehicle's mail (merged with one of the same from:alight:dest, leg times weighted). */
function putMail(v: Vehicle, c: MailGroup) {
  const k = c.from + ':' + c.alight + ':' + c.dest, o = v.mailCargo.get(k);
  if (o) { o.t0 = (o.t0 * o.count + c.t0 * c.count) / Math.max(1, o.count + c.count); o.count += c.count; }
  else v.mailCargo.set(k, { ...c });
}

/** Restore a vehicle's mail from a save (groups re-keyed, duplicates merged). */
export function restoreMail(v: Vehicle, list: MailGroup[]) {
  v.mailCargo.clear();
  for (const c of list) putMail(v, { alight: c.alight, dest: c.dest, count: c.count, from: c.from, t0: c.t0 });
}

/** Re-target mail whose drop-off is no longer served by the vehicle's pattern (to the next stop; re-keyed). */
export function fixMail(v: Vehicle, l: Line, next: Station | null) {
  if (!next || ![...v.mailCargo.values()].some((c) => !servesStation(l, v.pattern, c.alight))) return;
  const old = [...v.mailCargo.values()];
  v.mailCargo.clear();
  for (const c of old) putMail(v, servesStation(l, v.pattern, c.alight) ? c : { ...c, alight: next.id });
}

/** Book mail income: the company ('mailIncome'), the vehicle, its line (total and mail part), the AI's rail ledger. */
function bookMail(g: Game, v: Vehicle, st: Station, income: number) {
  g.company(v.owner).economy.earn(income, 'mailIncome');
  v.profitYear += income;
  v.incomeYear += income;
  const line = v.line;
  if (line) {
    line.incomeYear += income;
    lineMail(line).incomeYear += income;
    if (line.kind === 'rail') g.ais.find((a) => a.companyId === v.owner)?.railPolicy.operating(line.id, income);
  }
  g.onIncome(income, v, st);
}

/**
 * Mail for this station gets off (delivered, or queued for its next leg from now on) and pays its leg. Returns the
 * units unloaded.
 */
export function unloadMail(g: Game, v: Vehicle, st: Station, now: number): number {
  let moved = 0, income = 0;
  for (const [k, c] of v.mailCargo) {
    if (c.alight !== st.id) continue;
    const from = g.stations.get(c.from);
    const dist = from ? Math.hypot(from.x - st.x, from.z - st.z) : 0;
    income += mailFare(dist, now - c.t0, c.count);
    if (c.dest === st.id) { deliverMail(g, st, c.count); v.mailDelivered += c.count; }
    else {
      const hop = g.lines.mailNextHop(st.id, c.dest);
      if (hop) g.lines.distribute(hop, c.count, (line, n) => addMail(g, st, line, hop.alight, c.dest, n, now), 'mail', g.mail.random);
      else stationMail(g, st).lostMonth += c.count;
    }
    moved += c.count;
    v.mailLoad -= c.count;
    v.mailCargo.delete(k);
  }
  if (v.mailLoad < 1e-9) v.mailLoad = 0;
  if (income > 0) bookMail(g, v, st, income);
  return moved;
}

/**
 * Load mail queued here for the vehicle's line, bound for stops its pattern serves and for which it is a service
 * worth taking (patterns.ts boarding, mail table), up to its room. Returns the units loaded.
 */
export function loadMail(g: Game, v: Vehicle, st: Station): number {
  const line = v.line;
  if (!line) return 0;
  const m = stationMail(g, st);
  m.lastPickup = g.day;
  m.lastKmh = Math.max(m.lastKmh * 0.8, v.maxSpeedKmh);
  let room = v.mailCapacity - v.mailLoad;
  if (room <= 0 || !m.waiting.size) return 0;
  const may = boarding(g, line, v.pattern, v.stopIndex, st.id, 'mail');
  let picked = 0;
  for (const [k, w] of m.waiting) {
    if (room <= 0) break;
    if (w.line !== line.id || !may(w.alight)) continue;
    const take = Math.min(room, w.count);
    w.count -= take; m.total -= take;
    if (w.count <= 0) m.waiting.delete(k);
    putMail(v, { alight: w.alight, dest: w.dest, count: take, from: st.id, t0: w.t });
    v.mailLoad += take; room -= take; picked += take;
  }
  if (picked > 0) { m.pickupMonth += picked; lineMail(line).month += picked; }
  return picked;
}

/**
 * Take `units` of a vehicle's mail off at station `st` (a shorter consist, Vehicles.recompose): queued again there
 * for their next leg (their leg time kept), or lost without a station or route. Returns the units taken off.
 */
export function offloadMail(g: Game, v: Vehicle, units: number, st: Station | null): number {
  let left = units;
  for (const [k, c] of [...v.mailCargo]) {
    if (left <= 0) break;
    const n = Math.min(left, c.count);
    c.count -= n; v.mailLoad -= n; left -= n;
    if (c.count <= 0) v.mailCargo.delete(k);
    const hop = st && c.dest !== st.id ? g.lines.mailNextHop(st.id, c.dest) : undefined;
    if (st && hop) g.lines.distribute(hop, n, (line, q) => addMail(g, st, line, hop.alight, c.dest, q, c.t0), 'mail', g.mail.random);
    else if (st && c.dest === st.id) deliverMail(g, st, n);
    else if (st) stationMail(g, st).lostMonth += n;
  }
  if (v.mailLoad < 1e-9) v.mailLoad = 0;
  return units - left;
}

/**
 * Full-load modes (for a full-load order, not yet in the game): wait for passengers, for mail, for either or for both
 * to fill up. Default: passengers ('pax'); mail-only vehicles wait for mail.
 */
export type FullLoad = 'pax' | 'mail' | 'any' | 'all';
/** Is the vehicle full by `mode` (FullLoad)? A cargo it has no room for counts as full. */
export function isFull(v: Vehicle, mode: FullLoad = v.mailOnly ? 'mail' : 'pax'): boolean {
  const pax = v.capacity <= 0 || v.load >= v.capacity, mail = v.mailCapacity <= 0 || v.mailLoad >= v.mailCapacity;
  return mode === 'pax' ? pax : mode === 'mail' ? mail : mode === 'any' ? (v.capacity > 0 && pax) || (v.mailCapacity > 0 && mail) : pax && mail;
}

// ------------------------------------------------------------------------------ saves
/** A station's mail for a save (queues as a list). */
export function stationMailJSON(m: StationMail): object { return { ...m, waiting: [...m.waiting.values()].map((w) => ({ ...w })) }; }
/** A station's mail from a save: the state without its queues (deserialize re-queues them with addMail). */
export function restoreStationMail(d: any): StationMail {
  const num = (x: unknown, def = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : def);
  return {
    ...d, waiting: new Map(), total: 0, rating: num(d?.rating, 0.65), genAccum: num(d?.genAccum),
    genMonth: num(d?.genMonth), genLast: num(d?.genLast), pickupMonth: num(d?.pickupMonth), pickupLast: num(d?.pickupLast),
    arrivedMonth: num(d?.arrivedMonth), arrivedLast: num(d?.arrivedLast), lostMonth: num(d?.lostMonth), lostLast: num(d?.lostLast),
    lastPickup: num(d?.lastPickup), lastKmh: num(d?.lastKmh),
  };
}

// ------------------------------------------------------------------------------ the mail model (game.mail)
/**
 * Mail generation, destinations and ratings (Game.mail). Daily (game.ts, after the passengers): every station that
 * accepts mail posts mailPop x mailGenRate x era x town factor x (0.2 + rating) x served units, shared out over its
 * destinations at random rounding (its own random stream), then queues are trimmed and ratings move. Monthly and
 * yearly: the counters roll over.
 */
export class MailModel {
  private rng: RNG | null = null;
  private shareKey = -1;
  private shareTowns = 0;
  private share = new Float64Array(0);
  private dayKey: number[] = [];
  private dests = new Map<number, MailDemand>();
  private pops = new Map<number, number>();

  constructor(private g: Game) {}

  /** Mail's own random stream (seeded from the map, saved once used): mail never draws on the passengers' Game.rng. */
  get random(): RNG { return this.rng ??= new RNG(this.g.options.seed * 131 + 11); }

  /**
   * Weighted residents of a station's catchment for mail: its walking catchment population (catchPop) times the
   * building mix around it (shops, offices and towers post more), plus its car feeders (demand.ts). Cached for the day.
   */
  mailPop(st: Station): number {
    this.refreshDay();
    let p = this.pops.get(st.id);
    if (p === undefined) {
      p = st.catchPop * this.mailMix(st) + Math.max(0, this.g.demand.generationPopulation(st) - st.catchPop);
      this.pops.set(st.id, p);
    }
    return p;
  }

  /** Mail per resident around a station (MAIL_TYPE_WEIGHT by building, nearer buildings weigh more; 1 if none). */
  mailMix(st: Station): number {
    const near = this.g.world.buildingsNear(st.x, st.z, MIX_REACH).filter((b) => b.pop > 0).sort((a, b) => a.id - b.id);
    let sum = 0, weighted = 0;
    for (const b of near) {
      const d = Math.hypot(b.x - st.x, b.z - st.z);
      if (d > MIX_REACH) continue;
      const w = b.pop / (1 + d / 8);
      sum += w; weighted += w * (MAIL_TYPE_WEIGHT[b.type] ?? 1);
    }
    return sum > 0 ? weighted / sum : 1;
  }

  /** Does the station accept mail? A line with vehicles carrying mail calls, it is reachable, and enough people post. */
  accepts(st: Station): boolean {
    return this.g.lines.mailServed(st.id) && reachable(st) && this.mailPop(st) >= MAIL_STATION.acceptPop;
  }

  /**
   * Shares of town T's mail sent to town U (towns x towns, rows sum to 1 where T sends any): a gravity model between
   * the towns' regions (demand.ts): residents and jobs at the sending end, the attraction at the receiving end and the
   * long-distance decay (d / 100)^-0.8 (mailDecay), without its 600 m threshold: letters go to the next town too.
   * Rebuilt per demand version.
   */
  townShares(): { n: number; share: Float64Array } {
    const d = this.g.demand, nt = this.g.towns.list.length;
    if (this.shareKey !== d.version || this.shareTowns !== nt) {
      this.shareKey = d.version; this.shareTowns = nt;
      const R = d.regions, n = R.length, P = new Float64Array(nt * nt);
      for (let r = 0; r < n; r++) {
        const T = R[r].town, src = R[r].pop + R[r].jobs;
        if (!(src > 0) || T < 0 || T >= nt) continue;
        for (let q = 0; q < n; q++) {
          const U = R[q].town;
          if (U === T || U < 0 || U >= nt || !(R[q].attracted > 0)) continue;
          P[T * nt + U] += src * R[q].attracted * mailDecay(Math.hypot(R[r].x - R[q].x, R[r].z - R[q].z));
        }
      }
      for (let T = 0; T < nt; T++) {
        let s = 0;
        for (let U = 0; U < nt; U++) s += P[T * nt + U];
        if (s > 0) for (let U = 0; U < nt; U++) P[T * nt + U] /= s;
      }
      this.share = P;
    }
    return { n: nt, share: this.share };
  }

  /**
   * Where a station's mail goes: per other town the accepting station its mail is routed to fastest (lowest hop cost;
   * ties: the lower id), weighted by the town share and mailTripFactor of the routed time. Cached for the day.
   */
  weights(st: Station): MailDemand {
    this.refreshDay();
    const c = this.dests.get(st.id);
    if (c) return c;
    const g = this.g, table = g.lines.mailRouting.get(st.id), T = st.townId;
    if (!table || T < 0 || !reachable(st)) { this.dests.set(st.id, NO_MAIL); return NO_MAIL; }
    const best = new Map<number, { d: number; hop: Hop }>();
    for (const [d, hop] of table) {
      const ds = g.stations.get(d);
      if (!ds || ds.townId < 0 || ds.townId === T || !this.accepts(ds)) continue;
      const b = best.get(ds.townId);
      if (!b || hop.cost < b.hop.cost || (hop.cost === b.hop.cost && d < b.d)) best.set(ds.townId, { d, hop });
    }
    const { n, share } = this.townShares();
    const dest: number[] = [], w: number[] = [];
    let served = 0;
    for (const U of [...best.keys()].sort((a, b) => a - b)) {
      const s = T < n && U < n ? share[T * n + U] : 0;
      if (!(s > 0)) continue;
      const b = best.get(U)!, ds = g.stations.get(b.d)!;
      const v = s * mailTripFactor(Math.hypot(ds.x - st.x, ds.z - st.z), b.hop.cost);
      dest.push(b.d); w.push(v); served += v;
    }
    const res: MailDemand = { dest, w, served };
    this.dests.set(st.id, res);
    return res;
  }

  /** Day caches (destinations, mail populations) hold for the day while routing, demand, network and catchments do. */
  private refreshDay() {
    const g = this.g, k = this.dayKey;
    if (k[0] === g.day && k[1] === g.lines.version && k[2] === g.demand.version && k[3] === g.networkVersion && k[4] === g.stations.catchVersion) return;
    this.dayKey = [g.day, g.lines.version, g.demand.version, g.networkVersion, g.stations.catchVersion];
    this.dests.clear();
    this.pops.clear();
  }

  /** Units a station posts per day at its current rating and service (for the UI and estimates). */
  rate(st: Station): number {
    if (!this.accepts(st)) return 0;
    const town = this.g.towns.list[st.townId];
    const dw = this.weights(st);
    return this.mailPop(st) * mailGenRate() * mailEra(this.g.year) * townMailFactor(town?.pop ?? 0) * (0.2 + (st.mail?.rating ?? 0.65)) * dw.served;
  }

  /** Daily: posting at the accepting stations, queue trimming and mail ratings. */
  daily() {
    const g = this.g, active = g.lines.mailActive;
    let any = false;
    for (const st of g.stations.map.values()) if (st.mail) { any = true; break; }
    if (!active && !any) return;
    const now = simNow(g);
    for (const st of g.stations.map.values()) {
      if (active && g.lines.mailServed(st.id) && this.accepts(st)) this.post(st, now);
      if (st.mail) {
        trimMail(g, st);
        this.updateRating(st);
      }
    }
  }

  private post(st: Station, now: number) {
    const g = this.g, dw = this.weights(st);
    if (!(dw.served > 0)) return;
    const m = stationMail(g, st);
    const town = g.towns.list[st.townId];
    m.genAccum += this.mailPop(st) * mailGenRate() * mailEra(g.year) * townMailFactor(town?.pop ?? 0) * (0.2 + m.rating) * dw.served;
    const n = Math.floor(m.genAccum);
    if (n <= 0) return;
    m.genAccum -= n;
    const table = g.lines.mailRouting.get(st.id), rng = this.random;
    let given = 0;
    for (let i = 0; i < dw.dest.length; i++) {
      const share = (n * dw.w[i]) / dw.served;
      let c = Math.floor(share);
      if (rng.next() < share - c) c++;
      if (c <= 0) continue;
      const d = dw.dest[i], hop = table?.get(d);
      if (!hop) continue;
      g.lines.distribute(hop, c, (line, k) => addMail(g, st, line, hop.alight, d, k, now), 'mail', rng);
      given += c;
    }
    m.genMonth += given;
    if (town) townMail(town).postedMonth += given;
  }

  /**
   * Daily mail rating: towards 0.30, plus frequency (a vehicle with room for mail within 7 / 14 / 30 days: +0.30 /
   * +0.20 / +0.10), the queue (under 40 units +0.15, 150 +0.08, 400 0, more -0.12), speed (up to +0.2 from 40 km/h
   * up) and minus 0.25 x the share lost; at most 0.5 without a mail line.
   */
  updateRating(st: Station) {
    const g = this.g, m = st.mail;
    if (!m) return;
    const days = g.day - m.lastPickup;
    let target = 0.3;
    target += days <= 7 ? 0.3 : days <= 14 ? 0.2 : days <= 30 ? 0.1 : 0;
    target += m.total < 40 ? 0.15 : m.total < 150 ? 0.08 : m.total < 400 ? 0 : -0.12;
    target += Math.min(0.2, Math.max(0, (m.lastKmh - 40) / 600));
    target -= 0.25 * mailLostShare(m);
    if (!g.lines.mailServed(st.id)) target = Math.min(target, 0.5);
    m.rating = clamp(m.rating + (target - m.rating) * 0.04, 0, 1);
  }

  /** Month end: station, line and town counters roll over. */
  monthly() {
    const g = this.g;
    for (const st of g.stations.map.values()) {
      const m = st.mail;
      if (!m) continue;
      m.genLast = m.genMonth; m.genMonth = 0;
      m.pickupLast = m.pickupMonth; m.pickupMonth = 0;
      m.arrivedLast = m.arrivedMonth; m.arrivedMonth = 0;
      m.lostLast = m.lostMonth; m.lostMonth = 0;
    }
    for (const l of g.lines.map.values()) if (l.mail) { l.mail.last = l.mail.month; l.mail.month = 0; }
    for (const t of g.towns.list) if (t.mail) {
      t.mail.postedLast = t.mail.postedMonth; t.mail.postedMonth = 0;
      t.mail.deliveredLast = t.mail.deliveredMonth; t.mail.deliveredMonth = 0;
    }
  }

  /** Year end: line mail income rolls over. */
  yearly() {
    for (const l of this.g.lines.map.values()) if (l.mail) { l.mail.incomeLast = l.mail.incomeYear; l.mail.incomeYear = 0; }
  }

  /** Saved state (null while mail has drawn no random number: older saves and games without mail save as before). */
  toJSON(): { rng: number } | null { return this.rng ? { rng: this.rng.state } : null; }
  load(d: any) {
    this.rng = null;
    if (d && typeof d.rng === 'number') { this.rng = new RNG(1); this.rng.state = d.rng; }
  }
}
