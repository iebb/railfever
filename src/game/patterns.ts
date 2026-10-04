// Service patterns: several stopping patterns on one line — all-stops locals, rapids and expresses that skip
// smaller stations, and short-turns. `Line.patterns` lists them (absent: one all-stops local); a vehicle runs
// `Vehicle.pattern` (absent or unknown: the line's first pattern). A pattern's first and last stopping stations
// are its termini: its trains turn there. A vehicle targets only the stops of its pattern, so it passes the others
// without stopping (through tracks where the station has them — routing prefers them —, else a platform track at
// up to PLATFORM_PASS_KMH, see train.ts makeSeg). A stopping train holds (bounded) at a station with a passing
// track when a faster train is about to pass. Passengers board only vehicles whose pattern stops where they alight,
// and only the services worth taking (attractive sets: waiting for an express can beat taking the local now);
// passenger routing weighs waiting, riding and transfers by time (lineGraph). Two lines whose routes are a subset /
// superset of each other are one line with patterns (canonicalizeLines).
import type { Game } from './game';
import type { Line } from './lines';
import type { Vehicle } from './vehicle';
import type { Train, TSeg } from './train';
import type { Station } from './stations';
import { TRACK_TYPES, UNIT_M, type Cargo } from './constants';
import { consistOf, hopEstimate } from './opcosts';
import type { VehicleModel } from './vehicle-types';
import type { NEdge } from './network';
import { outAndBack } from './lines';
import { consistRule, findRailRoute, railNext, ruleAllows, lineCompatibility } from './train';
import type { Cont, TrackRule } from './train';
import { tramUsable } from './build-ops';
import { simNow } from './fares';
import { redirectMail, mergeLineMail } from './mail';

export type PatternKind = 'local' | 'rapid' | 'express' | 'limited';
export interface ServicePattern {
  id: number;
  name: string;
  kind: PatternKind;
  /** per line stop (Line.stops index): does the pattern stop there? */
  stops: boolean[];
  /** the line's stops these flags were set for (they are re-mapped when the line's stops change) */
  ids?: number[];
}
export const PATTERN_KINDS: PatternKind[] = ['local', 'rapid', 'express', 'limited'];
export const PATTERN_LABEL: Record<PatternKind, string> = { local: 'Local', rapid: 'Rapid', express: 'Express', limited: 'Limited Express' };
/** Trains pass a station's platform track (no through track) at most this fast (km/h). */
export const PLATFORM_PASS_KMH = 120;
/** A stopping train waits at most this long (sim seconds) for a faster train to pass. */
export const HOLD_MAX_S = 120;
/** ... for a faster train due within this time. */
export const HOLD_LOOK_S = 75;
/** Routing: changing vehicles costs this much (s, ~6 min equivalent) on top of the walk and the next wait. */
export const TRANSFER_PENALTY_S = 360;
/** Routing: walking to another platform of the same station (s). */
export const PLATFORM_CHANGE_S = 45;
/** Dwell assumed per stop (s) in the timetables of the line graph. */
const DWELL = { rail: 10, road: 6 };

// ------------------------------------------------------------------------------ line routes
/** Turning index of an out-and-back stop list (A, B, C, B -> 2; A, B -> 1), else -1. */
export function turnIndex(stops: number[]): number {
  const n = stops.length;
  if (n === 2) return stops[0] !== stops[1] ? 1 : -1;
  if (n < 2 || n % 2) return -1;
  const k = n / 2;
  for (let i = 1; i < k; i++) if (stops[k + i] !== stops[k - i]) return -1;
  const path = stops.slice(0, k + 1);
  return new Set(path).size === path.length ? k : -1;
}
/** Is the line a loop (explicit Line.loop, else 3+ stops, each station once)? (= Lines.isLoop) */
export function isLoopLine(l: Line): boolean { return l.loop ?? (l.stops.length >= 3 && new Set(l.stops).size === l.stops.length); }

/** A line's route: its stations in order (out-and-back: from one end to the other) and its shape. */
export interface Route { stations: number[]; loop: boolean; turn: number }
export function lineRoute(l: Line): Route {
  const turn = turnIndex(l.stops);
  if (turn > 0) return { stations: l.stops.slice(0, turn + 1), loop: false, turn };
  return { stations: [...l.stops], loop: isLoopLine(l), turn: -1 };
}

// ------------------------------------------------------------------------------ patterns of a line
/** Re-map a pattern's flags when the line's stops changed (by station and occurrence; new stops: stop). */
function align(l: Line, p: ServicePattern) {
  const ids = l.stops;
  const old = p.ids;
  if (old && old.length === ids.length && p.stops.length === ids.length) {
    let same = true;
    for (let i = 0; i < ids.length; i++) if (old[i] !== ids[i]) { same = false; break; }
    if (same) return;
  }
  if (!old) {
    // flags without the stops they were set for: by index
    const out = ids.map((_, i) => p.stops[i] !== false);
    p.stops = out; p.ids = [...ids];
    return;
  }
  const occ = new Map<number, number[]>();
  old.forEach((s, i) => { const a = occ.get(s); if (a) a.push(i); else occ.set(s, [i]); });
  const used = new Map<number, number>();
  p.stops = ids.map((s) => {
    const a = occ.get(s);
    if (!a) return true;
    const k = used.get(s) ?? 0;
    used.set(s, k + 1);
    return p.stops[a[Math.min(k, a.length - 1)]] !== false;
  });
  p.ids = [...ids];
}

/** The line's patterns (absent: one all-stops local, id 0), each aligned with the current stops. */
export function linePatterns(l: Line): ServicePattern[] {
  if (!l.patterns || !l.patterns.length) return [{ id: 0, name: PATTERN_LABEL.local, kind: 'local', stops: l.stops.map(() => true), ids: [...l.stops] }];
  for (const p of l.patterns) align(l, p);
  return l.patterns;
}

/** The pattern a vehicle with pattern id `pid` runs (unknown or unset: the first), or null when the line has none. */
export function patternOf(l: Line, pid?: number): ServicePattern | null {
  const ps = l.patterns;
  if (!ps || !ps.length) return null;
  const p = (pid !== undefined ? ps.find((q) => q.id === pid) : undefined) ?? ps[0];
  align(l, p);
  return p;
}

/** Flags of the stops a pattern serves (a pattern serving fewer than 2 stations serves all). */
function servedFlags(l: Line, p: ServicePattern | null): boolean[] {
  if (!p) return l.stops.map(() => true);
  let n = 0;
  const seen = new Set<number>();
  for (let i = 0; i < l.stops.length; i++) if (p.stops[i] !== false && !seen.has(l.stops[i])) { seen.add(l.stops[i]); n++; }
  return n >= 2 ? l.stops.map((_, i) => p.stops[i] !== false) : l.stops.map(() => true);
}

/** Does a vehicle running pattern `pid` stop at the line's stop index `i`? */
export function stopsAt(l: Line, pid: number | undefined, i: number): boolean {
  const p = patternOf(l, pid);
  if (!p) return true;
  return servedFlags(l, p)[i] ?? true;
}

/** Stop indices a pattern serves. */
export function patternStops(l: Line, pid?: number): number[] {
  const f = servedFlags(l, patternOf(l, pid));
  const out: number[] = [];
  f.forEach((x, i) => { if (x) out.push(i); });
  return out;
}

/** Does the pattern stop at this station (at any of its stop indices)? */
export function servesStation(l: Line, pid: number | undefined, stationId: number): boolean {
  const f = servedFlags(l, patternOf(l, pid));
  for (let i = 0; i < l.stops.length; i++) if (f[i] && l.stops[i] === stationId) return true;
  return false;
}

