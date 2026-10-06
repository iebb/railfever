// Mail decisions for passenger railways. Forecasts are read-only; consists change at platform stops.
import type { AIController, LineInfo } from './ai';
import { modelYearCost } from './ai';
import type { Game } from './game';
import type { Line } from './lines';
import { railModeOf, railPartMode } from './stations';
import { MAIL_STATION, DAY_SECONDS } from './constants';
import { mailEra, mailGenRate, townMailFactor, mailQueueCap, mailQueueCapOf, mailCapture, routedJourney, type MailPoint } from './mail';
import { mailFare, mailTripFactor, estimateLegTime } from './fares';
import { lineTable } from './patterns';
import { Train } from './train';
import { prospectiveWalkGroups } from './catchment';
import { availableModels, carriesMail, MODEL_BY_ID, type VehicleModel } from './vehicle-types';

const YEAR = 360;
const YEAR_SECONDS = YEAR * DAY_SECONDS;
const MARGIN = 1.5;
// Vehicles.recomposeError requires this much platform behind the new tail.
const PLATFORM_CLEARANCE = 0.05;
type MailSite = MailPoint;
/** Only van targets are queued: intervening passenger changes must survive the platform operation. */
export type MailQueue = [number, string[]][];
export interface MailLoad { capacity: number; lowSince: number }
export interface MailPolicyState { mailQueue: MailQueue; mailLoads: [number, MailLoad][] }

export const mailVans = (t: Train): VehicleModel[] => t.madeUp.filter((m) => m.kind === 'wagon' && carriesMail(m));
export const mailVanLength = (t: Train): number => mailVans(t).reduce((s, m) => s + m.length + 0.1, 0);
const lengthOf = (cars: VehicleModel[]) => cars.reduce((s, m) => s + m.length + 0.1, 0);
const platformOf = (g: Game, l: Line) => Math.min(...l.stops.map((id) => g.stations.get(id)?.rail?.length ?? 0));
const mainlineSite = (p: MailSite) => !('rail' in p && p.rail
  ? railPartMode(p.rail) !== 'mainline' || p.rail.trackType === 'highspeed'
  : 'trackType' in p && (railModeOf('mode' in p && typeof p.mode === 'string' ? p.mode : p.trackType) !== 'mainline' || p.trackType === 'highspeed'));
const hauled = (cars: VehicleModel[]) => cars.some((m) => m.kind === 'loco')
  && cars.some((m) => m.capacity > 0) && cars.every((m) => m.kind === 'loco' || m.kind === 'wagon');

function withVans(cars: VehicleModel[], vans: VehicleModel[]): VehicleModel[] {
  return [...cars.filter((m) => m.kind === 'loco'), ...vans,
    ...cars.filter((m) => m.kind !== 'loco' && !carriesMail(m))];
}

/** A passenger replacement retains the current vans, including a change made after it was queued. */
export function keepMailVans(t: Train, cars: VehicleModel[] | null, platform: number): VehicleModel[] | null {
  if (!cars) return null;
  const result = withVans(cars, mailVans(t));
  // A mail addition may have used room after the passenger replacement was queued.
  while (lengthOf(result) + PLATFORM_CLEARANCE > platform) {
    let at = result.length - 1;
    while (at >= 0 && !(result[at].kind === 'wagon' && !carriesMail(result[at]))) at--;
    if (at < 0 || result.filter((m) => m.capacity > 0).length <= 1) return null;
    result.splice(at, 1);
  }
  return result;
}

export function pickMailVan(year: number, cars: VehicleModel[]): VehicleModel | null {
  if (!hauled(cars)) return null;
  const speed = Math.min(...cars.map((m) => m.speed));
  const value = (m: VehicleModel) => (m.mail ?? 0) / (modelYearCost(m, year) + m.cost / 8);
  return availableModels(year, 'wagon', true).filter((m) => m.speed >= speed)
    .sort((a, b) => value(b) - value(a))[0] ?? null;
}

