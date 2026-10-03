// Railway operating accounts and staged retrenchment. Capital never enters these accounts.
import type { AIController, LineInfo } from './ai';
import type { Line } from './lines';
import { Train } from './train';
import { routeBetween } from './ai-network';
import { linePatterns, patternOf, removePattern, setVehiclePattern, addPattern } from './patterns';
import { fmtMoney } from './economy';
import { carriesMail } from './vehicle-types';

export const RAIL_YEAR = 360;
export interface RailAccount {
  opened: number; period: number; profit: number; lastProfit: number;
  lossYears: number; lossSince: number | null; step: number; lastCut: number;
  samples: number; load: number; capacity: number; occupancy: number;
}
export interface RailEvent {
  day: number; line: number; name: string; kind: 'opened' | 'cut' | 'closed' | 'connection';
  age: number; lossYears: number; text: string;
}
export interface RailPolicyState {
  accounts: [number, RailAccount][]; events: RailEvent[]; distressSince: number | null;
}

export class RailPolicy {
  accounts = new Map<number, RailAccount>();
  events: RailEvent[] = [];
  distressSince: number | null = null;
  constructor(private ai: AIController) {}
  private get g() { return this.ai.game; }
  private get me() { return this.ai.companyId; }
  private info(l: Line): LineInfo | undefined { return this.ai.railLineInfo(l.id); }
  fleet(l: Line): Train[] {
    return l.vehicles.map((id) => this.g.vehicles.get(id)).filter((v): v is Train => v instanceof Train && v.owner === this.me);
  }
  account(l: Line): RailAccount {
    let s = this.accounts.get(l.id);
    if (!s) {
      // Old saves have no evidence of consecutive losses: observe them from now, rather than invent years.
      const opened = this.info(l)?.opened ?? this.g.day;
      s = { opened, period: this.g.day, profit: 0, lastProfit: 0, lossYears: 0, lossSince: null,
        step: 0, lastCut: -1e9, samples: 0, load: 0, capacity: 0, occupancy: 0 };
      this.accounts.set(l.id, s);
      this.event(l, 'opened', 'rail service opened');
    }
    return s;
  }
  operating(lineId: number, amount: number) {
    const l = this.g.lines.get(lineId);
    if (l?.kind === 'rail') this.account(l).profit += amount;
  }
  daily() {
    const e = this.g.company(this.me).economy;
    if (e.money < 0 && e.loan + e.loanStep > e.maxLoan) this.distressSince ??= this.g.day;
    else this.distressSince = null;
    for (const l of this.g.lines.map.values()) if (l.kind === 'rail' && (l.owner === this.me && this.info(l) || this.fleet(l).length)) {
      const s = this.account(l);
      for (const t of this.fleet(l)) if (t.onMap) { s.samples++; s.load += t.load; s.capacity += t.capacity; }
    }
  }
  get deepTrouble(): boolean { return this.distressSince !== null && this.g.day - this.distressSince >= 180; }

  /** Oldest sustained losses first, then the worst operating result (also used for shared services). */
  lossOrder(a: number, b: number): number {
    const A = this.accounts.get(a), B = this.accounts.get(b);
    return (A?.lossSince ?? Infinity) - (B?.lossSince ?? Infinity)
      || (B?.lossYears ?? 0) - (A?.lossYears ?? 0) || (A?.lastProfit ?? 0) - (B?.lastProfit ?? 0) || a - b;
  }

