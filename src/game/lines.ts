// Lines (ordered stop lists), their automatic names and colours, and passenger routing across the line network.
import type { Game } from './game';
import type { LineKind as Transport } from './constants';
import type { Station } from './stations';
import { WALK_LINE } from './stations';
import type { Town } from './towns';

export interface Line {
  id: number;
  owner: number;
  name: string;
  color: string;
  kind: Transport;
  stops: number[];
  vehicles: number[];
  passMonth: number; passLast: number;
  incomeYear: number; incomeLast: number;
  costYear: number; costLast: number;
  /** number in the automatic name ("R2 …", "Bus 3 …"), per company and kind */
  num: number;
  /** the name follows the stops until the line is renamed (Lines.rename) */
  autoName: boolean;
  /** the colour was picked automatically (until Lines.setColor) */
  autoColor: boolean;
  /**
   * a loop line: vehicles circulate one way round the stops (no turning back at a stop while the way ahead
   * leads on). Unset: a loop when the stops are 3+ different stations (see Lines.isLoop).
   */
  loop?: boolean;
}

/**
 * First leg of a passenger's journey: board `line`, alight at `alight`. When several lines (e.g. of different
 * companies sharing stations under track access) serve that leg about equally well, `lines` lists them all
 * (`line` first) and passengers are spread over them by frequency (see Lines.distribute).
 */
export interface Hop { line: number; alight: number; cost: number; lines?: number[] }

/** Automatic line colours per transport mode: strong colours for rail, lighter ones for buses, vivid ones for trams. */
export const LINE_PALETTES: Record<Transport, string[]> = {
  rail: ['#d7263d', '#1b6ec2', '#2a9d4b', '#7b2cbf', '#f08c00', '#00897b', '#c2185b', '#3949ab', '#8d6e00', '#5d4037', '#0097a7', '#6a1b9a'],
  road: ['#ff6f61', '#42a5f5', '#8bc34a', '#ffb300', '#ab47bc', '#26a69a', '#ff8a65', '#78909c', '#ec407a', '#9ccc65', '#5c6bc0', '#ffd54f'],
  tram: ['#e53935', '#00acc1', '#fb8c00', '#5e35b1', '#43a047', '#d81b60', '#1e88e5', '#795548', '#c0ca33', '#00897b'],
};
/** All automatic colours (for cycling through them in the UI). */
export const LINE_COLORS = [...new Set([...LINE_PALETTES.rail, ...LINE_PALETTES.road, ...LINE_PALETTES.tram])];