/**
 * The next stop index a vehicle of pattern `pid` targets after index `from`: the next served index whose station
 * differs from the current one (a short-turn serves the turning station once and heads back).
 */
export function nextStopIndex(l: Line, pid: number | undefined, from: number): number {
  const n = l.stops.length;
  if (!n) return 0;
  const f = servedFlags(l, patternOf(l, pid));
  const cur = l.stops[((from % n) + n) % n];
  let first = -1;
  for (let k = 1; k <= n; k++) {
    const j = (from + k) % n;
    if (!f[j]) continue;
    if (first < 0) first = j;
    if (l.stops[j] !== cur) return j;
  }
  return first >= 0 ? first : (from + 1) % n;
}

/** The pattern's termini (stop indices of its first and last stopping stations along the line's route). */
export function patternTermini(l: Line, pid?: number): number[] {
  const f = servedFlags(l, patternOf(l, pid));
  const r = lineRoute(l);
  if (r.loop) return [];
  const pos = new Map(r.stations.map((s, i) => [s, i]));
  let lo = Infinity, hi = -Infinity;
  l.stops.forEach((s, i) => { if (f[i]) { const p = pos.get(s) ?? 0; lo = Math.min(lo, p); hi = Math.max(hi, p); } });
  const out: number[] = [];
  l.stops.forEach((s, i) => { const p = pos.get(s); if (f[i] && (p === lo || p === hi)) out.push(i); });
  return out;
}

/** Kind of a set of flags on the line: local (all stops within its termini; short-turns too), rapid or express. */
export function classifyFlags(l: Line, flags: boolean[]): { kind: PatternKind; shortTurn: boolean; skipped: number; served: number } {
  const r = lineRoute(l);
  const pos = new Map(r.stations.map((s, i) => [s, i]));
  const servedSt = new Set<number>();
  l.stops.forEach((s, i) => { if (flags[i]) servedSt.add(s); });
  let lo = Infinity, hi = -Infinity;
  for (const s of servedSt) { const p = pos.get(s) ?? 0; lo = Math.min(lo, p); hi = Math.max(hi, p); }
  let skipped = 0;
  if (r.loop) skipped = r.stations.length - servedSt.size;
  else for (let i = lo + 1; i < hi; i++) if (!servedSt.has(r.stations[i])) skipped++;
  const shortTurn = !r.loop && (lo > 0 || hi < r.stations.length - 1);
  const inner = r.loop ? r.stations.length : Math.max(1, hi - lo - 1);
  const kind: PatternKind = skipped === 0 ? 'local' : skipped <= Math.max(1, Math.floor(inner / 3)) ? 'rapid' : servedSt.size <= 3 ? 'limited' : 'express';
  return { kind, shortTurn, skipped, served: servedSt.size };
}

/** A name for a pattern: its kind (given, else by its stops), and its termini for a short-turn ("Local Weyport – Ashwick"). */
export function patternName(g: Game, l: Line, flags: boolean[], kind?: PatternKind): string {
  const c = classifyFlags(l, flags);
  const kd = kind ?? c.kind;
  if (!c.shortTurn) return PATTERN_LABEL[kd];
  const r = lineRoute(l);
  const st = r.stations.filter((s) => l.stops.some((x, i) => x === s && flags[i]));
  const nm = (id: number) => g.stations.get(id)?.name ?? '?';
  return `${PATTERN_LABEL[kd]} ${nm(st[0])} – ${nm(st[st.length - 1])}`;
}

/**
 * The vehicles of a line that carry `cargo`, by pattern id (vehicles without a known pattern run the first).
 * Passengers: every vehicle but the mail-only ones (Vehicle.carries).
 */
export function vehiclesByPattern(g: Game, l: Line, cargo: Cargo = 'pax'): Map<number, Vehicle[]> {
  const ps = linePatterns(l);
  const out = new Map<number, Vehicle[]>(ps.map((p) => [p.id, []]));
  for (const id of l.vehicles) {
    const v = g.vehicles.get(id);
    if (!v || !v.carries(cargo)) continue;
    const pid = v.pattern !== undefined && out.has(v.pattern) ? v.pattern : ps[0].id;
    out.get(pid)!.push(v);
  }
  return out;
}

// ------------------------------------------------------------------------------ editing patterns
/** Normalise a pattern list for a line: ids unique, flags aligned, at least 2 stations served each. */
function normalize(l: Line, list: ServicePattern[]): ServicePattern[] {
  const out: ServicePattern[] = [];
  const ids = new Set<number>();
  for (const p0 of list) {
    let id = Math.max(0, Math.floor(p0.id));
    while (ids.has(id)) id++;
    ids.add(id);
    const p: ServicePattern = { id, name: String(p0.name ?? '').slice(0, 40) || PATTERN_LABEL[p0.kind] || 'Local', kind: PATTERN_KINDS.includes(p0.kind) ? p0.kind : 'local', stops: [...p0.stops], ids: p0.ids ? [...p0.ids] : undefined };
    align(l, p);
    p.stops = servedFlags(l, p);
    out.push(p);
  }
  return out;
}

/** Re-plan the line's vehicles and the passenger routing after its patterns changed. */
function patternsChanged(g: Game, l: Line) {
  const known = new Set(linePatterns(l).map((p) => p.id));
  for (const id of l.vehicles) {
    const v = g.vehicles.get(id);
    if (!v) continue;
    if (v.pattern !== undefined && !known.has(v.pattern)) v.pattern = undefined;
    v.resetSpacing();
    v.fixCargo();
  }
  g.lines.rebuild();
  for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged();
}

/** Replace a line's patterns (empty or null: back to one all-stops local). Null = OK, else why not. */
export function setPatterns(g: Game, lineId: number, list: ServicePattern[] | null): string | null {
  const l = g.lines.get(lineId);
  if (!l) return 'No such line';
  if (!list || !list.length) delete l.patterns;
  else l.patterns = normalize(l, list);
  patternsChanged(g, l);
  return null;
}

/**
 * Add a pattern to a line (the implicit local becomes pattern 0 first). `stops`: flags per line stop (default: all
 * stops). Returns the new pattern.
 */
export function addPattern(g: Game, lineId: number, kind: PatternKind = 'express', stops?: boolean[], name?: string): ServicePattern | null {
  const l = g.lines.get(lineId);
  if (!l) return null;
  const list = l.patterns && l.patterns.length ? linePatterns(l) : linePatterns(l).map((p) => ({ ...p }));
  const id = list.reduce((m, p) => Math.max(m, p.id + 1), 0);
  const flags = stops ? l.stops.map((_, i) => stops[i] !== false) : l.stops.map(() => true);
  const p: ServicePattern = { id, name: name ?? patternName(g, l, flags, kind), kind, stops: flags, ids: [...l.stops] };
  l.patterns = normalize(l, [...list, p]);
  patternsChanged(g, l);
  return l.patterns.find((q) => q.id === id) ?? null;
}

/** Remove a pattern (its vehicles run the first pattern then); the last one cannot be removed. */
export function removePattern(g: Game, lineId: number, pid: number): string | null {
  const l = g.lines.get(lineId);
  if (!l || !l.patterns) return 'No such pattern';
  if (l.patterns.length <= 1) return 'A line keeps at least one pattern';
  l.patterns = l.patterns.filter((p) => p.id !== pid);
  patternsChanged(g, l);
  return null;
}