const townOf = (g: Game, p: MailSite) => ('townId' in p ? p.townId : g.towns.nearest(p.x, p.z)?.id ?? -1);
/** People can reach it: a station unless its road access is known to be missing (mail.ts), a plan with road access. */
const reachableSite = (p: MailSite) => ('id' in p ? p.roadAccess !== false : !('roadAccess' in p) || !!p.roadAccess);

/**
 * Annual mail receipts of a railway through `points` with mail vans of `capacity` units on trains every `headway` s, by
 * the rules of the real receipts (mail.ts, fares.ts):
 *  - a line already carrying mail: every accepting station's mail (its rate and destinations) whose routed journey
 *    rides the line, at the line's share of each journey's receipts (by the distances its legs carry);
 *  - otherwise (a project, or a line without vans yet): its points as mail stations (MailModel.forecastPops: catchments
 *    shared with the other mail stations, mail feeders by this service), posting by era, town size, rating and the
 *    capture of the towns the line reaches, each to the fastest point of each other town, direct.
 * Whole journeys pay mailFare (distance from posting, time to delivery, x 0.9 per change), within the vans' room per
 * departure at each boarding station. Read-only: no mail state, no random numbers.
 */
export function forecastMailRevenue(g: Game, points: MailSite[], kmh: number, headway: number, capacity: number, line?: Line): number {
  if (points.length < 2 || !(kmh > 0) || !(headway > 0) || !(capacity > 0)) return 0;
  if (line && line.vehicles.some((id) => (g.vehicles.get(id)?.mailCapacity ?? 0) > 0)) return routedRevenue(g, line, headway, capacity);
  return directRevenue(g, points, kmh, headway, capacity, line);
}

/** Receipts of the mail riding `line` now (forecastMailRevenue), its room per departure `capacity`. */
function routedRevenue(g: Game, line: Line, headway: number, capacity: number): number {
  const board = new Map<number, { units: number; receipts: number }>();
  const part = (lines: number[]) => {
    // mail is shared over parallel lines by their mail fleets (Lines.distribute)
    const w = lines.map((id) => Math.max(1, g.lines.fleetSize(id, 'mail')));
    return w[lines.indexOf(line.id)] / w.reduce((a, b) => a + b, 0);
  };
  for (const st of [...g.stations.map.values()].sort((a, b) => a.id - b.id)) {
    if (!g.mail.accepts(st)) continue;
    const dw = g.mail.weights(st);
    if (!(dw.served > 0)) continue;
    const daily = g.mail.rate(st);
    for (let j = 0; j < dw.dest.length; j++) {
      const jr = routedJourney(g, st.id, dw.dest[j]);
      if (!jr || !jr.legs.some((l) => l.lines.includes(line.id))) continue;
      const units = (daily * YEAR * dw.w[j]) / dw.served, fare = mailFare(jr.od, jr.seconds, 1, jr.changes);
      const total = jr.legs.reduce((s, l) => s + l.dist, 0);
      for (const leg of jr.legs) {
        if (!leg.lines.includes(line.id)) continue;
        const u = units * part(leg.lines), e = board.get(leg.from) ?? { units: 0, receipts: 0 };
        e.units += u;
        e.receipts += u * fare * (total > 0 ? leg.dist / total : 1 / jr.legs.length);
        board.set(leg.from, e);
      }
    }
  }
  let revenue = 0;
  for (const [id, e] of [...board].sort(([a], [b]) => a - b)) {
    const st = g.stations.get(id), room = (YEAR_SECONDS / headway) * Math.min(capacity, st ? mailQueueCap(g, st) : capacity);
    revenue += e.receipts * Math.min(1, room / Math.max(1, e.units));
  }
  return revenue;
}

