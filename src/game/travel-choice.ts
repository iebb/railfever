// Minimum expected transit time on physical parts. Stage 2 queries are read-only and shadow-only.
import type { Hop } from './lines';
import { WALK_LINE } from './stations';
import { PLATFORM_CHANGE_S } from './patterns';
import { PHYSICAL_POLICY, timeMs } from './travel-policy';
import type { PartId, RideOption, Passage, PhysicalServices } from './travel-times';

export type ArrivalState = 'start' | 'rideArrival' | 'walkArrival';
export interface TieContext { tripId: number | string; originBuildingId: number; destinationBuildingId: number }
export interface PartAccess { part: PartId; timeMs: number }
export interface TimeComponents { accessMs: number; waitMs: number; rideMs: number; dwellMs: number; changeMs: number; walkMs: number; egressMs: number }
export interface RideStrategy {
  key: string; fromPart: PartId; toPart: PartId; options: readonly RideOption[];
  frequency: number; waitMs: number; rideMs: number; dwellMs: number; costMs: number;
}
export interface BoardingEvent {
  part: PartId; lineId: number; patternId: number; occurrence: number; direction: number; vehicleId: number;
}
export type TransitStep = { kind: 'ride'; strategy: RideStrategy; changeMs: number }
  | { kind: 'walk'; passage: Passage };
export interface TransitJourney {
  policy: typeof PHYSICAL_POLICY; key: string; costMs: number; components: TimeComponents;
  fromPart: PartId; toPart: PartId; steps: readonly TransitStep[];
}
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export const optionKey = (o: RideOption) => JSON.stringify([o.lineId, o.patternId, o.serviceKey, o.boardOccurrence, o.alightOccurrence, o.fromPart, o.toPart, o.boardDirection, o.alightDirection]);
const departureKey = (o: RideOption) => JSON.stringify([o.lineId, o.patternId, o.serviceKey, o.boardOccurrence, o.fromPart, o.boardDirection]);

/** Same physical boarding/alighting part only. A duplicate departure cannot halve its own headway. */
export function compileStrategies(options: readonly RideOption[]): RideStrategy[] {
  const pairs = new Map<string, Map<string, RideOption>>();
  for (const o of options) {
    if (!(o.frequency > 0) || !Number.isFinite(o.frequency)) continue;
    if (!Number.isSafeInteger(o.rideMs) || o.rideMs < 0 || !Number.isSafeInteger(o.intermediateDwellMs) || o.intermediateDwellMs < 0 || o.intermediateDwellMs > o.rideMs) throw new Error('Invalid ride option');
    const pair = JSON.stringify([o.fromPart, o.toPart]);
    let departures = pairs.get(pair);
    if (!departures) { departures = new Map(); pairs.set(pair, departures); }
    const key = departureKey(o), prev = departures.get(key);
    if (!prev || o.rideMs < prev.rideMs || (o.rideMs === prev.rideMs && compare(optionKey(o), optionKey(prev)) < 0)) departures.set(key, o);
  }
  const out: RideStrategy[] = [];
  for (const departures of pairs.values()) {
    const sorted = [...departures.values()].sort((a, b) => a.rideMs - b.rideMs || compare(optionKey(a), optionKey(b)));
    const take: RideOption[] = [];
    let frequency = 0, weightedRide = 0, weightedDwell = 0, expected = Infinity;
    for (const o of sorted) {
      if (o.rideMs >= expected) break;
      frequency += o.frequency; weightedRide += o.frequency * o.rideMs; weightedDwell += o.frequency * o.intermediateDwellMs;
      expected = (500 + weightedRide) / frequency;
      take.push(o);
    }
    if (!take.length) continue;
    const waitMs = timeMs(.5 / frequency);
    const costMs = timeMs(expected / 1000), dwellMs = Math.min(costMs, timeMs(weightedDwell / frequency / 1000));
    // Quantize the strategy edge once. Assign the sub-ms component residual to motion for an exact sum.
    const wait = Math.min(costMs - dwellMs, waitMs), rideMs = costMs - wait - dwellMs;
    const key = JSON.stringify([take[0].fromPart, take[0].toPart, take.map(optionKey).sort(compare)]);
    out.push(Object.freeze({ key, fromPart: take[0].fromPart, toPart: take[0].toPart, options: Object.freeze(take), frequency, waitMs: wait, rideMs, dwellMs, costMs }));
    if (out.at(-1)!.costMs <= 0) throw new Error('A ride must take physical time');
  }
  return out.sort((a, b) => compare(a.key, b.key));
}