/** Run a vehicle on one of its line's patterns (undefined: the first). */
export function setVehiclePattern(g: Game, vehicleId: number, pid: number | undefined): string | null {
  const v = g.vehicles.get(vehicleId);
  const l = v?.line;
  if (!v || !l) return 'No such vehicle or it has no line';
  if (pid !== undefined && !linePatterns(l).some((p) => p.id === pid)) return 'No such pattern on ' + l.name;
  v.pattern = pid;
  v.resetSpacing();
  v.fixCargo();
  g.lines.rebuild();
  v.onLineChanged();
  return null;
}

/**
 * Suggested express pattern for a line: termini, interchanges (other lines, linked stations) and the busier half
 * of the other stations stop, the smaller ones are passed. Null when there is nothing worth skipping (fewer than 4
 * stations, or every station is important).
 */
export function suggestExpress(g: Game, l: Line): ServicePattern | null {
  const r = lineRoute(l);
  if (r.stations.length < 4 && !(r.loop && r.stations.length >= 4)) return null;
  const sts = r.stations.map((id) => g.stations.get(id)).filter((s): s is Station => !!s);
  if (sts.length !== r.stations.length) return null;
  const others = (s: Station) => g.lines.linesAt(s.id).filter((x) => x.id !== l.id).length + (s.links?.length ?? 0);
  const score = (s: Station) => s.catchPop + 4 * (s.pickupLast + s.arrivedLast) + (others(s) > 0 ? 1e7 : 0);
  const keep = new Set<number>();
  if (!r.loop) { keep.add(r.stations[0]); keep.add(r.stations[r.stations.length - 1]); }
  const inner = sts.filter((s) => !keep.has(s.id));
  const ranked = [...inner].sort((a, b) => score(b) - score(a));
  const nKeep = Math.max(r.loop ? 2 : 1, Math.round(inner.length * 0.45));
  for (const s of ranked.slice(0, nKeep)) keep.add(s.id);
  for (const s of inner) if (others(s) > 0) keep.add(s.id);
  if (keep.size >= sts.length) return null;
  const flags = l.stops.map((s) => keep.has(s));
  const id = (l.patterns ?? []).reduce((m, p) => Math.max(m, p.id + 1), 1);
  const c = classifyFlags(l, flags);
  return { id, name: PATTERN_LABEL[c.kind === 'local' ? 'rapid' : c.kind], kind: c.kind === 'local' ? 'rapid' : c.kind, stops: flags, ids: [...l.stops] };
}

// ------------------------------------------------------------------------------ timetables and routing
/** Straight-line distance between two stations (units). */
function sdist(g: Game, a: number, b: number): number {
  const sa = g.stations.get(a), sb = g.stations.get(b);
  return sa && sb ? Math.hypot(sa.x - sb.x, sa.z - sb.z) : 1e6;
}

interface PatTime { pid: number; flags: boolean[]; n: number; cycle: number; freq: number; hop: number[]; route: string; timing: number[] }
export interface LineTable { ver: number; key: string; stops: number[]; nv: number; pats: PatTime[]; allowed: Set<string>; edges: { from: number; to: number; cost: number }[]; served: Set<number> }
/** Cached line tables: passengers, and mail where the line's mail fleet differs from its passenger fleet. */
const tables = new WeakMap<Game, Map<number, LineTable>>();
const mailTables = new WeakMap<Game, Map<number, LineTable>>();

/**
 * Which of a line's vehicles carry mail: 'none', 'all' (every vehicle carries passengers and mail: the mail table
 * is the passenger table) or 'some' (a mail fleet of its own: mixed and mail-only vehicles alongside passenger ones).
 */
export function mailFleet(g: Game, l: Line): 'none' | 'all' | 'some' {
  let mail = 0, both = 0, n = 0;
  for (const id of l.vehicles) {
    const v = g.vehicles.get(id);
    if (!v) continue;
    n++;
    if (v.carries('mail')) { mail++; if (v.carries('pax')) both++; }
  }
  return !mail ? 'none' : both === n ? 'all' : 'some';
}

/** Speed cap (km/h) of a hop between two stations: the faster platform track type (rail), street / road (road). */
function hopCap(g: Game, l: Line, a: number, b: number): number {
  const sa = g.stations.get(a), sb = g.stations.get(b);
  if (l.kind !== 'rail') return sa && sb && sa.townId >= 0 && sa.townId === sb.townId ? 50 : 90;
  const sp = (s: Station | undefined) => (s?.rail ? TRACK_TYPES[s.rail.trackType]?.speed ?? 160 : 160);
  return Math.max(sp(sa), sp(sb));
}

/** Models of the slowest vehicle of a list (timetable of a pattern). */
function slowest(vs: Vehicle[]): VehicleModel[] {
  let best: VehicleModel[] = [], bv = Infinity;
  for (const v of vs) {
    const a = v as unknown as { cars?: VehicleModel[]; model?: VehicleModel | null };
    const ms = a.cars ?? (a.model ? [a.model] : []);
    if (ms.length && v.maxSpeedKmh < bv) { bv = v.maxSpeedKmh; best = ms; }
  }
  // (as the train is made up, not as it happens to face: a train turned at a terminus has its cars the other way
  // round, and the timetable must not depend on which way it stands)
  const lead = best.findIndex((m) => m.power > 0);
  return lead > 0 && lead === best.length - 1 ? [...best].reverse() : best;
}

/**
 * Timetables, routing edges and boarding rules of a line for a cargo (cached per routing version): per running
 * pattern the time from each served stop to the next (running time of the hop from the physics of the vehicles that
 * carry the cargo, at most the track / road speed, plus the dwell), its cycle and frequency; per pair of stations the
 * expected journey time (half the combined headway of the services worth taking plus the ride) and the services worth
 * taking (attractive set). Mail: the passenger table itself when every vehicle carries both (mailFleet 'all').
 */