/** Receipts of direct mail between the points of a new mail service (forecastMailRevenue). */
function directRevenue(g: Game, points: MailSite[], kmh: number, headway: number, capacity: number, line?: Line): number {
  const { n, share } = g.mail.townShares();
  const pops = g.mail.forecastPops(points, headway, line);
  const towns = points.map((p) => townOf(g, p));
  const groups = prospectiveWalkGroups(g, points).groups;
  const ok = points.map((p, i) => towns[i] >= 0 && towns[i] < n && reachableSite(p) && pops[i] >= MAIL_STATION.acceptPop);
  const table = line ? lineTable(g, line) : null;
  let revenue = 0;
  for (let i = 0; i < points.length; i++) {
    if (!ok[i]) continue;
    const p = points[i], T = towns[i];
    // per other town the point its mail is fastest to (ties: the lower station id, as MailModel.weights)
    const best = new Map<number, { j: number; seconds: number }>();
    for (let j = 0; j < points.length; j++) {
      const U = towns[j], q = points[j];
      if (!ok[j] || U === T) continue;
      if (groups[i] === groups[j]) continue;
      const d = Math.hypot(q.x - p.x, q.z - p.z);
      const seconds = table && 'id' in p && 'id' in q
        ? table.edges.find((e) => e.from === p.id && e.to === q.id)?.cost
        : estimateLegTime(d, kmh, headway, 1.05);
      if (seconds === undefined) continue;
      const old = best.get(U);
      const tie = 'id' in q ? q.id : j;
      const oldPoint = old && points[old.j], oldTie = oldPoint && 'id' in oldPoint ? oldPoint.id : old?.j ?? Infinity;
      if (!old || seconds < old.seconds || (seconds === old.seconds && tie < oldTie)) best.set(U, { j, seconds });
    }
    // the destinations' weights and the capture of the towns reached (MailModel.weights), direct journeys
    const parts: { w: number; fare: number }[] = [];
    let reached = 0;
    for (const [U, b] of [...best].sort(([a], [b]) => a - b)) {
      const s = share[T * n + U];
      if (!(s > 0)) continue;
      const q = points[b.j], d = Math.hypot(q.x - p.x, q.z - p.z);
      parts.push({ w: s * mailTripFactor(d, b.seconds), fare: mailFare(d, b.seconds, 1) });
      reached += s;
    }
    if (!parts.length) continue;
    const k = mailCapture(reached) / reached;
    const daily = pops[i] * mailGenRate() * mailEra(g.year) * townMailFactor(g.towns.list[T]?.pop ?? 0)
      * (0.2 + ('mail' in p ? p.mail?.rating ?? 0.65 : 0.65));
    const units = parts.map((x) => daily * YEAR * x.w * k), total = units.reduce((a, b) => a + b, 0);
    const tracks = 'id' in p ? p.rail?.tracks ?? 0 : 'tracks' in p ? p.tracks ?? 2 : 2, stops = 'id' in p ? p.stops.length : 0;
    const room = (YEAR_SECONDS / headway) * Math.min(capacity, mailQueueCapOf(pops[i], tracks, stops));
    const fit = Math.min(1, room / Math.max(1, total));
    revenue += parts.reduce((s, x, k) => s + units[k] * x.fare, 0) * fit;
  }
  return revenue;
}

/** Mail's operating contribution with the selected vans and their costs; potential is conditional on buying vans. */
export function projectMail(g: Game, points: MailSite[], cars: VehicleModel[], fleet: number, kmh: number, headway: number, platform: number) {
  const none = { revenue: 0, potential: 0, yearly: 0, price: 0, cars };
  if (!points.every(mainlineSite) || !hauled(cars)) return none;
  const van = pickMailVan(g.year, cars);
  if (!van || lengthOf(cars) + van.length + 0.1 + PLATFORM_CLEARANCE > platform) return none;
  const revenue = forecastMailRevenue(g, points, kmh, headway, van.mail!);
  const yearly = modelYearCost(van, g.year) * fleet;
  if (revenue < MARGIN * (yearly + van.cost * fleet / 8)) return { ...none, potential: revenue };
  return { revenue, potential: revenue, yearly, price: van.cost, cars: withVans(cars, [van]) };
}

