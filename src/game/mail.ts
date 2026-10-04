// Mail, the second cargo. A station accepting mail posts it daily from the residents and jobs it collects mail from
// (its own share of the buildings around mail stations and the post office's feeders to frequent mail trains, by mail
// service alone: MailModel.allocate) to the other towns the mail network reaches, in shares of a gravity model between
// the towns (MailModel.townShares) scaled by the capture of the share it reaches (MAIL_CAPTURE), addressed to the
// station each town's mail is best routed to. Mail rides only vehicles with room for it (mail vans behind the
// locomotive, mail vans and trucks, postbuses, the postal unit) along its own routing (Lines.mailRouting: the passenger
// tables where the same vehicles carry both) and waits in its own station queues (Station.mail). A journey keeps where
// and when it was posted, its changes of vehicle and the legs that carried it; it pays once, when delivered (fares.ts
// mailFare: the whole journey's distance and time, x 0.9 per change), shared by its legs' vehicles and lines by the
// distances they carried (booked as 'mailIncome'). Station, line and town mail state is created on first use and mail
// draws on its own random stream: a game without mail vehicles plays, and saves, exactly as before.
import type { Game } from './game';
import type { Station, StationPlan } from './stations';
import { WALK_LINE } from './stations';
import type { Vehicle, MailGroup } from './vehicle';
import type { Hop, Line } from './lines';
import type { Town } from './towns';
import { RNG } from './rng';
import { GEN_RATE, type ForecastSite } from './demand';
import { MAIL_PER_PAX, MAIL_ERA, MAIL_STATION, MAIL_FEEDER, MAIL_CAPTURE } from './constants';
import { simNow, mailFare, mailTripFactor, transferWalkTime } from './fares';
import { boarding, servesStation, patternHeadways, linePatterns, mailFleet, TRANSFER_PENALTY_S } from './patterns';
import { walkingCatchment, planWalkingCatchment, walkWeight, coverOf, type WalkingCatchment } from './catchment';

/**
 * A leg mail has been carried on: the vehicle, its line and its owner then, and the straight-line distance (units)
 * from where it got on to where it got off. Legs of a group are per unit of mail (averaged when groups merge).
 */
export type MailLeg = [vehicle: number, line: number, owner: number, dist: number];
/**
 * A mail journey (per unit; averages when groups merge): `o` the station it was posted at, `od` the straight-line
 * distance from there to its destination (units), `p` when it was posted (sim s), `c` its changes of vehicle so far,
 * `legs` the legs that carried it so far (sorted by vehicle, line, owner).
 */
export interface MailJourney { o: number; od: number; p: number; c: number; legs: MailLeg[] }
/** Mail waiting at a station for `line` to `alight` on its way to `dest`: `count` units and their journey (key line:alight:dest:o). */
export interface MailWait extends MailJourney { line: number; alight: number; dest: number; count: number }

