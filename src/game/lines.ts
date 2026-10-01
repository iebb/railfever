// Lines (ordered stop lists) and passenger routing across the line network.
import type { Game } from './game';
import type { NetKind as Transport } from './constants';

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
}

export interface Hop { line: number; alight: number; cost: number }

export const LINE_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6', '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#800000', '#aaffc3', '#808000', '#000075'];

export class Lines {
  map = new Map<number, Line>();
  nextId = 1;
  /** routing[s] = Map(dest -> first hop) */
  routing = new Map<number, Map<number, Hop>>();
  servedStations = new Set<number>();
  constructor(private game: Game) {}

  get(id: number) { return this.map.get(id); }
  all() { return [...this.map.values()]; }

  create(kind: Transport, owner = 0): Line {
    const id = this.nextId++;
    const n = [...this.map.values()].filter((l) => l.kind === kind && l.owner === owner).length + 1;
    const line: Line = {
      id, owner, name: (kind === 'rail' ? 'Rail line ' : 'Bus line ') + n, color: LINE_COLORS[(id - 1) % LINE_COLORS.length], kind,
      stops: [], vehicles: [], passMonth: 0, passLast: 0, incomeYear: 0, incomeLast: 0, costYear: 0, costLast: 0,
    };
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

  stationServed(id: number) { return this.servedStations.has(id); }

  linesAt(stationId: number): Line[] {
    return [...this.map.values()].filter((l) => l.stops.includes(stationId));
  }

  nextHop(from: number, dest: number): Hop | undefined {
    return this.routing.get(from)?.get(dest);
  }

  /** Recompute routing tables (Dijkstra over the line graph). */
  rebuild() {
    const stations = this.game.stations;
    this.routing.clear();
    this.servedStations.clear();
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
    for (const src of edges.keys()) {
      const table = new Map<number, Hop>();
      const best = new Map<number, number>([[src, 0]]);
      const first = new Map<number, { line: number; alight: number }>();
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
            open.push([nc, e.to]);
          }
        }
      }
      for (const [d, f] of first) if (d !== src) table.set(d, { line: f.line, alight: f.alight, cost: best.get(d)! });
      this.routing.set(src, table);
    }
    for (const st of stations.all()) stations.rerouteWaiting(st);
    stations.recomputeCatchment();
  }
}