export class MailPolicy {
  mailQueue: MailQueue = [];
  mailLoads = new Map<number, MailLoad>();
  constructor(private ai: AIController) {}
  private get g() { return this.ai.game; }

  private eligible(l: Line, info: LineInfo | undefined): boolean {
    return l.kind === 'rail' && l.owner === this.ai.companyId && !info?.urban && !info?.hsr
      && l.stops.every((id) => { const st = this.g.stations.get(id); return !!st?.rail && mainlineSite(st); });
  }

  /** Extensions can include older, shorter platforms beyond the two sites used to evaluate the project. */
  openingCars(l: Line, cars: VehicleModel[]): VehicleModel[] {
    if (!cars.some(carriesMail)) return cars;
    return this.eligible(l, this.ai.railLineInfo(l.id)) && lengthOf(cars) + PLATFORM_CLEARANCE <= platformOf(this.g, l)
      ? [...cars] : cars.filter((m) => !carriesMail(m));
  }

  hasPending(trains: Train[]): boolean { return this.mailQueue.some(([id]) => trains.some((t) => t.id === id)); }

  /** Moving the same vans to a longer train does not restart their year of observed use. */
  replaced(from: Train, to: Train) {
    const s = this.mailLoads.get(from.id);
    if (s && s.capacity === to.mailCapacity) this.mailLoads.set(to.id, { ...s });
    this.mailLoads.delete(from.id);
    for (const q of this.mailQueue) if (q[0] === from.id) q[0] = to.id;
  }

  /** Cheap tick hook: observes loads and fits queued vans at the next platform, even while the AI is idle. */
  step() {
    const g = this.g;
    const fleet = g.vehicles.trains().filter((t) => t.owner === this.ai.companyId);
    for (const t of fleet) {
      if (!t.mailCapacity) { this.mailLoads.delete(t.id); continue; }
      let s = this.mailLoads.get(t.id);
      if (!s || s.capacity !== t.mailCapacity) {
        s = { capacity: t.mailCapacity, lowSince: g.day }; this.mailLoads.set(t.id, s);
      }
      // Fill the earlier vans first: an unused second van can be removed even when the first earns its keep.
      // Observe every tick, so a short useful trip between daily samples also interrupts the underuse year.
      const last = mailVans(t).at(-1), room = last?.mail ?? t.mailCapacity;
      if (Math.max(0, t.mailLoad - (t.mailCapacity - room)) >= room * 0.1) s.lowSince = g.day;
    }
    for (const id of this.mailLoads.keys()) if (!g.vehicles.get(id) || g.vehicles.get(id)!.owner !== this.ai.companyId) this.mailLoads.delete(id);
    for (let i = this.mailQueue.length - 1; i >= 0; i--) {
      const [id, ids] = this.mailQueue[i], t = g.vehicles.get(id), l = t?.line;
      if (!(t instanceof Train) || t.owner !== this.ai.companyId || !l || !this.eligible(l, this.ai.railLineInfo(l.id)) || !hauled(t.madeUp)) {
        this.mailQueue.splice(i, 1); continue;
      }
      const vans = ids.map((id) => MODEL_BY_ID.get(id)).filter((m): m is VehicleModel => !!m && m.kind === 'wagon' && carriesMail(m)).slice(0, 2);
      const cars = withVans(t.madeUp, vans);
      if (lengthOf(cars) > t.length && lengthOf(cars) + PLATFORM_CLEARANCE > platformOf(g, l)) { this.mailQueue.splice(i, 1); continue; }
      // An idle van need not wait for a train that never leaves its depot. Additions still wait for a platform.
      if (t.state !== 'loading' && !(!t.onMap && vans.length < mailVans(t).length)) continue;
      if (vans.length > mailVans(t).length && (this.ai.railPolicy.deepTrouble || this.ai.railPolicy.account(l).step > 0)) {
        this.mailQueue.splice(i, 1); continue;
      }
      if (g.vehicles.recompose(t, cars)) continue;
      this.mailQueue.splice(i, 1);
      this.mailLoads.delete(id);
      this.ai.railNote(`${l.name}: ${vans.length} mail van${vans.length === 1 ? '' : 's'} on ${t.name}`);
    }
  }