// ---------------------------------------------------------------- colour distance (CIE Lab, delta E 76)
const labCache = new Map<string, [number, number, number]>();
function lab(hex: string): [number, number, number] {
  let c = labCache.get(hex);
  if (c) return c;
  const n = parseInt(hex.replace('#', '').padEnd(6, '0').slice(0, 6), 16) || 0;
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; });
  const X = (lin[0] * 0.4124 + lin[1] * 0.3576 + lin[2] * 0.1805) / 0.95047;
  const Y = lin[0] * 0.2126 + lin[1] * 0.7152 + lin[2] * 0.0722;
  const Z = (lin[0] * 0.0193 + lin[1] * 0.1192 + lin[2] * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  c = [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
  labCache.set(hex, c);
  return c;
}
/**
 * The stations of a line that runs out and back (stops A, B or A, B, C, B or A, B, C, D, C, B …), in order from
 * one end to the other; null for other stop lists (rings, repeats).
 */
export function linearStops(stops: number[]): number[] | null {
  const n = stops.length;
  if (n < 2) return null;
  if (n === 2) return stops[0] !== stops[1] ? [...stops] : null;
  if (n % 2 !== 0) return null;
  const k = n / 2;
  for (let i = 1; i < k; i++) if (stops[k + i] !== stops[k - i]) return null;
  const path = stops.slice(0, k + 1);
  return new Set(path).size === path.length ? path : null;
}

/** The stops of a line running out and back along `path` (A, B, C -> A, B, C, B). */
export function outAndBack(path: number[]): number[] { return path.length < 3 ? [...path] : [...path, ...path.slice(1, -1).reverse()]; }

/** Perceptual distance between two colours (delta E; ~2.3 = just noticeable, > 25 clearly different). */
export function colorDistance(a: string, b: string): number {
  const p = lab(a.toLowerCase()), q = lab(b.toLowerCase());
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** Line name prefix per mode. */
const PREFIX: Record<Transport, string> = { rail: 'R', road: 'Bus ', tram: 'Tram ' };

export class Lines {
  map = new Map<number, Line>();
  nextId = 1;
  /** routing[s] = Map(dest -> first hop) */
  routing = new Map<number, Map<number, Hop>>();
  servedStations = new Set<number>();
  /** bumped by every rebuild (routing tables changed) */
  version = 0;
  /** station catchments need a recompute (done once per tick, see flushCatchment) */
  catchmentDirty = false;
  /** the automatic name last given to each line (a name changed by direct assignment is kept as the player's) */
  private autoText = new Map<number, string>();
  constructor(private game: Game) {}

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  create(kind: Transport, owner = 0): Line {
    const id = this.nextId++;
    const line: Line = {
      id, owner, name: '', color: this.pickColor(kind, owner), kind, num: this.freeNumber(kind, owner),
      stops: [], vehicles: [], passMonth: 0, passLast: 0, incomeYear: 0, incomeLast: 0, costYear: 0, costLast: 0,
      autoName: true, autoColor: true,
    };
    line.name = this.autoNameOf(line);
    this.autoText.set(id, line.name);
    this.map.set(id, line);
    return line;
  }

  delete(id: number) {
    const l = this.map.get(id);
    if (!l) return;
    for (const vid of [...l.vehicles]) this.game.vehicles.get(vid)?.setLine(null);
    this.map.delete(id);
    this.rebuild();
  }

  /** Rename a line; an empty name returns to the automatic name. */
  rename(id: number, name: string) {
    const l = this.map.get(id);
    if (!l) return;
    const n = name.trim().slice(0, 48);
    if (!n) { l.autoName = true; l.name = this.autoNameOf(l); this.autoText.set(id, l.name); return; }
    l.name = n;
    l.autoName = false;
  }

  /** Set a line's colour (#rrggbb); it then stays fixed. Null returns to an automatic colour. */
  setColor(id: number, color: string | null) {
    const l = this.map.get(id);
    if (!l) return;
    if (color === null) { l.autoColor = true; l.color = this.pickColor(l.kind, l.owner, l.id); return; }
    l.color = color;
    l.autoColor = false;
  }

  // ---------------------------------------------------------------- automatic names and colours
  /** Smallest line number not used by the owner's lines of this mode. */
  private freeNumber(kind: Transport, owner: number, except = -1): number {
    const used = new Set<number>();
    for (const l of this.map.values()) if (l.owner === owner && l.kind === kind && l.id !== except) used.add(l.num);
    let n = 1;
    while (used.has(n)) n++;
    return n;
  }

  /** The palette colour of this mode farthest from the colours of the owner's other lines. */
  pickColor(kind: Transport, owner: number, except = -1): string {
    const used: string[] = [];
    for (const l of this.map.values()) if (l.owner === owner && l.id !== except) used.push(l.color);
    const pal = LINE_PALETTES[kind] ?? LINE_PALETTES.rail;
    let best = pal[0], bs = -Infinity;
    for (const c of pal) {
      let d = Infinity, uses = 0;
      for (const u of used) { const x = colorDistance(c, u); if (x < d) d = x; if (x < 1) uses++; }
      // unused colours by distance to the used ones; once all are taken, the least used one
      const score = uses ? -uses : d;
      if (score > bs + 1e-9) { bs = score; best = c; }
    }
    return best;
  }

  /** Express rail line: long (> 2 km between the ends) or run with fast trains. */
  private express(l: Line, span: number): boolean {
    if (l.kind !== 'rail') return false;
    if (span >= 200) return true;
    let n = 0, v = 0;
    for (const id of l.vehicles) { const veh = this.game.vehicles.get(id); if (veh) { n++; v += veh.maxSpeedKmh; } }
    return n > 0 && v / n >= 180;
  }

  /** Automatic name from the mode and the stops, e.g. "R1 Chalthorpe – Whitewell", "Bus 3 Chalthorpe: Central – North". */
  autoNameOf(l: Line): string {
    const g = this.game;
    const sts: Station[] = [];
    for (const id of l.stops) { const s = g.stations.get(id); if (s && !sts.includes(s)) sts.push(s); }
    const prefix = (k: string) => (l.kind === 'rail' ? k + l.num : PREFIX[l.kind] + l.num);
    if (!sts.length) return prefix(l.kind === 'rail' ? 'R' : '');
    // the ends: the first stop and the stop farthest from it
    const a = sts[0];
    let b = a, span = 0;
    for (const s of sts) { const d = Math.hypot(s.x - a.x, s.z - a.z); if (d > span) { span = d; b = s; } }
    const p = prefix(this.express(l, span) ? 'RE' : 'R');
    if (b === a) return `${p} ${a.name}`;
    const town = (s: Station): Town | undefined => (s.townId >= 0 ? g.towns.list[s.townId] : undefined);
    const ta = town(a), tb = town(b);
    if (l.kind !== 'rail' && ta && sts.every((s) => s.townId === ta.id)) {
      const part = (s: Station) => {
        if (s.name.startsWith(ta.name + ' ')) return s.name.slice(ta.name.length + 1);
        return s.name === ta.name && Math.hypot(s.x - ta.x, s.z - ta.z) < 12 ? 'Central' : s.name;
      };
      const pa = part(a), pb = part(b);
      return pa === pb ? `${p} ${ta.name}: ${a.name} – ${b.name}` : `${p} ${ta.name}: ${pa} – ${pb}`;
    }
    if (ta && tb && ta !== tb) return `${p} ${ta.name} – ${tb.name}`;
    return `${p} ${a.name} – ${b.name}`;
  }

  /** Refresh automatic names (after stops or vehicles changed). */
  refreshNames() {
    for (const l of this.map.values()) {
      if (!l.autoName) continue;
      const last = this.autoText.get(l.id);
      if (last !== undefined && l.name !== last) { l.autoName = false; continue; }
      l.name = this.autoNameOf(l);
      this.autoText.set(l.id, l.name);
    }
  }

  /** A line changes hands (company buyout): new number for the buyer, colour kept unless it clashes. */
  transfer(l: Line, owner: number) {
    if (l.owner === owner) return;
    l.owner = owner;
    l.num = this.freeNumber(l.kind, owner, l.id);
    if (l.autoColor) {
      let clash = false;
      for (const o of this.map.values()) if (o !== l && o.owner === owner && colorDistance(o.color, l.color) < 12) { clash = true; break; }
      if (clash) l.color = this.pickColor(l.kind, owner, l.id);
    }
    if (l.autoName) { l.name = this.autoNameOf(l); this.autoText.set(l.id, l.name); }
  }

  // ---------------------------------------------------------------- stops
  /** Can this station be added as a stop of the line? Null if yes, else the reason. */
  canAddStop(lineId: number, stationId: number): string | null {
    const g = this.game;
    const l = this.map.get(lineId), st = g.stations.get(stationId);
    if (!l || !st) return 'No such line or station';
    if (!g.canUse(l.owner, st.owner)) return `${st.name} belongs to ${g.company(st.owner).name} (no track access agreement)`;
    if (l.kind === 'rail' && !st.rail) return 'This station has no train platforms';
    if (l.kind === 'road' && !st.stops.length) return 'This station has no bus stop';
    if (l.kind === 'tram' && !g.stations.tramStops(st, l.owner).length) return 'This station has no tram stop (on tram tracks you may use)';
    return null;
  }

  onStationRemoved(stationId: number) {
    for (const l of this.map.values()) {
      if (l.stops.includes(stationId)) {
        l.stops = l.stops.filter((s) => s !== stationId);
        for (let i = l.stops.length - 1; i > 0; i--) if (l.stops[i] === l.stops[i - 1]) l.stops.splice(i, 1);
        for (const vid of l.vehicles) this.game.vehicles.get(vid)?.onLineChanged();
      }
    }
    this.rebuild();
  }

  /** Remove the stops at `owner`'s stations from `user`'s lines (an access agreement ended). Returns the number removed. */
  dropForeignStops(user: number, owner: number): number {
    const g = this.game;
    let n = 0;
    for (const l of this.map.values()) {
      if (l.owner !== user) continue;
      const keep = l.stops.filter((s) => g.stations.get(s)?.owner !== owner);
      if (keep.length === l.stops.length) continue;
      n += l.stops.length - keep.length;
      l.stops = keep;
      for (let i = l.stops.length - 1; i > 0; i--) if (l.stops[i] === l.stops[i - 1]) l.stops.splice(i, 1);
      if (l.stops.length > 1 && l.stops[0] === l.stops[l.stops.length - 1]) l.stops.pop();
      for (const vid of l.vehicles) g.vehicles.get(vid)?.onLineChanged();
    }
    if (n) this.rebuild();
    return n;
  }

  stationServed(id: number) { return this.servedStations.has(id); }

  linesAt(stationId: number): Line[] {
    return [...this.map.values()].filter((l) => l.stops.includes(stationId));
  }

  /** Does the line run as a loop (explicit `loop`, else 3+ stops, each station once: not out and back)? */
  isLoop(l: Line): boolean { return l.loop ?? (l.stops.length >= 3 && new Set(l.stops).size === l.stops.length); }

  /** Make a line a loop (true), out and back (false), or decide by its stops (undefined). */
  setLoop(id: number, loop: boolean | undefined) {
    const l = this.map.get(id);
    if (!l) return;
    if (loop === undefined) delete l.loop; else l.loop = loop;
    for (const vid of l.vehicles) this.game.vehicles.get(vid)?.onLineChanged();
  }

  nextHop(from: number, dest: number): Hop | undefined {
    return this.routing.get(from)?.get(dest);
  }

  /** Recompute routing tables (Dijkstra over the line graph) and the automatic names. */
  rebuild() {
    const stations = this.game.stations;
    this.routing.clear();
    this.servedStations.clear();
    this.version++;
    this.refreshNames();
    // edges: from -> [{to, line, cost}]
    const edges = new Map<number, { to: number; line: number; cost: number }[]>();
    const dist = (a: number, b: number) => {
      const sa = stations.get(a), sb = stations.get(b);
      if (!sa || !sb) return 1e9;
      return Math.hypot(sa.x - sb.x, sa.z - sb.z);
    };
    for (const l of this.map.values()) {
      const n = l.stops.length;
      if (n < 2 || l.vehicles.length === 0) continue;
      for (const s of l.stops) this.servedStations.add(s);
      for (let i = 0; i < n; i++) {
        let acc = 0;
        for (let k = 1; k < n; k++) {
          const j = (i + k) % n;
          const prev = (i + k - 1) % n;
          acc += dist(l.stops[prev], l.stops[j]);
          if (l.stops[j] === l.stops[i]) continue;
          let arr = edges.get(l.stops[i]);
          if (!arr) { arr = []; edges.set(l.stops[i], arr); }
          arr.push({ to: l.stops[j], line: l.id, cost: acc + 6 });
        }
      }
    }
    // walking transfers between linked stations of a transfer complex (Stations.walkLinks)
    for (const wl of stations.walkLinks()) {
      let arr = edges.get(wl.from);
      if (!arr) { arr = []; edges.set(wl.from, arr); }
      arr.push({ to: wl.to, line: WALK_LINE, cost: wl.cost });
    }
    for (const src of edges.keys()) {
      const table = new Map<number, Hop>();
      const best = new Map<number, number>([[src, 0]]);
      const first = new Map<number, { line: number; alight: number }>();
      // did the best path ride a line? (stations reached on foot only are no destinations)
      const rode = new Map<number, boolean>([[src, false]]);
      const open: [number, number][] = [[0, src]];
      while (open.length) {
        open.sort((a, b) => a[0] - b[0]);
        const [c, u] = open.shift()!;
        if (c > (best.get(u) ?? Infinity)) continue;
        for (const e of edges.get(u) ?? []) {
          const nc = c + e.cost + (u === src ? 0 : 10);
          if (nc < (best.get(e.to) ?? Infinity)) {
            best.set(e.to, nc);
            first.set(e.to, u === src ? { line: e.line, alight: e.to } : first.get(u)!);
            rode.set(e.to, !!rode.get(u) || e.line !== WALK_LINE);
            open.push([nc, e.to]);
          }
        }
      }
      // lines serving the same first leg about as well as the best one (parallel lines share the passengers)
      const legs = new Map<number, { line: number; cost: number }[]>();
      for (const e of edges.get(src) ?? []) {
        let a = legs.get(e.to);
        if (!a) { a = []; legs.set(e.to, a); }
        const o = a.find((x) => x.line === e.line);
        if (o) o.cost = Math.min(o.cost, e.cost); else a.push({ line: e.line, cost: e.cost });
      }
      for (const [d, f] of first) {
        if (d === src || !rode.get(d)) continue;
        const hop: Hop = { line: f.line, alight: f.alight, cost: best.get(d)! };
        const leg = legs.get(f.alight);
        if (leg && leg.length > 1) {
          const own = leg.find((x) => x.line === f.line);
          const lim = (own ? own.cost : Math.min(...leg.map((x) => x.cost))) * 1.15 + 5;
          const alt = leg.filter((x) => x.line !== f.line && x.cost <= lim).map((x) => x.line);
          if (alt.length) hop.lines = [f.line, ...alt];
        }
        table.set(d, hop);
      }
      this.routing.set(src, table);
    }
    for (const st of stations.all()) this.rerouteWaiting(st);
    // served stations changed: catchments are shared out again, once for several rebuilds in a row
    this.catchmentDirty = true;
  }

  /** Recompute the station catchments if routing changed since (called by the game every tick). */
  flushCatchment() {
    if (!this.catchmentDirty) return;
    this.catchmentDirty = false;
    this.game.stations.recomputeCatchment();
    this.game.demand.recomputeShares();
  }

  /**
   * Hand `count` passengers taking `hop` to its line(s): parallel lines get shares by their number of
   * vehicles (frequency), rounded at random.
   */
  distribute(hop: Hop, count: number, add: (line: number, n: number) => void) {
    if (count <= 0) return;
    const ls = hop.lines;
    if (!ls || ls.length < 2) { add(hop.line, count); return; }
    const w = ls.map((id) => Math.max(1, this.map.get(id)?.vehicles.length ?? 0));
    const W = w.reduce((a, b) => a + b, 0);
    let left = count;
    for (let i = 0; i < ls.length && left > 0; i++) {
      let k = left;
      if (i < ls.length - 1) {
        const share = (count * w[i]) / W;
        k = Math.floor(share);
        if (this.game.rng.next() < share - k) k++;
        k = Math.min(k, left);
      }
      if (k > 0) { add(ls[i], k); left -= k; }
    }
  }

  /** After a rebuild: waiting passengers keep their line where it is still a good first leg, the others are re-routed. */
  private rerouteWaiting(st: Station) {
    if (!st.waiting.size) return;
    const stations = this.game.stations;
    const old = [...st.waiting.values()];
    st.waiting.clear();
    st.waitingTotal = 0;
    for (const w of old) {
      const hop = this.nextHop(st.id, w.dest);
      if (!hop) continue;
      if (hop.alight === w.alight && (hop.line === w.line || hop.lines?.includes(w.line))) stations.addWaiting(st, w.line, w.alight, w.dest, w.count);
      else this.distribute(hop, w.count, (line, n) => stations.addWaiting(st, line, hop.alight, w.dest, n));
    }
  }

  /** Normalise a line restored from a save (older saves lack the naming state). */
  static restore(d: any): Line {
    const l: Line = { ...d, stops: [...(d.stops ?? [])], vehicles: [...(d.vehicles ?? [])] };
    if (typeof l.num !== 'number') {
      const m = /(\d+)\s*$/.exec(String(l.name ?? ''));
      l.num = m ? Number(m[1]) : l.id;
    }
    if (typeof l.autoName !== 'boolean') l.autoName = false;
    if (typeof l.autoColor !== 'boolean') l.autoColor = false;
    return l;
  }
}