export function lineTable(g: Game, l: Line, cargo: Cargo = 'pax'): LineTable {
  if (cargo === 'mail' && mailFleet(g, l) === 'all') return lineTable(g, l);
  const cache = cargo === 'mail' ? mailTables : tables;
  let m = cache.get(g);
  if (!m) { m = new Map(); cache.set(g, m); }
  const hit = m.get(l.id);
  // between routing rebuilds (stop and vehicle edits rebuild): the same table
  if (hit && hit.ver === g.lines.version && hit.stops === l.stops && hit.nv === l.vehicles.length) return hit;
  const byPat = vehiclesByPattern(g, l, cargo);
  // cached until what the timetable depends on changes (not on every routing rebuild): the stops (where they are,
  // their track type), the vehicles of each pattern (their speed) and the patterns' stops
  let key = isLoopLine(l) ? 'loop:' : 'back:';
  // (exact positions: a station rebuilt longer moves its centre by less than a unit, and the timetable reads the
  // exact distances; the town decides a road hop's speed cap)
  for (const id of l.stops) { const s = g.stations.get(id); key += id + '@' + (s ? s.x + ',' + s.z + (s.rail ? s.rail.trackType : '') + '/' + s.townId : '') + ';'; }
  for (const [p, vs] of byPat) {
    key += '|' + p + ':';
    for (const v of vs) {
      const stock = v as unknown as { cars?: VehicleModel[]; model?: VehicleModel | null };
      // Editing a consist changes its acceleration and loaded mass without changing its top speed. Sort
      // model ids so a train reversing at a terminus still has the same timetable key.
      const models = stock.cars ?? (stock.model ? [stock.model] : []);
      key += v.id + '/' + v.maxSpeedKmh + '/' + models.map((m) => m.id).sort().join(',') + '.';
    }
  }
  for (const p of l.patterns ?? []) { key += '|' + p.id + ':'; for (const x of servedFlags(l, p)) key += x ? '1' : '0'; }
  if (hit && hit.key === key) { hit.ver = g.lines.version; hit.stops = l.stops; hit.nv = l.vehicles.length; return hit; }
  const n = l.stops.length;
  const pats: PatTime[] = [];
  const road = l.kind !== 'rail';
  for (const p of linePatterns(l)) {
    const vs = byPat.get(p.id) ?? [];
    if (!vs.length || n < 2) continue;
    const flags = servedFlags(l, l.patterns && l.patterns.length ? p : null);
    const models = slowest(vs);
    const c = models.length ? consistOf(models) : null;
    // hop[i]: time from served stop i to the next served stop (0 for indices not served, and at a short-turn)
    const hop = new Array<number>(n).fill(0);
    let cycle = 0;
    for (let i = 0; i < n; i++) {
      if (!flags[i]) continue;
      let along = 0, j = i;
      for (let k = 1; k <= n; k++) { const q = (i + k) % n; along += sdist(g, l.stops[j], l.stops[q]); j = q; if (flags[q]) break; }
      if (l.stops[j] === l.stops[i]) { hop[i] = 0; continue; }
      const d = Math.min(along, 1.3 * sdist(g, l.stops[i], l.stops[j])) * (road ? 1.3 : 1.15);
      const t = c ? hopEstimate(c, d * UNIT_M, c.seats * 0.5, hopCap(g, l, l.stops[i], l.stops[j])).t : (d * UNIT_M) / (road ? 6 : 15);
      hop[i] = t + (road ? DWELL.road : DWELL.rail);
      cycle += hop[i];
    }
    if (!(cycle > 0)) continue;
    const route = (isLoopLine(l) ? 'loop:' : 'back:') + l.stops.map((id, i) => flags[i] ? id : `(${id})`).join(',');
    const timing = isLoopLine(l) ? [flags.indexOf(true)] : patternTermini(l, p.id);
    pats.push({ pid: p.id, flags, n: vs.length, cycle, freq: vs.length / cycle, hop, route, timing });
  }
  // options per (from station, to station): (pattern, boarding index, ride time)
  const opts = new Map<string, { pid: number; a: number; ride: number; f: number }[]>();
  const served = new Set<number>();
  for (const pt of pats) {
    for (let a = 0; a < n; a++) {
      if (!pt.flags[a]) continue;
      served.add(l.stops[a]);
      let ride = 0;
      const seen = new Set<number>([l.stops[a]]);
      for (let k = 1, j = a; k < n; k++) {
        ride += pt.flags[j] ? pt.hop[j] : 0;
        j = (a + k) % n;
        if (!pt.flags[j]) continue;
        const s = l.stops[j];
        if (seen.has(s)) continue;
        seen.add(s);
        const kk = l.stops[a] + ':' + s;
        const arr = opts.get(kk) ?? [];
        // the ride ends at the stop (no dwell there)
        arr.push({ pid: pt.pid, a, ride: Math.max(1, ride - (road ? DWELL.road : DWELL.rail)), f: pt.freq });
        opts.set(kk, arr);
      }
    }
  }
  const edges: LineTable['edges'] = [];
  const allowed = new Set<string>();
  for (const [kk, arr] of opts) {
    // the attractive set: services in order of ride time while faster than the expected trip with those before
    arr.sort((x, y) => x.ride - y.ride);
    let F = 0, RF = 0, T = Infinity;
    const take: typeof arr = [];
    for (const o of arr) {
      if (o.ride >= T) break;
      F += o.f; RF += o.f * o.ride; T = (0.5 + RF) / F;
      take.push(o);
    }
    const [from, to] = kk.split(':').map(Number);
    edges.push({ from, to, cost: T });
    for (const o of take) allowed.add(o.pid + ':' + o.a + ':' + to);
  }
  const t: LineTable = { ver: g.lines.version, key, stops: l.stops, nv: l.vehicles.length, pats, allowed, edges, served };
  m.set(l.id, t);
  return t;
}

/** Routing edges of a line for a cargo (expected journey times in sim seconds) and the stations its running patterns serve. */
export function lineGraph(g: Game, l: Line, cargo: Cargo = 'pax'): { edges: { from: number; to: number; cost: number }[]; served: Set<number> } {
  const t = lineTable(g, l, cargo);
  return { edges: t.edges, served: t.served };
}

/** Headway (s) of each running pattern of a line for a cargo: cycle time / the vehicles carrying it. */
export function patternHeadways(g: Game, l: Line, cargo: Cargo = 'pax'): { pid: number; vehicles: number; cycle: number; headway: number }[] {
  return lineTable(g, l, cargo).pats.map((p) => ({ pid: p.pid, vehicles: p.n, cycle: p.cycle, headway: p.cycle / p.n }));
}

/** Scheduled headway (s) of a pattern of a line for a cargo (cycle time / its vehicles); 0 when it does not run. */
export function patternHeadway(g: Game, l: Line, pid?: number, cargo: Cargo = 'pax'): number {
  const t = lineTable(g, l, cargo);
  const p = patternOf(l, pid);
  const id = p ? p.id : 0;
  const pt = t.pats.find((q) => q.pid === id) ?? t.pats[0];
  return pt ? pt.cycle / pt.n : 0;
}

// ------------------------------------------------------------------------------ even spacing
/** Minimum departure gap and maximum additional dwell, as fractions of the pattern's scheduled headway. */
export const SPACING_GAP = 0.75;
export const SPACING_HOLD = 0.6;

/**
 * Saved clocks of the vehicle's current pattern. Route edits invalidate clocks of the old stop sequence. Vehicles are
 * spaced by role: passenger (and mixed) vehicles among themselves, mail-only ones among themselves (clock key
 * 'm' + pattern id, the pattern's cycle in the mail table over its mail-only vehicles).
 */
export function spacingSchedule(g: Game, v: Vehicle) {
  const l = v.line;
  if (!l || l.evenSpacing === false) return null;
  const p = patternOf(l, v.pattern), pid = p?.id ?? 0;
  const mailOnly = v.mailOnly;
  const pt = lineTable(g, l, mailOnly ? 'mail' : 'pax').pats.find((q) => q.pid === pid);
  if (!pt) return null;
  let n = pt.n;
  if (mailOnly) {
    n = 0;
    for (const o of vehiclesByPattern(g, l, 'mail').get(pid) ?? []) if (o.mailOnly) n++;
    if (!n) return null;
  }
  const headway = pt.cycle / n; // patternHeadway, using the same cached table / resolved pattern
  if (!(headway > 0)) return null;
  const clocks = l.spacing ??= {};
  const key = mailOnly ? 'm' + pid : pid;
  let clock = clocks[key];
  if (!clock || clock.route !== pt.route) clock = clocks[key] = { route: pt.route, departures: {} };
  return { clock, headway, vehicles: n, timing: pt.timing };
}

/** Termini of an out-and-back pattern, or its first served stop on a loop. */
export function isTimingPoint(l: Line, pid: number | undefined, index: number): boolean {
  return isLoopLine(l) ? index === patternStops(l, pid)[0] : patternTermini(l, pid).includes(index);
}

/** Same station and outgoing direction, including duplicate indices at short-turn termini. */
function departureKey(l: Line, v: Vehicle, index = v.stopIndex): string {
  return l.stops[index] + ':' + l.stops[nextStopIndex(l, v.pattern, index)];
}