  /** Called by manage, at most annually and only after a line's first six months. */
  manage(l: Line, info: LineInfo) {
    const g = this.g;
    if (!this.eligible(l, info) || g.day - info.opened < 180 || g.day - (info.mailLook ?? -1e9) < YEAR) return;
    const trains = l.vehicles.map((id) => g.vehicles.get(id)).filter((v): v is Train => v instanceof Train && v.owner === this.ai.companyId);
    if (!trains.length || !trains.every((t) => hauled(t.madeUp))) return;
    info.mailLook = g.day;
    const queue = (t: Train, vans: VehicleModel[]) => {
      if (!this.mailQueue.some(([id]) => id === t.id)) this.mailQueue.push([t.id, vans.map((m) => m.id)]);
    };
    for (const t of trains) {
      const vans = mailVans(t), load = this.mailLoads.get(t.id);
      if (vans.length && load && g.day - load.lowSince >= YEAR) queue(t, vans.slice(0, -1));
    }
    if (this.ai.railPolicy.deepTrouble || this.ai.railPolicy.account(l).step > 0 || this.mailQueue.some(([id]) => trains.some((t) => t.id === id))) return;
    const van = pickMailVan(g.year, trains[0].madeUp);
    if (!van) return;
    let waiting = 0;
    for (const sid of new Set(l.stops)) for (const w of g.stations.get(sid)?.mail?.waiting.values() ?? []) if (w.line === l.id) waiting += w.count;
    const targets = trains.map((t) => {
      const vans = mailVans(t);
      return vans.length < 2 && (!vans.length || waiting > MARGIN * (vans[0].mail ?? van.mail!)) ? [...vans, van] : vans;
    });
    if (targets.every((vs, i) => vs.length === mailVans(trains[i]).length)) return;
    const platform = platformOf(g, l);
    if (targets.some((vs, i) => lengthOf(withVans(trains[i].madeUp, vs)) + PLATFORM_CLEARANCE > platform)) return;
    const times = lineTable(g, l).pats;
    if (!times.length) return;
    const headway = 1 / times.reduce((s, p) => s + p.freq, 0);
    const kmh = Math.min(...trains.map((t) => t.maxSpeedKmh)) * 0.6;
    const capacity = Math.min(...targets.map((vs) => vs.reduce((s, m) => s + m.mail!, 0)));
    const points = [...new Set(l.stops)].map((id) => g.stations.get(id)!);
    const revenue = forecastMailRevenue(g, points, kmh, headway, capacity, l) * trains.length / Math.max(1, l.vehicles.length);
    const annual = targets.flat().reduce((s, m) => s + modelYearCost(m, g.year) + m.cost / 8, 0);
    const cost = targets.reduce((s, vs, i) => s + vs.slice(mailVans(trains[i]).length).reduce((s, m) => s + m.cost, 0), 0);
    if (revenue < MARGIN * annual || cost > this.ai.available() || cost > g.company(this.ai.companyId).economy.money) return;
    for (let i = 0; i < trains.length; i++) if (targets[i].length !== mailVans(trains[i]).length) queue(trains[i], targets[i]);
  }

  /** Saved once it holds something: an AI without vans or queued van changes saves as before mail. */
  save(): Partial<MailPolicyState> {
    const out: Partial<MailPolicyState> = {};
    if (this.mailQueue.length) out.mailQueue = this.mailQueue.map(([id, vans]) => [id, [...vans]]);
    if (this.mailLoads.size) out.mailLoads = [...this.mailLoads].map(([id, s]) => [id, { ...s }]);
    return out;
  }
  load(s: Partial<MailPolicyState>) {
    this.mailQueue = (s.mailQueue ?? []).map(([id, vans]) => [id, [...vans]]);
    this.mailLoads = new Map((s.mailLoads ?? []).map(([id, v]) => [id, { ...v }]));
  }
}