  /** Infrastructure apportioned by routes, including both directions and platform edges. */
  monthEnd(wear: ReadonlyMap<number, number>) {
    const g = this.g, net = g.world.net;
    const rail = g.lines.all().filter((l) => l.kind === 'rail' && new Set(l.stops).size >= 2);
    const routes = new Map<number, Set<number>>(), uses = new Map<number, number>(), stationUses = new Map<number, number>();
    for (const l of rail) {
      const edges = new Set<number>();
      for (const sid of new Set(l.stops)) {
        stationUses.set(sid, (stationUses.get(sid) ?? 0) + 1);
        for (const id of g.stations.get(sid)?.rail?.edges ?? []) edges.add(id);
        for (const id of g.stations.get(sid)?.rail?.throughEdges ?? []) edges.add(id);
      }
      for (let i = 0; i < l.stops.length; i++) {
        const a = l.stops[i], b = l.stops[(i + 1) % l.stops.length];
        if (a !== b) for (const id of routeBetween(g, a, b, l.owner) ?? []) edges.add(id);
      }
      routes.set(l.id, edges);
      for (const id of edges) uses.set(id, (uses.get(id) ?? 0) + 1);
    }
    const costs: { l: Line; own: number; foreign: number }[] = [];
    for (const l of rail) {
      if (!this.info(l) && !this.fleet(l).length && (l.owner !== this.me || !this.accounts.has(l.id))) continue;
      const s = this.account(l);
      let own = 0, foreign = 0;
      for (const id of routes.get(l.id)!) {
        const e = net.edges.get(id);
        if (!e) continue;
        const cost = g.edgeMaintenance(e) / 12 + (wear.get(id) ?? 0);
        if (e.owner === this.me) own += cost / uses.get(id)!;
        else if (e.owner >= 0) foreign += cost;
      }
      for (const sid of new Set(l.stops)) {
        const st = g.stations.get(sid);
        if (!st) continue;
        const cost = g.stationMaintenance(st) / 12;
        if (st.owner === this.me) own += cost / stationUses.get(sid)!;
        else if (st.owner >= 0) foreign += cost;
      }
      const depot = this.info(l)?.depot ?? this.fleet(l)[0]?.depotId;
      if (depot !== undefined && g.depots.get(depot)?.owner === this.me) {
        const n = rail.filter((o) => this.info(o)?.depot === depot || this.fleet(o).some((t) => t.depotId === depot)).length;
        own += 1000 / Math.max(1, n);
      }
      s.profit -= own;
      costs.push({ l, own, foreign });
    }
    // Access accounts are billed by company usage. Allocate only the rail share, so a shared line's vehicle
    // earnings remain the operator's own, and fees are not counted twice as foreign infrastructure upkeep.
    const e = g.company(this.me).economy, ownTotal = costs.reduce((a, c) => a + c.own, 0), foreignTotal = costs.reduce((a, c) => a + c.foreign, 0);
    for (const c of costs) {
      const s = this.account(c.l);
      if (ownTotal > 0) s.profit += e.current.trackIncome * c.own / Math.max(ownTotal, -e.current.maintenance - e.current.trackWear);
      if (foreignTotal > 0) s.profit += e.current.trackFees * c.foreign / foreignTotal;
      if (g.day - s.period < RAIL_YEAR) continue;
      s.lastProfit = s.profit * RAIL_YEAR / (g.day - s.period);
      s.lossYears = s.profit < 0 ? s.lossYears + 1 : 0;
      if (s.profit < 0) s.lossSince ??= s.period;
      else { s.lossSince = null; s.step = 0; }
      s.occupancy = s.capacity ? s.load / s.capacity : 0;
      s.period = g.day; s.profit = 0; s.samples = 0; s.load = 0; s.capacity = 0;
    }
    for (const id of this.accounts.keys()) {
      const l = g.lines.map.get(id);
      if (!l || l.owner !== this.me && !this.info(l) && !this.fleet(l).length) this.accounts.delete(id);
    }
  }