/** Finished loading: wait briefly for a minimum gap, unless late or another vehicle needs this space. */
export function holdForSpacing(g: Game, v: Vehicle): boolean {
  const l = v.line;
  if (!l) return false;
  const schedule = spacingSchedule(g, v);
  if (!schedule || schedule.vehicles < 2 || !schedule.timing.includes(v.stopIndex) || g.vehicles.spacingBlocked(v)) return false;
  const now = simNow(g), prev = schedule.clock.departures[departureKey(l, v)];
  if (!prev || prev.vehicle === v.id) return false;
  // Street detours and junctions can make a road timetable optimistic. Balance a rolling cycle of road
  // departures as well as enforcing the scheduled minimum; never increase the cap. Rail paths already
  // regulate admission: stretching their cycle to include signal waits would disturb the passing-loop meets.
  const recent = prev.recent ?? [];
  const observed = l.kind !== 'rail' && recent.length > schedule.vehicles ? (prev.at - recent[recent.length - 1 - schedule.vehicles]) / schedule.vehicles : 0;
  const gap = Math.max(SPACING_GAP * schedule.headway, observed);
  if (now - prev.at >= gap) return false;
  // The first attempted hold fixes the deadline: later departures cannot restart/extend this hold.
  if (v.spacing.until < 0) v.spacing.until = now + SPACING_HOLD * schedule.headway;
  if (now >= v.spacing.until) return false;
  v.status = 'Holding for even spacing';
  return true;
}

/** Commit a timing-point departure when it starts moving; a red signal / road queue consumes no gap. */
export function noteSpacingDeparture(g: Game, v: Vehicle) {
  const l = v.line;
  const index = v.spacing.departureIndex >= 0 ? v.spacing.departureIndex : v.stopIndex;
  if (l) {
    const schedule = spacingSchedule(g, v);
    if (schedule && schedule.timing.includes(index)) {
      const key = departureKey(l, v, index), at = simNow(g);
      const recent = [...(schedule.clock.departures[key]?.recent ?? []), at].slice(-schedule.vehicles - 1);
      schedule.clock.departures[key] = { at, vehicle: v.id, recent };
    }
  }
  v.resetSpacing();
}

/**
 * Boarding rule of a vehicle of line `l` (pattern `pid`) standing at stop index `idx` of station `stationId`: may
 * passengers heading for `alight` board? Its pattern must stop there, and it must be among the services worth
 * taking from here (waiting for a faster service can be better). Built once per stop.
 */
export function boarding(g: Game, l: Line, pid: number | undefined, idx: number, stationId: number, cargo: Cargo = 'pax'): (alight: number) => boolean {
  const n = l.stops.length;
  if (!n) return () => false;
  const p = patternOf(l, pid);
  const id = p ? p.id : 0;
  const f = servedFlags(l, p);
  let a = ((idx % n) + n) % n;
  if (l.stops[a] !== stationId) a = l.stops.indexOf(stationId);
  if (a < 0) return () => false;
  // a short-turn serves its turning station once for both directions: the adjacent served index of that station
  const here = [a];
  for (const step of [1, -1]) for (let k = 1; k < n; k++) {
    const i = (((a + step * k) % n) + n) % n;
    if (!f[i]) continue;
    if (l.stops[i] === stationId) here.push(i);
    break;
  }
  const t = lineTable(g, l, cargo);
  const known = t.pats.some((q) => q.pid === id);
  const serves = new Set<number>();
  l.stops.forEach((s, i) => { if (f[i]) serves.add(s); });
  return (alight: number) => {
    if (!serves.has(alight) || alight === stationId) return false;
    // not in the tables (a vehicle bought since the last rebuild): any service of the pattern that gets there
    if (!known) return true;
    for (const i of here) if (t.allowed.has(id + ':' + i + ':' + alight)) return true;
    return false;
  };
}

/** May passengers at `stationId` heading for `alight` board this vehicle (see boarding)? */
export function boards(g: Game, l: Line, pid: number | undefined, idx: number, stationId: number, alight: number): boolean {
  return boarding(g, l, pid, idx, stationId)(alight);
}

// ------------------------------------------------------------------------------ overtaking
/** Travel direction (unit xz) of a train segment at the middle of its edge. */
function segDir(g: Game, s: TSeg): { x: number; z: number } | null {
  const e = g.world.net.edges.get(s.e);
  if (!e) return null;
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 };
  g.world.net.pointAt(e, e.len / 2, p, d);
  const l = Math.hypot(d.x, d.z) || 1;
  return { x: (d.x / l) * s.dir, z: (d.z / l) * s.dir };
}

/**
 * Overtaking: a train about to leave a station holds (at most HOLD_MAX_S) while a faster train that passes the
 * station without stopping is due within HOLD_LOOK_S on a passing track (a through track, or another platform),
 * in the direction it is leaving, so it does not run ahead of it on the next section. True while holding.
 */
export function holdForOvertake(g: Game, t: Train, dt: number): boolean {
  const st = g.stations.get(t.atStation), r = st?.rail, l = t.line;
  if (!st || !r || !l || l.kind !== 'rail' || t.holdTime >= HOLD_MAX_S || !t.segs.length) { t.holdTime = 0; return false; }
  if (r.edges.length + (r.throughEdges?.length ?? 0) < 2) { t.holdTime = 0; return false; }
  // turning here (the pattern's next stop is where it came from): it does not run ahead of anyone
  const n = l.stops.length;
  const next = l.stops[nextStopIndex(l, t.pattern, t.stopIndex)];
  let prev = -1;
  for (let k = 1; k < n; k++) { const j = (t.stopIndex - k + n * 2) % n; if (stopsAt(l, t.pattern, j) && l.stops[j] !== st.id) { prev = l.stops[j]; break; } }
  if (next === prev && n > 1) { t.holdTime = 0; return false; }
  const head = t.segs[t.headSeg];
  const my = head && head.e >= 0 ? segDir(g, head) : null;
  if (!my) { t.holdTime = 0; return false; }
  const own = new Set<number>([...r.edges, ...(r.throughEdges ?? [])]);
  const trains = g.vehicles.trains();
  // another train waits for this one (for its platform, or behind it): no holding up the line
  if (trains.some((o) => o !== t && o.blockedBy === t.id && o.state === 'waiting')) { t.holdTime = 0; return false; }
  for (const o of trains) {
    if (o === t || !o.onMap || o.state === 'loading' || o.state === 'depot' || o.routeTarget === st.id) continue;
    if (o.blockedBy === t.id) continue;
    // when it gets here: along its path at the speed limits (at least its current speed; plus speeding up)
    const vmax = Math.max(0.1, o.maxSpeed);
    const hs = o.segs[o.headSeg];
    let eta = hs ? (hs.len - o.headPos) / Math.max(0.1, Math.min(vmax, hs.limit)) : 0;
    eta += Math.max(0, Math.min(vmax, hs ? hs.limit : vmax) - o.speed) / 0.5 / 2;
    let hit: TSeg | null = null;
    const path = [...o.segs.slice(o.headSeg + 1), ...o.pending];
    for (const s of path) {
      if (s.e >= 0 && own.has(s.e)) { hit = s; break; }
      eta += s.len / Math.max(0.1, Math.min(vmax, s.limit));
      if (eta > HOLD_LOOK_S) break;
    }
    if (eta > HOLD_LOOK_S) continue;
    if (!hit || hit.e === head.e) continue;
    const od = segDir(g, hit);
    if (!od || od.x * my.x + od.z * my.z < 0.5) continue;
    const res = g.vehicles.getRes(hit.e);
    if (res && res !== o.id) continue;
    t.holdTime += dt;
    t.status = `Waiting for ${o.name} to pass`;
    return true;
  }
  t.holdTime = 0;
  return false;
}