/** A station's mail (Station.mail, created on first use). Counts are units of MAIL_UNIT_T (0.1 t). */
export interface StationMail {
  /** queues by line:alight:dest:origin, and their total */
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
/** Where a station's mail goes: destination stations (one per town), their weights and their sum (the posting factor, `served`). */
export interface MailDemand { dest: number[]; w: number[]; served: number }

/** Mail per resident by building type (houses and apartments 1, shops 1.5, offices 2, towers 1.6, churches 0.3). */
export const MAIL_TYPE_WEIGHT = [1, 1, 1, 1.5, 1, 2, 1.6, 0.3, 0, 0];

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const NO_MAIL: MailDemand = { dest: [], w: [], served: 0 };
/**
 * Can people reach the station (Station.roadAccess, kept up to date by the network listener)? Mail only reads the
 * flag: demand.ts stationActive would refresh the access on the way, a side effect mail must not add.
 */
const reachable = (st: Station) => st.roadAccess !== false;

/** Mail units posted per weighted resident and game day, before the era, town size, rating and service. */
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
/**
 * Capture of a station's mail (MAIL_CAPTURE): the part of its full posting rate it posts when the towns its mail
 * routes reach receive `reached` (0..1) of its town's mail (the gravity shares).
 */
export function mailCapture(reached: number): number {
  const C = MAIL_CAPTURE;
  return reached > 0 ? C.floor + (1 - C.floor) * Math.min(1, reached / C.full) : 0;
}
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

// ------------------------------------------------------------------------------ journeys
const stationDist = (g: Game, a: number, b: number) => {
  const sa = g.stations.get(a), sb = g.stations.get(b);
  return sa && sb ? Math.hypot(sa.x - sb.x, sa.z - sb.z) : 0;
};
/** A journey posted now at `st` for station `dest`. */
export function newJourney(g: Game, st: Station, dest: number): MailJourney {
  return { o: st.id, od: stationDist(g, st.id, dest), p: simNow(g), c: 0, legs: [] };
}
/** The journey part of a group (a copy). */
export function journeyOf(j: MailJourney): MailJourney { return { o: j.o, od: j.od, p: j.p, c: j.c, legs: j.legs.map((l) => [l[0], l[1], l[2], l[3]]) }; }
const legKey = (l: MailLeg) => l[0] + ':' + l[1] + ':' + l[2];
const byLeg = (a: MailLeg, b: MailLeg) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
/** The journey after one more leg (the same units: its distance adds to that vehicle's), and a change of vehicle if `change`. */
function afterLeg(j: MailJourney, v: Vehicle, line: Line | null, dist: number, change: boolean): MailJourney {
  const leg: MailLeg = [v.id, line?.id ?? -1, v.owner, dist];
  const legs = j.legs.map((l): MailLeg => [l[0], l[1], l[2], l[3]]);
  const same = legs.find((l) => legKey(l) === legKey(leg));
  if (same) same[3] += dist; else { legs.push(leg); legs.sort(byLeg); }
  return { o: j.o, od: j.od, p: j.p, c: j.c + (change ? 1 : 0), legs };
}
/** Merge `n` units of journey `j` into a group of `m` units (per-unit averages; legs by vehicle, line and owner). */
function blend(into: MailJourney, m: number, j: MailJourney, n: number) {
  const t = m + n;
  if (!(t > 0)) return;
  into.od = (into.od * m + j.od * n) / t;
  into.p = (into.p * m + j.p * n) / t;
  into.c = (into.c * m + j.c * n) / t;
  if (!into.legs.length && !j.legs.length) return;
  const sum = new Map<string, MailLeg>();
  for (const l of into.legs) sum.set(legKey(l), [l[0], l[1], l[2], l[3] * m]);
  for (const l of j.legs) { const k = legKey(l), s = sum.get(k); if (s) s[3] += l[3] * n; else sum.set(k, [l[0], l[1], l[2], l[3] * n]); }
  into.legs = [...sum.values()].map((l): MailLeg => [l[0], l[1], l[2], l[3] / t]).sort(byLeg);
}
/** A waiting group in its fixed key order (saves write groups as they are). */
function waitGroup(line: number, alight: number, dest: number, count: number, j: MailJourney): MailWait {
  return { line, alight, dest, count, o: j.o, od: j.od, p: j.p, c: j.c, legs: j.legs.map((l): MailLeg => [l[0], l[1], l[2], l[3]]) };
}
/** Mail aboard in its fixed key order. */
function cargoGroup(alight: number, dest: number, count: number, from: number, j: MailJourney): MailGroup {
  return { alight, dest, count, from, o: j.o, od: j.od, p: j.p, c: j.c, legs: j.legs.map((l): MailLeg => [l[0], l[1], l[2], l[3]]) };
}

/** Receipts go to the vehicle's owner, else the recorded operator (a bought company: its buyer); the line is a legacy fallback. */
function payee(g: Game, v: Vehicle | undefined, line: Line | undefined, owner: number): number {
  let who = v ? v.owner : g.companies[owner] ? owner : line ? line.owner : owner;
  for (let k = 0; k < 8 && g.companies[who]?.defunct && g.companies[who].boughtBy !== undefined; k++) who = g.companies[who].boughtBy!;
  return who;
}
/** Book a share of mail receipts: the company ('mailIncome'), the vehicle, its line (total and mail part), the AI's rail ledger. */
function book(g: Game, v: Vehicle | undefined, line: Line | undefined, owner: number, amount: number) {
  if (!(amount > 0)) return;
  const who = payee(g, v, line, owner);
  g.company(who).economy.earn(amount, 'mailIncome');
  if (v) { v.profitYear += amount; v.incomeYear += amount; }
  if (line) {
    line.incomeYear += amount;
    lineMail(line).incomeYear += amount;
    if (line.kind === 'rail') g.ais.find((a) => a.companyId === who)?.railPolicy.operating(line.id, amount);
  }
}

/**
 * Mail delivered at `st`: counted (station, town) and paid. The journey's receipts (fares.ts mailFare: posting to now,
 * the distance from its origin, x 0.9 per change) are shared by its legs by the distances they carried: the delivering
 * vehicle (`by`, its last leg) and the earlier legs. Returns the delivering vehicle's share.
 */
export function settleMail(g: Game, st: Station, count: number, j: MailJourney, by: { v: Vehicle; line: Line | null; dist: number } | null): number {
  deliverMail(g, st, count);
  const fare = mailFare(j.od, simNow(g) - j.p, count, j.c);
  if (!(fare > 0)) return 0;
  let total = by ? Math.max(0, by.dist) : 0;
  for (const l of j.legs) total += Math.max(0, l[3]);
  if (!(total > 0)) {
    if (!by) return 0;
    book(g, by.v, by.line ?? undefined, by.v.owner, fare);
    return fare;
  }
  let mine = 0;
  if (by && by.dist > 0) { mine = (fare * by.dist) / total; book(g, by.v, by.line ?? undefined, by.v.owner, mine); }
  for (const l of j.legs) if (l[3] > 0) book(g, g.vehicles.get(l[0]), g.lines.get(l[1]), l[2], (fare * l[3]) / total);
  return mine;
}

// ------------------------------------------------------------------------------ station queues
/**
 * `count` units of mail on journey `j` wait at `st` for `line` to `alight` on their way to `dest`. A walking hop
 * (WALK_LINE) carries them to the linked station `alight`: delivered there, or queued for their next leg.
 */
export function addMail(g: Game, st: Station, line: number, alight: number, dest: number, count: number, j: MailJourney, depth = 0) {
  if (count <= 0) return;
  if (line === WALK_LINE) { walkMail(g, st, alight, dest, count, j, depth); return; }
  const m = stationMail(g, st), key = line + ':' + alight + ':' + dest + ':' + j.o, w = m.waiting.get(key);
  if (w) { blend(w, w.count, j, count); w.count += count; }
  else m.waiting.set(key, waitGroup(line, alight, dest, count, j));
  m.total += count;
}

/** Mail walked to the linked station `toId`: delivered there, or queued for its next leg there. */
function walkMail(g: Game, from: Station, toId: number, dest: number, count: number, j: MailJourney, depth: number) {
  const to = g.stations.get(toId);
  if (!to || depth > 4) { stationMail(g, from).lostMonth += count; return; }
  if (toId === dest) { settleMail(g, to, count, j, null); return; }
  const hop = g.lines.mailNextHop(toId, dest);
  if (!hop) { stationMail(g, to).lostMonth += count; return; }
  g.lines.distribute(hop, count, (l, n) => addMail(g, to, l, hop.alight, dest, n, j, depth + 1), 'mail', g.mail.random);
}

/** Mail reached its destination station: counted (station, town). settleMail pays for it. */
export function deliverMail(g: Game, st: Station, count: number) {
  stationMail(g, st).arrivedMonth += count;
  const town = g.towns.list[st.townId];
  if (town) townMail(town).deliveredMonth += count;
}

/** Most mail (units) a station holds: min(cap, base + perPop x mailPop + perTrack x platforms + perStop x stops). */
export function mailQueueCap(g: Game, st: Station): number {
  return mailQueueCapOf(g.mail.mailPop(st), st.rail?.tracks ?? 0, st.stops.length);
}
/** mailQueueCap of a station with this mail population, platform tracks and stops (also for forecasts). */
export function mailQueueCapOf(pop: number, tracks: number, stops: number): number {
  const c = MAIL_STATION;
  return Math.max(0, Math.floor(Math.min(c.cap, c.base + c.perPop * pop + c.perTrack * tracks + c.perStop * stops)));
}

/** A leg of a routed mail journey (routedJourney): the line or lines sharing it, where it boards, its straight-line distance. */
export interface RoutedLeg { lines: number[]; from: number; dist: number }
/**
 * The mail journey from station `from` to `dest` as the mail routing carries it (forecasts): its legs, its changes of
 * vehicle, the straight-line distance it pays for and its expected time from posting to delivery (the routing cost:
 * the waits for the next vehicle and the rides, without the transfer penalty, which is a preference rather than time).
 * Null without a route.
 */
export function routedJourney(g: Game, from: number, dest: number): { od: number; seconds: number; changes: number; legs: RoutedLeg[] } | null {
  const first = g.lines.mailNextHop(from, dest);
  if (!first) return null;
  const legs: RoutedLeg[] = [];
  let at = from, hop: Hop | undefined = first;
  for (let k = 0; hop && k < 16; k++) {
    if (hop.line !== WALK_LINE) legs.push({ lines: hop.lines ?? [hop.line], from: at, dist: stationDist(g, at, hop.alight) });
    at = hop.alight;
    if (at === dest) break;
    hop = g.lines.mailNextHop(at, dest);
  }
  if (at !== dest || !legs.length) return null;
  const changes = legs.length - 1;
  return { od: stationDist(g, from, dest), seconds: Math.max(1, first.cost - TRANSFER_PENALTY_S * changes), changes, legs };
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
    if (hop.alight === w.alight && (hop.line === w.line || hop.lines?.includes(w.line))) addMail(g, st, w.line, w.alight, w.dest, w.count, w);
    else g.lines.distribute(hop, w.count, (line, n) => addMail(g, st, line, hop.alight, w.dest, n, w), 'mail', g.mail.random);
  }
}