/** Shared queue eligibility; stages 4/5 must use this same set for boarding and expected flow allocation. */
export function strategyAllows(strategy: RideStrategy, event: BoardingEvent): boolean {
  return boardingOption(strategy, event) !== undefined;
}
export function boardingOption(strategy: RideStrategy, event: BoardingEvent): RideOption | undefined {
  if (event.part !== strategy.fromPart) return;
  return strategy.options.find((o) =>
    o.lineId === event.lineId && o.patternId === event.patternId && o.boardDirection === event.direction &&
    o.boardOccurrences.includes(event.occurrence) && o.vehicleIds.includes(event.vehicleId));
}
export function optionAlights(option: RideOption, event: BoardingEvent): boolean {
  return event.part === option.toPart && event.lineId === option.lineId && event.patternId === option.patternId &&
    event.direction === option.alightDirection && option.alightOccurrences.includes(event.occurrence) && option.vehicleIds.includes(event.vehicleId);
}
export function strategyFlows(strategy: RideStrategy): { option: RideOption; share: number }[] {
  return strategy.options.map((option) => ({ option, share: option.frequency / strategy.frequency }));
}

/** Stable tie identity independent of insertion order, company order, cache warmth and Game.rng. */
export function tieRank(context: TieContext, key: string): number {
  const text = JSON.stringify([context.tripId, context.originBuildingId, context.destinationBuildingId, key]);
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
export function preferTie(context: TieContext, key: string, previous: string): boolean {
  const a = tieRank(context, key), b = tieRank(context, previous);
  return a < b || (a === b && key < previous);
}

class Heap {
  private entries: { cost: number; node: number }[] = [];
  get size() { return this.entries.length; }
  push(node: number, cost: number) {
    const e = { node, cost }, a = this.entries;
    let i = a.length; a.push(e);
    while (i) { const p = (i - 1) >> 1; if (a[p].cost <= cost) break; a[i] = a[p]; i = p; }
    a[i] = e;
  }
  pop() {
    const a = this.entries, first = a[0], last = a.pop()!;
    if (a.length) {
      let i = 0;
      for (;;) { let c = i * 2 + 1; if (c >= a.length) break; if (c + 1 < a.length && a[c + 1].cost < a[c].cost) c++; if (a[c].cost >= last.cost) break; a[i] = a[c]; i = c; }
      a[i] = last;
    }
    return first;
  }
}
interface Predecessor { node: number; step: TransitStep }
interface Row { costs: Float64Array; predecessors: (Predecessor[] | undefined)[]; bytes: number }
const emptyComponents = (): TimeComponents => ({ accessMs: 0, waitMs: 0, rideMs: 0, dwellMs: 0, changeMs: 0, walkMs: 0, egressMs: 0 });
export const componentSum = (c: TimeComponents) => c.accessMs + c.waitMs + c.rideMs + c.dwellMs + c.changeMs + c.walkMs + c.egressMs;
function validTime(ms: number) { if (!Number.isSafeInteger(ms) || ms < 0) throw new Error('Invalid travel time'); }
export function journeyKey(fromPart: PartId, toPart: PartId, steps: readonly TransitStep[]): string {
  return JSON.stringify([fromPart, toPart, steps.map((s) => s.kind === 'ride' ? ['r', s.strategy.key, s.changeMs] : ['w', s.passage.fromPart, s.passage.toPart, s.passage.walkMs])]);
}

/** Lazy source rows. Equal-cost predecessor DAGs retain exact trip-specific ties, including continuations. */
export class TravelRouter {
  readonly policy = PHYSICAL_POLICY;
  readonly strategies: readonly RideStrategy[];
  private parts: PartId[];
  private index: Map<PartId, number>;
  private rides = new Map<PartId, RideStrategy[]>();
  private walks = new Map<PartId, Passage[]>();
  private rows = new Map<string, Row>();
  private rowBytes = 0;
  /** Byte-bounded LRU; eviction never removes eligible sources or destinations. */
  constructor(readonly services: PhysicalServices, readonly rowBudgetBytes = 8 * 1024 * 1024, readonly maxRows = 64) {
    this.strategies = Object.freeze(compileStrategies(services.options));
    this.parts = [...services.parts.keys()].sort(compare);
    this.index = new Map(this.parts.map((p, i) => [p, i]));
    for (const s of this.strategies) { const arr = this.rides.get(s.fromPart) ?? []; arr.push(s); this.rides.set(s.fromPart, arr); }
    for (const p of services.passages) {
      validTime(p.walkMs);
      if (!p.walkMs) throw new Error('A passage must take physical time');
      const arr = this.walks.get(p.fromPart) ?? []; arr.push(p); this.walks.set(p.fromPart, arr);
    }
    for (const arr of this.walks.values()) arr.sort((a, b) => compare(a.toPart, b.toPart) || a.walkMs - b.walkMs);
  }
  get cachedRows() { return this.rows.size; }
  get cachedBytes() { return this.rowBytes; }
  clearRows() { this.rows.clear(); this.rowBytes = 0; }
  private row(part: PartId, arrival: ArrivalState): Row | undefined {
    const root = this.index.get(part);
    if (root === undefined) return;
    const mode = arrival === 'start' ? 0 : arrival === 'rideArrival' ? 1 : 2;
    const key = `${part}/${mode}`, hit = this.rows.get(key);
    if (hit) { this.rows.delete(key); this.rows.set(key, hit); return hit; }
    const costs = new Float64Array(this.parts.length * 3).fill(Infinity), predecessors: Row['predecessors'] = new Array(costs.length);
    const open = new Heap(), source = root * 3 + mode;
    let count = 0;
    costs[source] = 0; open.push(source, 0);
    const relax = (node: number, cost: number, prev: number, step: TransitStep) => {
      validTime(cost);
      if (cost < costs[node]) { costs[node] = cost; count -= predecessors[node]?.length ?? 0; predecessors[node] = [{ node: prev, step }]; count++; open.push(node, cost); }
      else if (cost === costs[node]) {
        const ps = predecessors[node] ??= [];
        const stepKey = step.kind === 'ride' ? step.strategy.key : `${step.passage.toPart}/${step.passage.walkMs}`;
        if (!ps.some((p) => p.node === prev && (p.step.kind === 'ride' ? p.step.strategy.key : `${p.step.passage.toPart}/${p.step.passage.walkMs}`) === stepKey)) { ps.push({ node: prev, step }); count++; }
      }
    };
    while (open.size) {
      const { node, cost } = open.pop();
      if (cost !== costs[node]) continue;
      const p = this.parts[Math.floor(node / 3)], state = node % 3;
      for (const strategy of this.rides.get(p) ?? []) {
        const target = this.index.get(strategy.toPart);
        if (target === undefined) continue;
        const changeMs = state === 1 ? timeMs(PLATFORM_CHANGE_S) : 0;
        relax(target * 3 + 1, cost + strategy.costMs + changeMs, node, { kind: 'ride', strategy, changeMs });
      }
      // Initial/final transfer-only walks cannot expand station access/egress limits.
      if (state !== 0) for (const passage of this.walks.get(p) ?? []) {
        const target = this.index.get(passage.toPart);
        if (target !== undefined) relax(target * 3 + 2, cost + passage.walkMs, node, { kind: 'walk', passage });
      }
    }
    const row = { costs, predecessors, bytes: costs.byteLength + predecessors.length * 8 + count * 80 };
    if (row.bytes <= this.rowBudgetBytes && this.maxRows > 0) {
      while (this.rows.size && (this.rows.size >= this.maxRows || this.rowBytes + row.bytes > this.rowBudgetBytes)) {
        const k = this.rows.keys().next().value!; this.rowBytes -= this.rows.get(k)!.bytes; this.rows.delete(k);
      }
      this.rows.set(key, row); this.rowBytes += row.bytes;
    }
    return row;
  }
  private *paths(row: Row, target: number, source: number): Generator<TransitStep[]> {
    // Strictly positive edges make the equal-cost predecessor graph acyclic.
    const stack: { node: number; steps: TransitStep[] }[] = [{ node: target, steps: [] }];
    while (stack.length) {
      const { node, steps } = stack.pop()!;
      if (node === source) { yield steps.reverse(); continue; }
      for (const p of row.predecessors[node] ?? []) stack.push({ node: p.node, steps: [...steps, p.step] });
    }
  }
  /** Each access record is the actual eligible first board; finish only at a ride arrival with valid egress. */
  queryTransit(access: readonly PartAccess[], egress: readonly PartAccess[], tie: TieContext, arrival: ArrivalState = 'start'): TransitJourney | undefined {
    let best = Infinity;
    const candidates: { a: PartAccess; b: PartAccess; row: Row; source: number; target: number }[] = [];
    const mode = arrival === 'start' ? 0 : arrival === 'rideArrival' ? 1 : 2;
    for (const a of access) {
      validTime(a.timeMs);
      const row = this.row(a.part, arrival);
      if (!row) continue;
      for (const b of egress) {
        validTime(b.timeMs);
        const dest = this.index.get(b.part);
        if (dest === undefined) continue;
        const target = dest * 3 + 1, cost = a.timeMs + row.costs[target] + b.timeMs;
        if (cost > best || !Number.isFinite(cost)) continue;
        if (cost < best) { best = cost; candidates.length = 0; }
        candidates.push({ a, b, row, source: this.index.get(a.part)! * 3 + mode, target });
      }
    }
    let result: TransitJourney | undefined;
    for (const c of candidates) for (const steps of this.paths(c.row, c.target, c.source)) {
      if (arrival === 'start' && !steps.some((s) => s.kind === 'ride')) continue;
      const key = journeyKey(c.a.part, c.b.part, steps);
      if (result && !preferTie(tie, key, result.key)) continue;
      const components = emptyComponents(); components.accessMs = c.a.timeMs; components.egressMs = c.b.timeMs;
      for (const s of steps) {
        if (s.kind === 'walk') components.walkMs += s.passage.walkMs;
        else { components.waitMs += s.strategy.waitMs; components.rideMs += s.strategy.rideMs; components.dwellMs += s.strategy.dwellMs; components.changeMs += s.changeMs; }
      }
      result = { policy: this.policy, key, costMs: componentSum(components), components, fromPart: c.a.part, toPart: c.b.part, steps };
    }
    return result;
  }
  /** Lossy first-Hop adapter only; new callers retain the journey's states, strategies and components. */
  projectHop(journey: TransitJourney): Hop | undefined {
    const first = journey.steps[0];
    if (!first) return;
    if (first.kind === 'walk') return { line: WALK_LINE, alight: this.services.parts.get(first.passage.toPart)!.stationId, cost: journey.costMs / 1000 };
    const lines = [...new Set(first.strategy.options.map((o) => o.lineId))].sort((a, b) => a - b);
    return { line: lines[0], alight: this.services.parts.get(first.strategy.toPart)!.stationId, cost: journey.costMs / 1000, ...(lines.length > 1 ? { lines } : {}) };
  }
}