// ------------------------------------------------------------------------------ one line, not subsets
/** Is route `b` (stations in order) a subsequence of `a`, forwards (1) or backwards (-1)? 0 if not. */
function subsequence(a: number[], b: number[], cyclic: boolean): 0 | 1 | -1 {
  if (b.length < 2 || b.length > a.length) return 0;
  const pos = new Map(a.map((s, i) => [s, i]));
  if (b.some((s) => !pos.has(s))) return 0;
  const p = b.map((s) => pos.get(s)!);
  const inc = (q: number[]) => {
    if (!cyclic) { for (let i = 1; i < q.length; i++) if (q[i] <= q[i - 1]) return false; return true; }
    // cyclic: increasing after rotating to the smallest
    let k = 0;
    for (let i = 1; i < q.length; i++) if (q[i] < q[k]) k = i;
    const r = [...q.slice(k), ...q.slice(0, k)];
    for (let i = 1; i < r.length; i++) if (r[i] <= r[i - 1]) return false;
    return true;
  };
  if (inc(p)) return 1;
  if (inc([...p].reverse())) return -1;
  return 0;
}

/** Can line `b` become a pattern of line `a`? (same mode and shape, b's route inside a's, operators allowed) */
function mergeable(g: Game, a: Line, b: Line): 0 | 1 | -1 {
  if (a === b || a.kind !== b.kind || a.stops.length < 2 || b.stops.length < 2) return 0;
  const ra = lineRoute(a), rb = lineRoute(b);
  if (ra.loop !== rb.loop) return 0;
  const dir = subsequence(ra.stations, rb.stations, ra.loop);
  if (!dir) return 0;
  if (b.owner !== a.owner) {
    // another company's line joins as a partner: AI lines only, where the lead lets it and it owns a station there
    if (!g.company(b.owner).ai || !g.canUse(b.owner, a.owner)) return 0;
    if (!g.lines.canOperate(a, b.owner) && g.lines.partnerPolicy(a) !== 'open') return 0;
    if (!ra.stations.some((s) => g.stations.get(s)?.owner === b.owner)) return 0;
  }
  return dir;
}

/** Flags on `a`'s stops for a set of `b`'s flags (b's route inside a's, `dir` 1 same way, -1 reversed). */
function mapFlags(a: Line, b: Line, bFlags: boolean[], dir: 1 | -1): boolean[] {
  const ra = lineRoute(a), rb = lineRoute(b);
  if (ra.loop) {
    const sv = new Set<number>();
    b.stops.forEach((s, i) => { if (bFlags[i]) sv.add(s); });
    return a.stops.map((s) => sv.has(s));
  }
  const na = a.stops.length, nb = b.stops.length, ka = ra.turn > 0 ? ra.turn : na - 1, kb = rb.turn > 0 ? rb.turn : nb - 1;
  const posB = new Map(rb.stations.map((s, i) => [s, i]));
  // b's stop index for a station in a direction ('out' along b's route, 'in' back)
  const bIdx = (s: number, out: boolean): number => {
    const p = posB.get(s);
    if (p === undefined) return -1;
    if (rb.turn <= 0) return b.stops.indexOf(s);
    if (p === 0 || p === kb) return p;
    return out ? p : nb - p;
  };
  return a.stops.map((s, i) => {
    const aOut = ra.turn <= 0 || i <= ka;
    const bOut = dir > 0 ? aOut : !aOut;
    const j = bIdx(s, bOut);
    return j >= 0 ? bFlags[j] !== false : false;
  });
}

export interface MergeNotice { from: number; into: number; pattern: number; text: string }

/** The preview is the route from end to end; Line.stops also includes the return calls (outAndBack). */
export type LineJoinCheck =
  | { ok: false; junction: number | null; reason: string }
  | { ok: true; junction: number; reason: null; route: number[]; into: number; from: number };
export interface JoinNotice extends MergeNotice { line: Line; junction: number }
export interface JoinOptions {
  /** Default: continue the surviving numbers when extending its end; renumber when extending its start. */
  renumber?: boolean;
  /** Post the notice to the news feed (default true). */
  notify?: boolean;
}

/** A read-only routing view of a proposed line, without changing the game's lines, ids or routing version. */
function joinPreviewGame(g: Game, l: Line): Game {
  const preview = Object.create(g) as Game;
  preview.lines = Object.create(g.lines);
  preview.lines.get = (id: number) => id === l.id ? l : g.lines.get(id);
  return preview;
}

/**
 * Follow successive calls from the platform reached by the previous hop. Testing each station pair separately
 * would incorrectly join two disconnected platform tracks carrying the same station id. Reversing at a
 * platform, including past its starter signal, is allowed just as it is in Train.planRoute.
 */
function railJoinRoute(g: Game, route: number[], owner: number, rule: TrackRule | null): string | null {
  const first = g.stations.get(route[0]), net = g.world.net;
  let at: Cont[] = [];
  for (const eid of first?.rail?.edges ?? []) {
    const edge = net.edges.get(eid);
    if (edge && g.canUse(owner, edge.owner) && ruleAllows(rule, edge)) for (const dir of [1, -1]) at.push({ edge, dir });
  }
  for (let i = 1; i < route.length; i++) {
    const arrived = new Map<string, Cont>();
    for (const c of at) {
      for (const dir of [c.dir, -c.dir]) {
        const start = railNext(g, c.edge, dir, owner, false, rule, dir !== c.dir);
        const r = findRailRoute(g, start, route[i], owner, -1, 40000, false, rule);
        const last = r?.conts[r.conts.length - 1];
        if (last) arrived.set(last.edge.id + ':' + last.dir, last);
      }
    }
    if (!arrived.size) return `${g.stations.get(route[i - 1])?.name ?? '?'} → ${g.stations.get(route[i])?.name ?? '?'}`;
    at = [...arrived.values()];
  }
  return null;
}

/**
 * Road routing allows U-turns, so reachability is an undirected walk of the usable road edges. Carry only
 * reachable stop edges across each call: disconnected stops sharing a station id cannot bridge networks.
 * Keep the vehicle class out of this module's imports (Vehicle itself imports the pattern helpers).
 */
function roadJoinRoute(g: Game, route: number[], l: Line, owner: number): string | null {
  const net = g.world.net;
  const allow = (e: NEdge) => e.kind === 'road' && (l.kind !== 'tram' || tramUsable(g, e, owner));
  const stops = (sid: number) => (g.stations.get(sid)?.stops ?? []).map((p) => net.edges.get(p.edge)).filter((e): e is NEdge => !!e && allow(e));
  let at = stops(route[0]);
  for (let i = 1; i < route.length; i++) {
    const reached = new Set(at.map((e) => e.id)), open = [...at];
    for (let k = 0; k < open.length && k < 40000; k++) {
      for (const node of [open[k].a, open[k].b]) for (const eid of net.nodes.get(node)?.edges ?? []) {
        const e = net.edges.get(eid);
        if (!e || e.depot >= 0 || reached.has(eid) || !allow(e)) continue;
        reached.add(eid); open.push(e);
      }
    }
    at = stops(route[i]).filter((e) => reached.has(e.id));
    if (!at.length) return `${g.stations.get(route[i - 1])?.name ?? '?'} → ${g.stations.get(route[i])?.name ?? '?'}`;
  }
  return null;
}