/** Mail waiting for a line that was merged into another (patterns.ts) waits for that line. */
export function redirectMail(g: Game, from: number, into: number) {
  for (const st of g.stations.map.values()) {
    const m = st.mail;
    if (!m || ![...m.waiting.values()].some((w) => w.line === from)) continue;
    const old = [...m.waiting.values()];
    m.waiting.clear(); m.total = 0;
    for (const w of old) addMail(g, st, w.line === from ? into : w.line, w.alight, w.dest, w.count, w);
  }
}

/** Line `b` merged into `a`: its mail history joins a's. */
export function mergeLineMail(a: Line, b: Line) {
  if (!b.mail) return;
  const m = lineMail(a);
  m.month += b.mail.month; m.last += b.mail.last; m.incomeYear += b.mail.incomeYear; m.incomeLast += b.mail.incomeLast;
}

/**
 * Station `b` becomes part of `a` (Stations.absorb): its mail state joins a's, mail anywhere heading to, changing at or
 * posted at `b` is re-addressed to `a` (mail now at its destination is delivered), also aboard vehicles (`re` maps ids).
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
  const requeue = (st: Station, w: MailWait) => {
    const j = { ...journeyOf(w), o: re(w.o) };
    if (re(w.dest) === st.id) settleMail(g, st, w.count, j, null);
    else addMail(g, st, w.line, re(w.alight), re(w.dest), w.count, j);
  };
  for (const st of g.stations.map.values()) {
    const m = st.mail;
    if (st === b || !m || ![...m.waiting.values()].some((w) => w.alight === b.id || w.dest === b.id || w.o === b.id)) continue;
    const old = [...m.waiting.values()];
    m.waiting.clear(); m.total = 0;
    for (const w of old) requeue(st, w);
  }
  for (const w of moved) requeue(a, w);
  for (const v of g.vehicles.map.values()) {
    if (![...v.mailCargo.values()].some((c) => c.alight === b.id || c.dest === b.id || c.from === b.id || c.o === b.id)) continue;
    const old = [...v.mailCargo.values()];
    v.mailCargo.clear();
    for (const c of old) putMail(v, cargoGroup(re(c.alight), re(c.dest), c.count, re(c.from), { ...journeyOf(c), o: re(c.o) }));
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
/** Add a group to a vehicle's mail (merged with one of the same from:alight:dest:origin, the journeys averaged). */
function putMail(v: Vehicle, c: MailGroup) {
  const k = c.from + ':' + c.alight + ':' + c.dest + ':' + c.o, o = v.mailCargo.get(k);
  if (o) { blend(o, o.count, c, c.count); o.count += c.count; }
  else v.mailCargo.set(k, cargoGroup(c.alight, c.dest, c.count, c.from, c));
}