  /** Always preserve one train per active pattern, including on a partner's line. */
  surplus(l: Line): Train[] {
    const keep = new Set<number>(), extra: Train[] = [];
    for (const t of this.fleet(l).sort((a, b) => a.id - b.id)) {
      const p = patternOf(l, t.pattern)?.id ?? 0;
      if (keep.has(p)) extra.push(t); else keep.add(p);
    }
    return extra.sort((a, b) => a.profitLast - b.profitLast || b.id - a.id);
  }
  private tell(l: Line, text: string) {
    const s = this.account(l), result = s.lastProfit < 0 ? `losing ${fmtMoney(-s.lastProfit)} a year` : `operating result ${fmtMoney(s.lastProfit)} a year`;
    const message = `${l.name}: ${text}, ${result}`;
    this.ai.railNote(message);
    const st = this.g.stations.get(l.stops[0]);
    this.g.postNews(`${this.g.company(this.me).name} ${message}.`, 'ai', st?.x, st?.z);
    this.event(l, 'cut', text);
  }
  fewer(l: Line, count = 1, why = 'fewer trains'): boolean {
    const extra = this.surplus(l).slice(0, count), before = this.fleet(l).length;
    if (!extra.length) return false;
    for (const t of extra) { this.g.vehicles.sell(t.id); this.ai.stats.sold++; }
    const info = this.info(l);
    if (info) info.lastSold = this.g.day;
    this.tell(l, `${why} (${before} → ${before - extra.length})`);
    return true;
  }
  review(l: Line): boolean {
    const s = this.account(l), g = this.g;
    if (!s.lossYears || s.lastProfit >= 0 || s.profit > 0 || g.day - s.lastCut < RAIL_YEAR) return false;
    if (s.step < 4) {
      const trains = this.fleet(l);
      if (s.step === 0) {
        let removed = 0;
        if (s.occupancy < 0.3) for (const t of trains) {
          if (t.state !== 'loading' && t.state !== 'depot') continue;
          const wagons = t.cars.filter((c) => c.kind === 'wagon' && !carriesMail(c)), emus = t.cars.filter((c) => c.kind === 'emu' && !carriesMail(c));
          const car = wagons.length > 1 ? wagons[wagons.length - 1] : emus.length > 1 ? emus[emus.length - 1] : null;
          if (!car || t.load > t.capacity - car.capacity) continue;
          const refund = g.vehicles.resaleValue(t) * car.cost / t.value;
          const cars = [...t.cars]; cars.splice(cars.lastIndexOf(car), 1);
          t.cars = cars; t.value -= car.cost;
          g.company(this.me).economy.earn(refund, 'vehicles');
          removed++;
        }
        if (!removed && s.occupancy < 0.3 && trains.some((t) => t.cars.filter((c) => (c.kind === 'wagon' || c.kind === 'emu') && !carriesMail(c)).length > 1)) return false;
        if (removed) {
          // Seats and mass affect the timetable even when the locomotive's top speed is unchanged.
          g.lines.rebuild();
          this.tell(l, `shorter trains (${removed} cars removed)`);
        }
      } else if (s.step === 1) {
        this.fewer(l, Math.max(1, Math.ceil(trains.length / 3)));
      } else if (s.step === 2) {
        // A partner keeps its patterns; only our trains move to the all-stops service there.
        let local = linePatterns(l).find((p) => p.stops.every(Boolean));
        if (!local && l.owner === this.me) local = addPattern(g, l.id, 'local') ?? undefined;
        if (local) {
          const dropped = linePatterns(l).filter((p) => p.id !== local!.id);
          for (const t of trains) setVehiclePattern(g, t.id, local.id);
          if (l.owner === this.me && !l.vehicles.some((id) => g.vehicles.get(id)?.owner !== this.me))
            for (const p of dropped) removePattern(g, l.id, p.id);
          if (dropped.length) this.tell(l, 'dropped express / short-turn patterns');
          const info = this.info(l); if (info) info.express = undefined;
        }
      } else {
        const local = linePatterns(l).find((p) => p.stops.every(Boolean));
        if (local) for (const t of trains) setVehiclePattern(g, t.id, local.id);
        this.fewer(l, Math.max(0, trains.length - 1), 'single-train shuttle');
      }
      s.step++; s.lastCut = g.day;
      return false;
    }
    return this.canClose(l);
  }
  canClose(l: Line): boolean {
    const s = this.account(l);
    return s.lossYears >= 5 && this.g.day - s.opened >= 5 * RAIL_YEAR && s.step >= 4
      && this.g.day - s.lastCut >= RAIL_YEAR && s.lastProfit < 0 && s.profit <= 0;
  }
  event(l: Line, kind: RailEvent['kind'], text: string) {
    const s = this.accounts.get(l.id);
    this.events.push({ day: this.g.day, line: l.id, name: l.name, kind, age: this.g.day - (s?.opened ?? this.g.day), lossYears: s?.lossYears ?? 0, text });
  }
  save(): RailPolicyState {
    return { accounts: [...this.accounts].map(([id, s]) => [id, { ...s }]), events: this.events.map((e) => ({ ...e })), distressSince: this.distressSince };
  }
  load(s?: RailPolicyState) {
    if (!s) return;
    this.accounts = new Map(s.accounts.map(([id, a]) => [id, { ...a }]));
    this.events = s.events.map((e) => ({ ...e })); this.distressSince = s.distressSince;
  }
}