/**
 * May two end-to-end lines become one through line? Accepts line objects or ids. This is a pure preview;
 * access, track rules and continuity are checked for every operator and every distinct train consist.
 */
export function canJoinLines(g: Game, a: Line | number, b: Line | number): LineJoinCheck {
  const la = typeof a === 'number' ? g.lines.get(a) : g.lines.map.get(a.id);
  const lb = typeof b === 'number' ? g.lines.get(b) : g.lines.map.get(b.id);
  let junction: number | null = null;
  const no = (reason: string): LineJoinCheck => ({ ok: false, junction, reason });
  if (!la || !lb) return no('No such line');
  if (la === lb) return no('Choose two different lines');
  if (la.kind !== lb.kind) return no('Mode mismatch: rail, road or tram');
  const ra = lineRoute(la), rb = lineRoute(lb);
  if (la.loop === true || lb.loop === true || ra.loop || rb.loop) return no('Loop lines have no termini to join');
  if ([ra, rb].some((r) => r.stations.length < 2 || new Set(r.stations).size !== r.stations.length)) return no('Each line needs two distinct termini');
  const ends = [ra.stations[0], ra.stations[ra.stations.length - 1]];
  const shared = ends.filter((s) => s === rb.stations[0] || s === rb.stations[rb.stations.length - 1]);
  if (!shared.length) return no('No shared terminus');
  junction = shared[0];
  if (shared.length > 1) return no('Both termini shared: use service patterns');
  if (ra.stations.some((s) => s !== junction && rb.stations.includes(s))) return no('Routes overlap: join only at a terminus');
  // The longer route survives; equal lengths keep the older line. Keep its original direction too.
  const keepA = ra.stations.length > rb.stations.length || (ra.stations.length === rb.stations.length && la.id < lb.id);
  const keep = keepA ? la : lb, drop = keepA ? lb : la;
  const kr = keepA ? ra.stations : rb.stations, dr = keepA ? rb.stations : ra.stations;
  const atEnd = kr[kr.length - 1] === junction;
  const other = (atEnd ? dr[0] === junction : dr[dr.length - 1] === junction) ? [...dr] : [...dr].reverse();
  const route = atEnd ? [...kr, ...other.slice(1)] : [...other.slice(0, -1), ...kr];
  const operators = [...new Set([...g.lines.operatorsOf(keep), ...g.lines.operatorsOf(drop)])];
  const proposed: Line = { ...keep, stops: outAndBack(route), loop: false, vehicles: [...keep.vehicles, ...drop.vehicles] };
  for (const owner of operators) {
    const co = g.companies[owner];
    if (!co || co.defunct) return no('An operator no longer exists');
    if (!g.lines.ownsStationOn(proposed, owner)) return no(`${co.name} needs its own station on joined line`);
    for (const sid of route) {
      const st = g.stations.get(sid);
      if (!st) return no('Route station no longer exists');
      if (!g.canUse(owner, st.owner)) return no(`${co.name}: access to ${st.name} needed from ${g.company(st.owner).name}`);
    }
    for (const otherOwner of operators) if (!g.canUse(owner, otherOwner)) return no(`${co.name} needs track access from ${g.company(otherOwner).name}`);
  }
  const rules = new Map<string, { owner: number; rule: TrackRule | null; cars?: VehicleModel[] }>();
  for (const owner of operators) rules.set(owner + ':any', { owner, rule: null });
  for (const vid of proposed.vehicles) {
    const v = g.vehicles.get(vid);
    if (!v) continue;
    if (!operators.includes(v.owner)) return no(`${g.company(v.owner).name} does not operate either line`);
    if (v.kind !== 'train' || proposed.kind !== 'rail') continue;
    const cars = (v as Train).cars, rule = consistRule(cars);
    const key = v.owner + ':' + (rule.types === null ? '*' : [...rule.types].sort().join(',')) + ':' + rule.wire;
    rules.set(key, { owner: v.owner, rule, cars });
  }
  const jname = g.stations.get(junction)?.name ?? '?';
  for (const { owner, rule, cars } of rules.values()) {
    if (cars) {
      const why = lineCompatibility(joinPreviewGame(g, { ...proposed, owner }), proposed.id, cars);
      if (why) return no(why);
    }
    for (const stations of [route, [...route].reverse()]) {
      const gap = proposed.kind === 'rail' ? railJoinRoute(g, stations, owner, rule) : roadJoinRoute(g, stations, proposed, owner);
      if (gap) return no(`No ${proposed.kind === 'rail' ? 'track' : proposed.kind === 'tram' ? 'tram track' : 'road'} continuity through ${jname}: ${gap}${cars ? ` (${cars[0]?.name ?? 'train'} cannot run through)` : ''}`);
    }
  }
  return { ok: true, junction, reason: null, route, into: keep.id, from: drop.id };
}

/** Current/previous accounting periods are the line's history; keep both when combining services. */
function mergeLineStats(a: Line, b: Line) {
  a.passMonth += b.passMonth; a.passLast += b.passLast;
  a.incomeYear += b.incomeYear; a.incomeLast += b.incomeLast;
  a.costYear += b.costYear; a.costLast += b.costLast;
  if (b.mail) mergeLineMail(a, b);
}

/** Move waiting groups (passengers and mail) off a removed line, retaining their waiting times and transfer counts. */
function redirectWaiting(g: Game, from: number, into: number) {
  for (const st of g.stations.map.values()) {
    if (![...st.waiting.values()].some((w) => w.line === from)) continue;
    const old = [...st.waiting.values()];
    st.waiting.clear(); st.waitingTotal = 0;
    for (const w of old) g.stations.addWaiting(st, w.line === from ? into : w.line, w.alight, w.dest, w.count, 0, w.t, w.transfers ?? 0, w.rail ?? 0);
  }
  redirectMail(g, from, into);
}

/** Map a vehicle's current call, preserving the return direction at repeated interior stations. */
function joinedStopIndex(joined: Line, old: Line, idx: number, dir: 1 | -1): number {
  const r = lineRoute(joined), o = lineRoute(old);
  const i = ((idx % old.stops.length) + old.stops.length) % old.stops.length;
  const p = r.stations.indexOf(old.stops[i]);
  if (p < 0) return 0;
  const out = o.turn <= 0 || i <= o.turn;
  return r.turn > 0 && p > 0 && p < r.turn && (dir > 0 ? !out : out) ? joined.stops.length - p : p;
}

/**
 * Join at a shared terminus. Existing services become short-turn patterns, with an all-through local first
 * for new vehicles. Returns the surviving line and a notice, or an explanation without changing the game.
 */