/** A saved journey (format 3 saves of the first mail build had a leg time `t` / `t0` and no journey). */
function savedJourney(g: Game, d: any, at: number): MailJourney {
  const num = (x: unknown, def: number) => (typeof x === 'number' && Number.isFinite(x) ? x : def);
  const o = num(d?.o, at);
  return {
    o, od: num(d?.od, stationDist(g, o, num(d?.dest, o))), p: num(d?.p, num(d?.t, num(d?.t0, simNow(g)))), c: num(d?.c, 0),
    legs: Array.isArray(d?.legs) ? d.legs.map((l: number[]): MailLeg => [num(l[0], -1), num(l[1], -1), num(l[2], -1), num(l[3], 0)]) : [],
  };
}

/** Restore a vehicle's mail from a save (groups re-keyed, duplicates merged). */
export function restoreMail(g: Game, v: Vehicle, list: any[]) {
  v.mailCargo.clear();
  for (const c of list) putMail(v, cargoGroup(c.alight, c.dest, c.count, c.from, savedJourney(g, c, c.from)));
}

/** Re-target mail whose drop-off is no longer served by the vehicle's pattern (to the next stop; re-keyed). */
export function fixMail(v: Vehicle, l: Line, next: Station | null) {
  if (!next || ![...v.mailCargo.values()].some((c) => !servesStation(l, v.pattern, c.alight))) return;
  const old = [...v.mailCargo.values()];
  v.mailCargo.clear();
  for (const c of old) putMail(v, servesStation(l, v.pattern, c.alight) ? c : cargoGroup(next.id, c.dest, c.count, c.from, c));
}

/**
 * Mail gets off at `st` after riding vehicle `v` from `from`: delivered (paid, by its whole journey), or queued for its
 * next leg (this leg recorded, a change of vehicle unless it walks on to its destination), or lost without a route.
 */
function leaveVehicle(g: Game, v: Vehicle, st: Station, c: MailGroup, n: number): number {
  const line = v.line, from = g.stations.get(c.from), dist = from ? Math.hypot(from.x - st.x, from.z - st.z) : 0;
  if (c.dest === st.id) { v.mailDelivered += n; return settleMail(g, st, n, c, { v, line, dist }); }
  const hop = g.lines.mailNextHop(st.id, c.dest);
  if (!hop) { stationMail(g, st).lostMonth += n; return 0; }
  const dest = g.stations.get(c.dest);
  if (hop.line === WALK_LINE && hop.alight === c.dest && dest) { v.mailDelivered += n; return settleMail(g, dest, n, c, { v, line, dist }); }
  const j = st.id === c.from ? journeyOf(c) : afterLeg(c, v, line, dist, true);
  g.lines.distribute(hop, n, (l, k) => addMail(g, st, l, hop.alight, c.dest, k, j), 'mail', g.mail.random);
  return 0;
}

/** Mail for this station gets off (delivered and paid, or queued for its next leg). Returns the units unloaded. */
export function unloadMail(g: Game, v: Vehicle, st: Station): number {
  let moved = 0, income = 0;
  for (const [k, c] of v.mailCargo) {
    if (c.alight !== st.id) continue;
    v.mailCargo.delete(k);
    income += leaveVehicle(g, v, st, c, c.count);
    moved += c.count;
    v.mailLoad -= c.count;
  }
  if (v.mailLoad < 1e-9) v.mailLoad = 0;
  if (income > 0) g.onIncome(income, v, st);
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
    putMail(v, cargoGroup(w.alight, w.dest, take, st.id, w));
    v.mailLoad += take; room -= take; picked += take;
  }
  if (picked > 0) { m.pickupMonth += picked; lineMail(line).month += picked; }
  return picked;
}

/**
 * Take `units` of a vehicle's mail off at station `st` (a shorter consist, Vehicles.recompose): delivered here, queued
 * again for its next leg (a leg and a change when it rode here), or lost without a station or route. Returns the units.
 */