export function joinLines(g: Game, a: Line | number, b: Line | number, opts: JoinOptions = {}): JoinNotice | string {
  const check = canJoinLines(g, a, b);
  if (!check.ok) return check.reason;
  const keep = g.lines.map.get(check.into)!, drop = g.lines.map.get(check.from)!;
  const oldKeep: Line = { ...keep, stops: [...keep.stops] };
  const sources = [oldKeep, drop];
  const oldPatterns = sources.map((l) => linePatterns(l).map((p) => ({ ...p, stops: [...servedFlags(l, l.patterns?.length ? p : null)], ids: [...l.stops] })));
  const renumber = opts.renumber ?? (lineRoute(oldKeep).stations[0] === check.junction);
  // A join keeps the visible name, even when that name used to follow the termini automatically.
  if (keep.autoName) keep.joinedName = keep.name;
  keep.stops = outAndBack(check.route);
  keep.loop = false;
  let nextId = oldPatterns[0].reduce((m, p) => Math.max(m, p.id + 1), 0);
  const through: ServicePattern = { id: nextId++, name: 'Local (through)', kind: 'local', stops: keep.stops.map(() => true), ids: [...keep.stops] };
  const list = [through], maps: Map<number, number>[] = [];
  sources.forEach((old, k) => {
    const dir = subsequence(check.route, lineRoute(old).stations, false) as 1 | -1;
    const pmap = new Map<number, number>();
    for (const p of oldPatterns[k]) {
      const flags = mapFlags(keep, old, p.stops, dir);
      const id = k === 0 ? p.id : nextId++;
      list.push({ id, name: patternName(g, keep, flags, p.kind), kind: p.kind, stops: flags, ids: [...keep.stops] });
      pmap.set(p.id, id);
    }
    maps.push(pmap);
    for (const vid of old.vehicles) {
      const v = g.vehicles.get(vid);
      if (!v) continue;
      const pid = v.pattern !== undefined && pmap.has(v.pattern) ? v.pattern : oldPatterns[k][0].id;
      v.stopIndex = joinedStopIndex(keep, old, v.stopIndex, dir);
      v.lineId = keep.id;
      v.pattern = pmap.get(pid);
      v.resetSpacing();
    }
  });
  keep.patterns = normalize(keep, list);
  keep.vehicles = [...new Set([...oldKeep.vehicles, ...drop.vehicles])];
  const operators = [...new Set([...g.lines.operatorsOf(oldKeep), ...g.lines.operatorsOf(drop)])].filter((o) => o !== keep.owner);
  if (operators.length) keep.operators = operators;
  mergeLineStats(keep, drop);
  redirectWaiting(g, drop.id, keep.id);
  const pid = maps[1].get(oldPatterns[1][0].id)!;
  g.lines.map.delete(drop.id);
  g.lines.redirectLine(drop.id, keep.id, pid, maps[1]);
  if (renumber) g.lines.renumber(keep.id);
  g.lines.rebuild();
  for (const vid of keep.vehicles) g.vehicles.get(vid)?.onLineChanged();
  const junction = g.stations.get(check.junction)!;
  const notice: JoinNotice = { from: drop.id, into: keep.id, pattern: pid, line: keep, junction: check.junction,
    text: `${drop.name} joined with ${keep.name} at ${junction.name}; existing services kept as short-turns` };
  if (opts.notify !== false) g.postNews(notice.text, 'info', junction.x, junction.z);
  return notice;
}

/** Merge line `b` into line `a` as service pattern(s) (b's route inside a's). */
function mergeLine(g: Game, a: Line, b: Line, dir: 1 | -1): MergeNotice {
  const bp = linePatterns(b);
  const aHad = !!(a.patterns && a.patterns.length);
  let list = aHad ? linePatterns(a).map((p) => ({ ...p, stops: [...p.stops], ids: p.ids ? [...p.ids] : undefined })) : linePatterns(a);
  const byFlags = (f: boolean[]) => list.find((p) => p.stops.length === f.length && p.stops.every((x, i) => x === f[i]));
  const map = new Map<number, number>();
  let nextId = list.reduce((m, p) => Math.max(m, p.id + 1), 0);
  for (const p of bp) {
    const f = mapFlags(a, b, servedFlags(b, b.patterns && b.patterns.length ? p : null), dir);
    const ex = byFlags(f);
    if (ex) { map.set(p.id, ex.id); continue; }
    const c = classifyFlags(a, f);
    const np: ServicePattern = { id: nextId++, name: patternName(g, a, f), kind: c.kind, stops: f, ids: [...a.stops] };
    list = [...list, np];
    map.set(p.id, np.id);
  }
  a.patterns = normalize(a, list);
  const firstB = bp[0].id;
  // vehicles: to line a, with their pattern, at the matching stop
  for (const vid of [...b.vehicles]) {
    const v = g.vehicles.get(vid);
    if (!v) continue;
    const target = b.stops[v.stopIndex % Math.max(1, b.stops.length)];
    v.lineId = a.id;
    v.resetSpacing();
    if (!a.vehicles.includes(v.id)) a.vehicles.push(v.id);
    v.pattern = map.get(v.pattern !== undefined && map.has(v.pattern) ? v.pattern : firstB);
    const idx = a.stops.indexOf(target);
    v.stopIndex = idx >= 0 ? idx : 0;
    if (!stopsAt(a, v.pattern, v.stopIndex)) v.stopIndex = nextStopIndex(a, v.pattern, v.stopIndex);
  }
  // partners, history, waiting passengers
  if (b.owner !== a.owner || b.operators?.length) {
    const ops = new Set([...(a.operators ?? []), ...(b.owner !== a.owner ? [b.owner] : []), ...(b.operators ?? [])]);
    ops.delete(a.owner);
    if (ops.size) a.operators = [...ops];
  }
  mergeLineStats(a, b);
  redirectWaiting(g, b.id, a.id);
  const pid = map.get(firstB) ?? 0;
  g.lines.map.delete(b.id);
  // ids of b (and of lines merged into b before) now lead to a, with the pattern b's vehicles run
  g.lines.redirectLine(b.id, a.id, pid, map);
  const pn = a.patterns.find((p) => p.id === pid)?.name ?? 'a pattern';
  return { from: b.id, into: a.id, pattern: pid, text: `${b.name} merged into ${a.name} as ${pn} service` };
}

/**
 * One line per route: a line whose stops are a subset of another line's route (in order, either way round; same
 * mode and shape) becomes a service pattern of it — short-turn or skipping stops — with its vehicles (they keep
 * their owner), its waiting passengers and its history; the surviving (longer, else older) line keeps its name,
 * colour and code. Lines that only share part of their route (X-A-B-Y and G-A-B-H) stay apart. `lineId`: only
 * merges involving that line. `sameOwnerOnly`: old-save upgrades must not silently create shared lines.
 * Returns what was merged (for news / the UI).
 */
export function canonicalizeLines(g: Game, lineId?: number, options: { sameOwnerOnly?: boolean } = {}): MergeNotice[] {
  const out: MergeNotice[] = [];
  for (let guard = 0; guard < 200; guard++) {
    let found: { a: Line; b: Line; dir: 1 | -1 } | null = null;
    const ls = [...g.lines.map.values()].sort((x, y) => x.id - y.id);
    for (const a of ls) {
      for (const b of ls) {
        if (a === b) continue;
        if (options.sameOwnerOnly && a.owner !== b.owner) continue;
        if (lineId !== undefined && a.id !== lineId && b.id !== lineId) continue;
        const d = mergeable(g, a, b);
        if (!d) continue;
        // equal routes: the older line stays
        if (lineRoute(a).stations.length === lineRoute(b).stations.length && a.id > b.id && mergeable(g, b, a)) continue;
        found = { a, b, dir: d };
        break;
      }
      if (found) break;
    }
    if (!found) break;
    const nt = mergeLine(g, found.a, found.b, found.dir);
    out.push(nt);
    if (lineId === found.b.id) lineId = found.a.id;
  }
  if (out.length) {
    g.lines.rebuild();
    for (const nt of out) { const l = g.lines.get(nt.into); if (l) for (const id of l.vehicles) g.vehicles.get(id)?.onLineChanged(); }
  }
  return out;
}

/** Would line `b`'s stops make it a subset of another line (the line it would merge into), else null. */
export function subsetOf(g: Game, b: Line): Line | null {
  for (const a of g.lines.map.values()) if (mergeable(g, a, b)) return a;
  return null;
}