export function offloadMail(g: Game, v: Vehicle, units: number, st: Station | null): number {
  let left = units;
  for (const [k, c] of [...v.mailCargo]) {
    if (left <= 0) break;
    const n = Math.min(left, c.count);
    c.count -= n; v.mailLoad -= n; left -= n;
    if (c.count <= 0) v.mailCargo.delete(k);
    if (st) leaveVehicle(g, v, st, c, n);
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
/** A station's mail for a save (queues as a list, each group in its fixed key order). */
export function stationMailJSON(m: StationMail): object {
  return { ...m, waiting: [...m.waiting.values()].map((w) => waitGroup(w.line, w.alight, w.dest, w.count, w)) };
}
/** A station's mail from a save: the state without its queues (deserialize re-queues them with restoreMailQueue). */
export function restoreStationMail(d: any): StationMail {
  const num = (x: unknown, def = 0) => (typeof x === 'number' && Number.isFinite(x) ? x : def);
  return {
    ...d, waiting: new Map(), total: 0, rating: num(d?.rating, 0.65), genAccum: num(d?.genAccum),
    genMonth: num(d?.genMonth), genLast: num(d?.genLast), pickupMonth: num(d?.pickupMonth), pickupLast: num(d?.pickupLast),
    arrivedMonth: num(d?.arrivedMonth), arrivedLast: num(d?.arrivedLast), lostMonth: num(d?.lostMonth), lostLast: num(d?.lostLast),
    lastPickup: num(d?.lastPickup), lastKmh: num(d?.lastKmh),
  };
}
/** Re-queue a saved station's mail (groups in their saved order). */
export function restoreMailQueue(g: Game, st: Station, list: any[]) {
  for (const w of list) addMail(g, st, w.line, w.alight, w.dest, w.count, savedJourney(g, w, st.id));
}

// ------------------------------------------------------------------------------ the mail model (game.mail)
/** A site of a mail allocation (allocateMail): a mail station, or a station a forecast adds (key: its id, or below 0). */
interface AllocSite {
  key: number; townId: number;
  /** the buildings it reaches on foot (walking catchment) */
  walk: WalkingCatchment['buildings'];
  /** its feeder quality (MAIL_FEEDER), and the buildings within feeder reach by road (asked for when quality > 0) */
  quality: number; feeders: () => Map<number, number>;
}
/** A place a mail forecast looks at: a station, a planned one, or a site with its walking catchment worked out. */
export type MailPoint = Station | StationPlan | ForecastSite;

/**
 * The mail allocation of these sites (MailModel.mailPop): every building a site reaches on foot is shared by the sites
 * reaching it (walkWeight of the walk, coverOf the best); of the buildings no site reaches, those of a site's town within
 * its feeder reach send MAIL_FEEDER.share x the best quality claiming them, shared by quality / (1 + distance / decay).
 * Weighted by MAIL_TYPE_WEIGHT. Ordered sums: by building id, then the sites' order.
 */
function allocateMail(g: Game, sites: AllocSite[]): Map<number, number> {
  const B = g.world.buildings, out = new Map<number, number>();
  const reach = new Map<number, [number, number][]>();
  for (const s of sites) for (const [bid, w] of s.walk) {
    const list = reach.get(bid), e: [number, number] = [s.key, walkWeight(w.distance)];
    if (list) list.push(e); else reach.set(bid, [e]);
  }
  for (const bid of [...reach.keys()].sort((a, b) => a - b)) {
    const b = B.get(bid);
    if (!b || b.pop <= 0) continue;
    const list = reach.get(bid)!;
    let sum = 0, best = 0;
    for (const [, w] of list) { sum += w; if (w > best) best = w; }
    const mail = b.pop * (MAIL_TYPE_WEIGHT[b.type] ?? 1) * coverOf(best);
    for (const [key, w] of list) out.set(key, (out.get(key) ?? 0) + (mail * w) / sum);
  }
  // mail feeders: the town's buildings no site reaches on foot, by road from the railway stations with frequent mail
  // trains to other towns (the car feeders' geometry: demand.ts feederReach)
  const F = MAIL_FEEDER, claims = new Map<number, { sum: number; q: number; list: [number, number][] }>();
  for (const s of sites) {
    if (!(s.quality > 0)) continue;
    for (const [bid, d] of s.feeders()) {
      if (reach.has(bid)) continue;
      const b = B.get(bid);
      if (!b || b.pop <= 0 || b.townId !== s.townId) continue;
      const w = s.quality / (1 + d / F.decay), c = claims.get(bid);
      if (c) { c.sum += w; c.q = Math.max(c.q, s.quality); c.list.push([s.key, w]); } else claims.set(bid, { sum: w, q: s.quality, list: [[s.key, w]] });
    }
  }
  for (const bid of [...claims.keys()].sort((a, b) => a - b)) {
    const b = B.get(bid)!, c = claims.get(bid)!, mail = b.pop * (MAIL_TYPE_WEIGHT[b.type] ?? 1) * F.share * c.q;
    for (const [key, w] of c.list) out.set(key, (out.get(key) ?? 0) + (mail * w) / c.sum);
  }
  return out;
}
/** Feeder quality of a combined mail frequency (1 / s) at a railway station of a town of `townPop`. */
function feederQualityOf(frequency: number, townPop: number): number {
  const F = MAIL_FEEDER;
  if (!(frequency > 0) || townPop < F.minTownPop) return 0;
  return clamp((F.cutoffHeadway - 1 / frequency) / (F.cutoffHeadway - F.fullHeadway), 0, 1);
}

/**
 * Mail generation, destinations and ratings (Game.mail). Daily (game.ts, after the passengers): every station that
 * accepts mail posts mailPop x mailGenRate x era x town factor x (0.2 + rating) x served units (served: the capture of
 * the towns it reaches x their trip factors, see weights), shared out over its destinations at random rounding (its
 * own random stream), then queues are trimmed and ratings move. Monthly and yearly: the counters roll over.
 */
export class MailModel {
  private rng: RNG | null = null;
  private shareKey = -1;
  private shareTowns = 0;
  private share = new Float64Array(0);
  private dayKey: number[] = [];
  private dests = new Map<number, MailDemand>();
  private pops: Map<number, number> | null = null;

  constructor(private g: Game) {}

  /** Mail's own random stream (seeded from the map, saved once used): mail never draws on the passengers' Game.rng. */
  get random(): RNG { return this.rng ??= new RNG(this.g.options.seed * 131 + 11); }

  /**
   * Weighted residents (MAIL_TYPE_WEIGHT by building) a mail station collects mail from, by mail service alone (the
   * passenger share-out plays no part): every building a mail station reaches on foot is shared by the mail stations
   * reaching it, as passengers share theirs (walkWeight of the walk, coverOf the best); of the buildings no mail station
   * reaches, the post office brings MAIL_FEEDER.share x the quality of the mail service to the railway stations of
   * towns of 1,500+ with frequent mail trains to other towns within reach by road (the passengers' car feeder rules,
   * by mail service). Worked out for the day.
   */
  mailPop(st: Station): number {
    this.refreshDay();
    if (!this.pops) this.pops = this.allocate();
    return this.pops.get(st.id) ?? 0;
  }

  /** The mail allocation of every mail station (see mailPop): the mail stations in id order (allocateMail). */
  private allocate(): Map<number, number> {
    const g = this.g;
    const stations = [...g.lines.mailStations].map((id) => g.stations.get(id)).filter((st): st is Station => !!st && reachable(st)).sort((a, b) => a.id - b.id);
    return allocateMail(g, stations.map((st) => this.site(st, this.feederQuality(st))));
  }

  /** A station as a site of a mail allocation, with this feeder quality. */
  private site(st: Station, quality: number): AllocSite {
    const g = this.g;
    return { key: st.id, townId: st.townId, walk: walkingCatchment(g, st).buildings, quality, feeders: () => g.demand.feederReach(st, MAIL_FEEDER.reach) };
  }

  /**
   * Quality of a station's mail feeders (MAIL_FEEDER), 0..1: a railway station of a town of minTownPop+ by the combined
   * headway of the mail-carrying patterns calling there on railways to other towns (passengers: demand.ts
   * mainlineFrequency). Forecasts leave out `without`'s service and add `extra` (1 / s).
   */
  private feederQuality(st: Station, without?: Line, extra = 0): number {
    const g = this.g, townPop = g.towns.list[st.townId]?.pop ?? 0;
    if (!st.rail || st.townId < 0 || townPop < MAIL_FEEDER.minTownPop) return 0;
    let frequency = extra;
    for (const l of g.lines.map.values()) {
      if (l === without || l.kind !== 'rail' || !l.stops.includes(st.id) || mailFleet(g, l) === 'none') continue;
      if (!l.stops.some((id) => { const s = g.stations.get(id); return !!s?.rail && s.townId !== st.townId; })) continue;
      for (const h of patternHeadways(g, l, 'mail')) {
        const p = linePatterns(l).find((p) => p.id === h.pid);
        if (h.headway > 0 && l.stops.some((id, i) => id === st.id && p?.stops[i] !== false)) frequency += 1 / h.headway;
      }
    }
    return feederQualityOf(frequency, townPop);
  }

  /**
   * Mail populations (mailPop) the points would have as mail stations of a railway with mail trains every `headway`
   * s (forecasts; read-only, nothing cached): they join today's mail stations and share the buildings they reach on
   * foot with them as mail stations do (an existing station by its catchment, a planned one by its plan's); in towns
   * of 1,500+ they get mail feeders by the quality of their mail service with this one (in place of `line`'s own).
   * Planned points are railway stations.
   */
  forecastPops(points: MailPoint[], headway: number, line?: Line): number[] {
    const g = this.g, extra = headway > 0 ? 1 / headway : 0;
    const own = new Set(points.filter((p): p is Station => 'id' in p).map((p) => p.id));
    const sites: AllocSite[] = [];
    for (const id of [...g.lines.mailStations].sort((a, b) => a - b)) {
      const st = g.stations.get(id);
      if (st && reachable(st) && !own.has(id)) sites.push(this.site(st, this.feederQuality(st)));
    }
    const keys = points.map((p, i) => ('id' in p ? p.id : -1 - i));
    points.forEach((p, i) => {
      if ('id' in p) { if (reachable(p)) sites.push(this.site(p, this.feederQuality(p, line, extra))); return; }
      const townId = 'townId' in p ? p.townId : g.towns.nearest(p.x, p.z)?.id ?? -1;
      const walk = 'walk' in p ? p.walk.buildings : planWalkingCatchment(g, p).buildings;
      const access = 'access' in p && p.access ? p.access.tracks.flatMap((t) => [t.start, t.end]) : undefined;
      sites.push({ key: keys[i], townId, walk, quality: feederQualityOf(extra, g.towns.list[townId]?.pop ?? 0), feeders: () => g.demand.feederReachAt(p, access, MAIL_FEEDER.reach) });
    });
    const pops = allocateMail(g, sites);
    return keys.map((k) => pops.get(k) ?? 0);
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
   * ties: the lower id), weighted by the town share and mailTripFactor of the routed time, scaled by the capture of
   * the share reached (MAIL_CAPTURE, as the passengers' local capture). Cached for the day.
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
    let reached = 0;
    for (const U of [...best.keys()].sort((a, b) => a - b)) {
      const s = T < n && U < n ? share[T * n + U] : 0;
      if (!(s > 0)) continue;
      const b = best.get(U)!, ds = g.stations.get(b.d)!;
      dest.push(b.d); w.push(s * mailTripFactor(Math.hypot(ds.x - st.x, ds.z - st.z), b.hop.cost)); reached += s;
    }
    const k = reached > 0 ? mailCapture(reached) / reached : 0;
    let served = 0;
    for (let i = 0; i < w.length; i++) { w[i] *= k; served += w[i]; }
    const res: MailDemand = { dest, w, served };
    this.dests.set(st.id, res);
    return res;
  }

  /**
   * Day caches (destinations, mail allocations) hold for the day while routing, demand, the network, catchments,
   * stations, lots and terrain stay as they are.
   */
  private refreshDay() {
    const g = this.g, w = g.world, k = this.dayKey;
    if (k[0] === g.day && k[1] === g.lines.version && k[2] === g.demand.version && k[3] === g.networkVersion && k[4] === g.stations.catchVersion &&
      k[5] === g.stations.walkVersion && k[6] === w.lotVersions.version && k[7] === w.terrainVersions.version && k[8] === w.net.roadVersions.version) return;
    this.dayKey = [g.day, g.lines.version, g.demand.version, g.networkVersion, g.stations.catchVersion, g.stations.walkVersion,
      w.lotVersions.version, w.terrainVersions.version, w.net.roadVersions.version];
    this.dests.clear();
    this.pops = null;
  }

  /** Units a station posts per day at its current rating and service (for the UI and estimates; 0 where it accepts none). */
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
      const j: MailJourney = { o: st.id, od: stationDist(g, st.id, d), p: now, c: 0, legs: [] };
      g.lines.distribute(hop, c, (line, k) => addMail(g, st, line, hop.alight, d, k, j), 'mail', rng);
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
