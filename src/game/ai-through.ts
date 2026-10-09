// Saved, bounded reviews of licensed urban pairs and own / foreign / own rail services.
import type { Game } from './game';
import type { AIController } from './ai';
import type { Line } from './lines';
import { linearStops, outAndBack } from './lines';
import type { VehicleModel } from './vehicle-types';
import { MODEL_BY_ID } from './vehicle-types';
import { Train, consistRule, findRailRoute, platformDepartureFrontiers, depotServes, trackAllows, makeSeg } from './train';
import { openingRailCall } from './ai';
import type { NEdge } from './network';
import type { ConnectionPlan } from './trackops';
import { commitConnection, planConnection } from './trackops';
import { priceSharedProject, sharedTrainAllowed } from './ai-capacity';
import { estimateVehicleYear, YEAR_S } from './opcosts';
import { forecastSeatFactor } from './ai-grow';
import { recomputeLocks, EARTHWORKS } from './terraform';
import { KMH_TO_UPS, UNIT_M } from './constants';
import { curveSpeed } from './construction';
import { patternStops } from './patterns';
import { bezFromTangents, bezDeriv, tAtS } from './geom';
import { SAVE_TREES, type Tree } from './world';
import { railPartMode } from './stations';
import { platformChoices } from './rail-platforms';

/** Local native turnout survey supplied by the existing two-network planner. */
export interface ThroughLink {
  ax: number; az: number; atx: number; atz: number; bx: number; bz: number; btx: number; btz: number;
  d: number; left: number[]; right: number[]; value: number; la: boolean; lb: boolean;
}
interface Choice { path: number[]; links: ThroughLink[]; score: number; cars: string[]; reuse?: number }
export interface ThroughCursor { at: number; signature: string; best?: Choice; trials?: number[][][] }
export interface ThroughItem { ids: number[]; through?: ThroughCursor }
export const copyThroughCursor = (c: ThroughCursor): ThroughCursor => ({ ...c, ...(c.best ? { best: {
  ...c.best, path: [...c.best.path], cars: [...c.best.cars], links: c.best.links.map(copyLink),
} } : {}), ...(c.trials ? { trials: c.trials.map(t => t.map(p => [...p])) } : {}) });
const copyLink = (s: ThroughLink): ThroughLink => ({ ...s, left: [...s.left], right: [...s.right] });
interface Managed { kind: string; towns: number[]; depot: number; maxVehicles: number; opened: number; across?: boolean }
export interface ThroughHost {
  g: Game; me: number; ai: AIController;
  cared(key: string): boolean; careFor(key: string, days: number): void;
  selectSides(middle: number, ids: number[]): number[];
  considered(key: string): void; note(text: string): void; news(text: string, x: number, z: number): void;
  canSpend(cost: number, share: number): boolean; affordable(cost: number, share: number): boolean;
  survey(a: Line, b: Line): ThroughLink[]; plan(s: ThroughLink): ConnectionPlan | null;
  room(l: Line): number; mayAlter(ids: number[]): boolean;
  canon(id: number): void; managed(): Map<number, Managed> | undefined;
  succeed(): void; stat(key: 'netThrough' | 'netXServices' | 'connections', n?: number): void;
}
const pathOf = (l: Line): number[] | null => l.kind === 'rail' && !l.loop ? linearStops(l.stops) : null;
const modelKey = (cars: VehicleModel[]) => cars.map(m => m.id).sort().join(',');
const signature = (g: Game, ls: Line[], owner: number) => JSON.stringify(ls.map(l => [l.id, l.owner, l.stops, l.patterns,
  g.canUse(owner, l.owner), l.vehicles.map(id => { const t = g.vehicles.get(id); return t instanceof Train ? [id, t.owner, t.pattern, modelKey(t.cars), t.depotId] : [id]; })]));
const keyOf = (ids: number[]) => 'through' + ids.join(':');
const orient = (p: number[], reverse: boolean) => reverse ? [...p].reverse() : [...p];
const concat = (...ps: number[][]) => ps.flatMap((p, i) => i && ps[i - 1].at(-1) === p[0] ? p.slice(1) : p);
const urban = (g: Game, l: Line) => l.stops.some(id => { const r = g.stations.get(id)?.rail; return r && railPartMode(r) !== 'mainline'; });
/** This atomic lane cannot leave a supported original road/rail behind with its construction refunded. */
function reversible(p: ConnectionPlan): boolean {
  const prop = p.proposal;
  return p.ok && (!prop || !prop.demolish.length && !prop.roadBridges?.length && !prop.crossings.some(c => c.mode === 'under'
    && !prop.tracks[c.track].sections.some(s => s.type === 'tunnel' && c.sNew >= s.s0 - .5 && c.sNew <= s.s1 + .5)));
}

/** Foreign infrastructure need not already have a fleet, and player-owned open track can carry a service. */
export function throughMiddleLines(h: ThroughHost): number[] {
  return h.g.lines.all().filter(l => l.owner !== h.me && h.g.canUse(h.me, l.owner) && (pathOf(l)?.length ?? 0) >= 2).map(l => l.id);
}
export function throughCandidates(h: ThroughHost, middleIds: number[]): number[][] {
  const ls = h.g.lines.all().filter(l => !!pathOf(l) && (pathOf(l)?.length ?? 0) >= 2);
  const own = ls.filter(l => l.owner === h.me && l.vehicles.some(id => h.g.vehicles.get(id)?.owner === h.me));
  const near = (a: Line, b: Line) => {
    const pa = pathOf(a)!, pb = pathOf(b)!;
    const city = urban(h.g, a) || urban(h.g, b);
    return [pa[0], pa.at(-1)!].some(x => {
      const X = h.g.stations.get(x);
      if (!X) return false;
      if ((city ? pb : [pb[0], pb.at(-1)!]).some(y => {
        const Y = h.g.stations.get(y);
        return !!Y && (x === y || Math.hypot(X.x - Y.x, X.z - Y.z) <= 100);
      })) return true;
      // A joined city branch can meet a long foreign leg between its distant calls.
      return city && pb.slice(1).some((id, i) => {
        const A = h.g.stations.get(pb[i])!, B = h.g.stations.get(id)!, dx = B.x - A.x, dz = B.z - A.z;
        const t = Math.max(0, Math.min(1, ((X.x - A.x) * dx + (X.z - A.z) * dz) / Math.max(1e-9, dx * dx + dz * dz)));
        return Math.hypot(X.x - A.x - dx * t, X.z - A.z - dz * t) <= 100;
      });
    });
  };
  const out: number[][] = [];
  for (const id of middleIds) {
    const b = ls.find(l => l.id === id);
    if (!b || b.owner === h.me || !h.g.canUse(h.me, b.owner)) continue;
    const nearby = own.filter(a => near(a, b)), selected = new Set(h.selectSides(b.id, nearby.map(l => l.id)));
    const sides = nearby.filter(l => selected.has(l.id));
    // A city railway can continue over one open foreign route without owning another
    // outer trunk first. Its local fleet and the foreign timetable remain separate.
    for (const a of sides) if (urban(h.g, a) || urban(h.g, b)) {
      const ids = [a.id, b.id]; if (!h.cared(keyOf(ids))) out.push(ids);
    }
    for (let i = 0; i < sides.length; i++) for (let j = i + 1; j < sides.length; j++) {
      const ids = [sides[i].id, b.id, sides[j].id];
      if (!h.cared(keyOf(ids))) out.push(ids);
    }
  }
  return out;
}

/** Saved geometry shortlist only. The closest two foreign entry stops per direction
 * include shared intermediate hubs; every retained trial still needs native rail proof. */
function throughTrials(g: Game, lines: Line[]): number[][][] {
  if (lines.length === 3) return Array.from({ length: 8 }, (_, n) => lines.map((l, i) => orient(pathOf(l)!, !!(n & 1 << i))));
  const out: number[][][] = [], seen = new Set<string>();
  for (const reverseA of [false, true]) for (const reverseB of [false, true]) {
    const a = orient(pathOf(lines[0])!, reverseA), b = orient(pathOf(lines[1])!, reverseB), X = g.stations.get(a.at(-1)!)!;
    const entries = b.slice(0, -1).map((id, i) => { const s = g.stations.get(id)!;
      return { i, id, distance: Math.hypot(s.x - X.x, s.z - X.z) }; })
      .sort((p, q) => p.distance - q.distance || p.id - q.id).slice(0, 2);
    for (const entry of entries) {
      const right = b.slice(entry.i), key = a.join(',') + '|' + right.join(',');
      if (!seen.has(key)) { seen.add(key); out.push([a, right]); }
    }
  }
  return out;
}

type ThroughProof = ReturnType<typeof routeEdges>;
/** A quote-local cache never crosses a work unit, construction or a saved boundary. */
export interface ThroughQuoteContext { routes: Map<string, ThroughProof>; platforms: Map<string, boolean>; lookups: number; hits: number;
  world?: Game['world']; epoch?: string; broad?: boolean }
export const throughQuoteContext = (): ThroughQuoteContext => ({ routes: new Map(), platforms: new Map(), lookups: 0, hits: 0 });
function proof(g: Game, path: number[], owner: number, cars: VehicleModel[], strict: boolean, context?: ThroughQuoteContext): ThroughProof {
  if (!context) return routeEdges(g, path, owner, cars, strict);
  const epoch = [g.tick, g.networkVersion, g.world.net.version, g.lines.version, g.stations.walkVersion,
    g.companies.map(c => Number(g.canUse(owner, c.id))).join('')].join(':');
  if (context.world !== g.world || context.epoch !== epoch) {
    context.routes.clear(); context.platforms.clear(); context.world = g.world; context.epoch = epoch;
  }
  const key = JSON.stringify([path, owner, modelKey(cars), strict]); context.lookups++;
  if (context.routes.has(key)) { context.hits++; return context.routes.get(key)!; }
  const value = routeEdges(g, path, owner, cars, strict); context.routes.set(key, value); return value;
}

/** Native rail only, with actual stock, platform length and lawful onward departure. No walking edges. */
function route(g: Game, a: number, b: number, onward: number, owner: number, cars: VehicleModel[]): number[] | null {
  const A = g.stations.get(a), B = g.stations.get(b);
  if (!A?.rail || !B?.rail || !g.canUse(owner, A.owner) || !g.canUse(owner, B.owner)) return null;
  const length = cars.reduce((n, m) => n + m.length + 0.1, 0), rule = consistRule(cars);
  let best: { ids: number[]; cost: number } | null = null;
  for (const group of g.stations.railTrackGroups(A)) {
    if (group.length < length + .05 || group.steps.some(s => { const e = g.world.net.edges.get(s.edge); return !e || !g.canUse(owner, e.owner) || !trackAllows(cars, e); })) continue;
    for (const ordered of [group.steps, [...group.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }))]) {
      const frontier = platformDepartureFrontiers(g, ordered, owner, rule, length);
      const r = findRailRoute(g, [...frontier.forward, ...frontier.reverse], b, owner, -1, 15000, false, rule, false,
        { length, onward });
      if (r && (!best || r.cost < best.cost)) best = { ids: r.conts.map(c => c.edge.id), cost: r.cost };
    }
  }
  return best?.ids ?? null;
}
function routeEdges(g: Game, path: number[], owner: number, cars: VehicleModel[], strict = true): { ids: number[]; length: number; legs: { length: number; cap: number }[] } | null {
  const stops = outAndBack(path), ids: number[] = [], legs: { length: number; cap: number }[] = []; let length = 0;
  for (let i = 0; i < stops.length; i++) {
    const a = stops[i], b = stops[(i + 1) % stops.length], next = stops[(i + 2) % stops.length];
    const r = route(g, a, b, next, owner, cars) ?? (!strict ? route(g, a, b, a, owner, cars) : null);
    let len: number, cap = Math.min(...cars.map(m => m.speed));
    if (!r) { if (strict) return null; const A = g.stations.get(a)!, B = g.stations.get(b)!; len = Math.hypot(A.x - B.x, A.z - B.z) * 1.25; }
    else { ids.push(...r); len = r.reduce((n, id) => n + (g.world.net.edges.get(id)?.len ?? 0), 0);
      for (const id of r) { const e = g.world.net.edges.get(id)!; cap = Math.min(cap, makeSeg(g, e, 1).limit / KMH_TO_UPS); } }
    length += len; legs.push({ length: len, cap });
  }
  return { ids: [...new Set(ids)], length: length / 2, legs };
}
/** Pure native feasibility inventory, also used by focused platform/permission controls. */
export const throughRouteProof = (g: Game, path: number[], owner: number, cars: VehicleModel[]) => routeEdges(g, path, owner, cars);
/** The same full-body depot entry as openingRailCall, before allocating a new timetable. */
export function throughOpeningCall(g: Game, path: number[], owner: number, cars: VehicleModel[], depotId: number): number {
  const depot = g.depots.get(depotId), stub = depot && g.world.net.edges.get(depot.edge);
  if (!depot || depot.owner !== owner || depot.kind !== 'rail' || !stub || stub.kind !== 'rail') return -1;
  const stops = outAndBack(path), length = cars.reduce((n, m) => n + m.length + .1, 0), rule = consistRule(cars);
  for (let i = 0; i < stops.length; i++) if (findRailRoute(g, [{ edge: stub, dir: 1 }], stops[i], owner, -1, 60000, false, rule, false,
    { length, onward: stops[(i + 1) % stops.length] })) return i;
  return -1;
}
/** A through call continues forward on one incoming/outgoing physical platform.
 * Reversing at an intermediate stop is not a substitute for a connected timetable. */
function throughPlatforms(g: Game, path: number[], owner: number, cars: VehicleModel[], context?: ThroughQuoteContext): boolean {
  const key = JSON.stringify([path, owner, modelKey(cars)]);
  if (context?.platforms.has(key)) return context.platforms.get(key)!;
  const stock = g.vehicles.trains().find(t => t.owner === owner && modelKey(t.cars) === modelKey(cars));
  const line = { id: -1, owner, kind: 'rail', stops: outAndBack(path), vehicles: stock ? [stock.id] : [] } as unknown as Line;
  const fits = line.stops.every((_, i) => platformChoices(g, line, 0, i).length > 0);
  context?.platforms.set(key, fits); return fits;
}
function cycle(g: Game, cars: VehicleModel[], legs: { length: number; cap: number }[], extraCap = Infinity) {
  const estimates = legs.map(l => { const year = estimateVehicleYear(cars, l.length / 1.15, g.year, .4, Math.min(l.cap, extraCap));
    return { year, seconds: YEAR_S / Math.max(1e-9, year.trips) }; });
  const seconds = estimates.reduce((n, e) => n + e.seconds, 0);
  return { seconds, kmh: legs.reduce((n, l) => n + l.length, 0) * UNIT_M / 1000 / (seconds / 3600),
    running: estimates.reduce((n, e) => n + e.year.total * e.seconds / seconds, 0),
    wear: Math.max(...estimates.map(e => e.year.trackWearPerUnit)) };
}
function stocks(h: ThroughHost, ls: Line[], path: number[]): VehicleModel[][] {
  const out = new Map<string, VehicleModel[]>(), min = Math.min(...path.map(id => h.g.stations.get(id)?.rail?.length ?? 0));
  for (const l of ls.filter(l => l.owner === h.me)) for (const id of l.vehicles) {
    const t = h.g.vehicles.get(id); if (!(t instanceof Train) || t.owner !== h.me || !t.capacity || t.mailCapacity) continue;
    if (t.length <= min - 0.4) out.set(modelKey(t.cars), [...t.cars].sort((a, b) => Number(b.kind === 'loco') - Number(a.kind === 'loco')));
  }
  return [...out.values()].sort((a, b) => a.reduce((n, m) => n + m.cost, 0) - b.reduce((n, m) => n + m.cost, 0));
}
/** One through train. Full existing own receipts are deducted, so retained local income never finances it twice. */
export function quoteThrough(h: ThroughHost, ls: Line[], path: number[], cars: VehicleModel[], works: number, links: ThroughLink[], reuse?: Train,
  built?: readonly number[], prepared?: ConnectionPlan[], context?: ThroughQuoteContext) {
  const g = h.g, edges = proof(g, path, h.me, cars, !links.length, context); if (!edges) return null;
  if (!links.length && !context?.broad && !throughPlatforms(g, path, h.me, cars, context)) return null;
  const plans = prepared ?? links.map(s => h.plan(s)); if (plans.some(p => !p || !reversible(p))) return null;
  const speedCap = Math.min(Infinity, ...plans.map(p => curveSpeed(p!.minRadius, 'standard')));
  const service = cycle(g, cars, edges.legs, speedCap), kmh = service.kmh;
  const forecast = g.demand.forecastLine(path.map(id => g.stations.get(id)!), 'mainline', kmh, service.seconds, h.me);
  const factor = forecastSeatFactor(forecast.legLoads, service.seconds, 1, cars.reduce((n, m) => n + m.capacity, 0));
  let oldReceipts = 0, lostLocal = 0, releasedRunning = 0;
  for (const l of ls.filter(l => l.owner === h.me)) {
    const p = pathOf(l)!, fleet = l.vehicles.map(id => g.vehicles.get(id)).filter((t): t is Train => t instanceof Train && t.owner === h.me);
    if (!fleet.length) return null;
    const services = fleet.map(t => { const local = proof(g, p, h.me, t.cars, true, context); return local ? { t, local, cost: cycle(g, t.cars, local.legs) } : null; });
    if (services.some(s => !s)) return null;
    const estimate = (without?: number) => {
      const kept = services.filter(s => s && s.t.id !== without).map(s => s!), frequency = kept.reduce((n, s) => n + 1 / s.cost.seconds, 0);
      if (!frequency) return 0;
      const kmh = kept.reduce((n, s) => n + s.cost.kmh, 0) / kept.length;
      const f = g.demand.forecastLine(p.map(id => g.stations.get(id)!), 'mainline', kmh, 1 / frequency, h.me, l.id);
      const seats = kept.reduce((n, s) => n + s.t.capacity * YEAR_S / s.cost.seconds * .7, 0);
      return f.revenue * Math.min(1, seats / Math.max(1, ...f.legLoads));
    };
    const receipts = Math.max(l.incomeLast, l.incomeYear, estimate());
    oldReceipts += receipts;
    if (reuse && reuse.lineId === l.id) {
      const first = l.patterns?.[0]?.id ?? 0, pattern = reuse.pattern ?? first;
      if (fleet.length < 2 || reuse.state !== 'depot' || reuse.mailCapacity || patternStops(l, reuse.pattern).length !== l.stops.length
        || fleet.some(t => (t.pattern ?? first) !== pattern || modelKey(t.cars) !== modelKey(reuse.cars))) return null;
      lostLocal += Math.max(0, receipts - estimate(reuse.id));
      releasedRunning += services.find(s => s?.t.id === reuse.id)!.cost.running;
    }
  }
  // Conservative sole-user charge, with the same ceiling and full own-passage wear as billing.
  let fees = 0;
  const feeEdges = edges.ids.map(id => g.world.net.edges.get(id)!);
  const feeItems = [...feeEdges, ...path.map(id => g.stations.get(id)!)];
  for (const owner of new Set(feeItems.map(item => item.owner))) fees += g.accessChargeEstimate(h.me, owner, feeItems, 1,
    feeEdges.filter(e => e.owner === owner).reduce((n, e) => n + e.len * service.wear, 0));
  const trainCost = reuse ? 0 : cars.reduce((n, m) => n + m.cost, 0);
  const upkeep = built ? built.reduce((n, id) => { const e = g.world.net.edges.get(id); return n + (e?.owner === h.me ? g.edgeMaintenance(e) : 0); }, 0)
    : links.reduce((n, l) => n + l.d * 1.25 * 300, 0);
  const ownWear = edges.ids.reduce((n, id) => { const e = g.world.net.edges.get(id)!; return n + (e.owner === h.me ? e.len * service.wear : 0); }, 0);
  const need = works * (0.045 - 0.03 * h.ai.config.risk) + (works + trainCost) * Math.max(.03, g.company(h.me).economy.interestRate);
  const revenue = forecast.revenue * factor;
  return { score: revenue - oldReceipts - lostLocal - service.running + releasedRunning - fees - upkeep - ownWear - need,
    revenue, boardings: forecast.boardings * factor, kmh, headway: service.seconds, capital: works + trainCost, fees, lostLocal };
}

function boundary(h: ThroughHost, a: Line, b: Line, pa: number[], pb: number[], cars: VehicleModel[]): ThroughLink | null | false {
  const x = pa.at(-1)!, y = pb[0];
  if (x === y || route(h.g, x, y, pb[1], h.me, cars) && route(h.g, y, x, pa.at(-2)!, h.me, cars)) return null;
  // Existing native xlink surveys preserve direction, local passing stops and ownership consent.
  const sites = h.survey(a, b).filter(s => !s.la && !s.lb && s.left[0] === pa[0] && s.right.at(-1) === pb.at(-1));
  return sites[0] ?? false;
}

/** One orientation per work unit, followed by a fresh quote and atomic native build. */
export function* throughTask(h: ThroughHost, item: ThroughItem): Generator<void, void> {
  const g = h.g, ls = item.ids.map(id => g.lines.map.get(id)), key = keyOf(item.ids);
  const finish = (why: string) => { delete item.through; h.careFor(key, 180); h.considered('through.' + why); };
  if (![2, 3].includes(ls.length) || ls.some(l => !l || !pathOf(l)) || ls[0]!.owner !== h.me || ls.length === 3 && ls[2]!.owner !== h.me
    || ls[1]!.owner === h.me || !g.canUse(h.me, ls[1]!.owner) || ls.length === 2 && !ls.some(l => urban(g, l!))) { finish('invalid'); return; }
  const lines = ls as Line[], sig = signature(g, lines, h.me), c = item.through ??= { at: 0, signature: sig };
  if (c.signature !== sig) { finish('changed'); return; }
  const trials = c.trials ??= throughTrials(g, lines);
  if (c.at < trials.length) {
    const [pa, pb, pc = []] = trials[c.at++];
    const initial = concat(pa, pb, pc), stock = stocks(h, lines, initial)[0]; if (!stock || lines.some(l => h.room(l) < 1)) return;
    const ab = boundary(h, lines[0], lines[1], pa, pb, stock), bc = lines.length === 3 ? boundary(h, lines[1], lines[2], pb, pc, stock) : null;
    if (ab === false || bc === false) return;
    let path = initial;
    if (ab || bc) {
      const middle = pb.filter(id => (!ab || ab.right.includes(id)) && (!bc || bc.left.includes(id)));
      if (!middle.length) return;
      path = concat(ab?.left ?? pa, middle, bc?.right ?? pc);
    }
    if (new Set(path).size !== path.length) return;
    const links = [ab, bc].filter((s): s is ThroughLink => !!s), plans = links.map(s => h.plan(s));
    if (plans.some(p => !p)) return;
    const works = plans.reduce((sum, p) => sum + p!.cost, 0);
    const context = throughQuoteContext(); context.broad = true;
    const reuse = [undefined, ...lines.filter(l => l.owner === h.me).flatMap(l => l.vehicles.map(id => g.vehicles.get(id)).filter((t): t is Train => t instanceof Train && t.owner === h.me && t.state === 'depot' && modelKey(t.cars) === modelKey(stock)))];
    for (const train of reuse) {
      const q = quoteThrough(h, lines, path, stock, works, links, train, undefined, plans as ConnectionPlan[], context);
      if (!q || !(q.score > 0) || !h.affordable(q.capital * 1.2 + 150000, 0.35) || c.best && q.score <= c.best.score) continue;
      // Expensive complete platform/depot checks belong to a paid contender, then run
      // again on the current constructed itinerary before any actual stock is published.
      if (!links.length && (!throughPlatforms(g, path, h.me, stock, context) || !(train ? [g.depots.get(train.depotId)] : [...g.depots.map.values()])
        .some(d => d && throughOpeningCall(g, path, h.me, stock, d.id) >= 0))) continue;
      c.best = { path, links: links.map(copyLink), score: q.score, cars: stock.map(m => m.id), ...(train ? { reuse: train.id } : {}) };
    }
    return;
  }
  const best = c.best; finish(best ? 'build' : 'unpaid'); if (!best) return;
  const cars = best.cars.map(id => MODEL_BY_ID.get(id)!).filter(Boolean); if (cars.length !== best.cars.length) return;
  const stored = best.reuse === undefined ? undefined : g.vehicles.get(best.reuse);
  const reuse = stored instanceof Train && stored.owner === h.me && lines.some(l => l.owner === h.me && l.id === stored.lineId)
    && stored.state === 'depot' && modelKey(stored.cars) === modelKey(cars) ? stored : undefined;
  const plans = best.links.map(s => h.plan(s)); if (plans.some(p => !p)) return;
  if (plans.some(p => p!.turnouts.some(t => g.vehicles.isEdgeBusy(t.edge)))) { h.considered('through.busy'); return; }
  let q = quoteThrough(h, lines, best.path, cars, plans.reduce((n, p) => n + p!.cost, 0), best.links, reuse, undefined, plans as ConnectionPlan[]);
  const depots = reuse ? [g.depots.get(reuse.depotId)].filter(d => !!d) : [...g.depots.map.values()];
  // Before new turnouts exist, prove the depot on an existing own leg. The final itinerary is proved after build.
  const depot = depots.find(d => d.kind === 'rail' && d.owner === h.me && (!best.links.length
    ? throughOpeningCall(g, best.path, h.me, cars, d.id) >= 0
    : lines.filter(l => l.owner === h.me).some(l => { const p = pathOf(l)!; return depotServes(g, d, p[0], p[1], cars) >= 0; })));
  if (!q || q.score <= 0 || !depot || !h.canSpend(q.capital * 1.2 + 150000, 0.35)) return;
  const transaction = buildThroughConnections(g, best.links, h.plan, h.mayAlter, true);
  if (transaction.error) { h.considered('through.rollback'); return; }
  // Native geometry can make the realised curve slower/longer than the survey. Reprice it before stock is paid.
  q = quoteThrough(h, lines, best.path, cars, transaction.cost, [], reuse, transaction.edges);
  if (!q || q.score <= 0 || !g.company(h.me).economy.canAfford(reuse ? 0 : cars.reduce((n, m) => n + m.cost, 0))) {
    transaction.rollback(); h.considered('through.actualPayback'); return;
  }
  const l = g.lines.create('rail', h.me); l.stops = outAndBack(best.path); g.lines.rebuild();
  const probe = new Train(g, -1, cars, depot.id); probe.lineId = l.id;
  const first = openingRailCall(g, probe);
  if (first < 0) { g.lines.delete(l.id); transaction.rollback(); h.considered('through.depot'); return; }
  priceSharedProject(g, l, q);
  if (!sharedTrainAllowed(g, l, h.me, cars)) { g.lines.delete(l.id); transaction.rollback(); h.considered('through.capacity'); return; }
  let train: Train | string;
  if (reuse) { reuse.setLine(l.id); train = reuse; }
  else train = g.vehicles.buyTrain(depot.id, [...cars], l.id) as Train | string;
  if (typeof train === 'string') { g.lines.delete(l.id); transaction.rollback(); h.considered('through.stock'); return; }
  train.stopIndex = first;
  h.managed()?.set(l.id, { kind: 'rail', towns: [...new Set(best.path.map(id => g.stations.get(id)!.townId).filter(id => id >= 0))],
    depot: depot.id, maxVehicles: Math.min(...lines.map(x => h.room(x))), opened: g.day, across: true });
  h.ai.stats.lines++; if (!reuse) h.ai.stats.vehicles++;
  h.stat('netThrough'); h.stat('netXServices'); if (best.links.length) h.stat('connections', best.links.length); h.succeed();
  h.note(`${l.name}: direct across ${g.company(lines[1].owner).name}'s ${lines[1].name}; ${reuse ? 'reuses a spare train' : 'buys one train'}, ${Math.round(q.score / 1000)}k annual surplus after access and local service costs`);
  h.news(`runs through its railway over ${g.company(lines[1].owner).name}'s ${lines.length === 3 ? 'middle ' : ''}railway.`, g.stations.get(best.path[0])!.x, g.stations.get(best.path[0])!.z);
  // Keep both shorter own timetables as patterns. The foreign operator and its fleet keep their own line.
  h.canon(l.id);
}

/** Roll back only this transaction's added connectors. Split descendants of every original asset stay. */
export function buildThroughConnections(g: Game, links: ThroughLink[], plan: (s: ThroughLink) => ConnectionPlan | null,
  mayAlter: (ids: number[]) => boolean = () => true, finish = false) {
  if (!links.length) return { error: null, edges: [] as number[], cost: 0, rollback() {} };
  const net = g.world.net, protectedIds = new Set(net.edges.keys()), added = new Set<number>(), owners = new Map<number, number>();
  const nodeOwners = new Map<number, number>();
  const heights = new Map<number, number>(), trees = new Map<number, Tree>(), w = g.world;
  const before = new Map([...net.nodes].map(([id, n]) => [id, { signal: n.signal, kind: n.signalKind, pass: n.signalPass }]));
  let cost = 0, owner = -1, error: string | null = null;
  const split = (old: NEdge, a: NEdge, b: NEdge) => {
    if (protectedIds.delete(old.id)) {
      protectedIds.add(a.id); protectedIds.add(b.id); owners.set(a.id, old.owner); owners.set(b.id, old.owner);
      const shared = [a.a, a.b].find(id => id === b.a || id === b.b);
      if (shared !== undefined) nodeOwners.set(shared, old.owner);
    }
    if (added.delete(old.id)) { added.add(a.id); added.add(b.id); }
  };
  const rollback = () => {
    for (const id of added) { const e = net.edges.get(id); if (!e || protectedIds.has(id)) continue;
      const box = net.grid.box(id); net.removeEdge(id); if (box) recomputeLocks(g.world, ...box); }
    for (const [id, o] of owners) { const e = net.edges.get(id); if (e) e.owner = o; }
    for (const [id, o] of nodeOwners) { const n = net.nodes.get(id); if (n) n.owner = o; }
    for (const [index, height] of heights) w.setVertex(index % (w.size + 1), Math.floor(index / (w.size + 1)), height);
    const restored = new Set<number>();
    for (const [id, t] of trees) if (!w.trees[id]) { w.trees[id] = t; w.treeGrid.insert(id, t.x, t.z, t.x, t.z);
      w.indexSavedTree(id, t); w.saveTreeVersions[Math.floor(id / SAVE_TREES)]++; w.markObj(t.x, t.z); restored.add(id); }
    if (restored.size) w.freeTrees = w.freeTrees.filter(id => !restored.has(id));
    for (const [id, n] of net.nodes) { const old = before.get(id); if (old) { n.signal = old.signal; n.signalKind = old.kind; n.signalPass = old.pass; } }
    if (owner >= 0 && cost) g.company(owner).economy.spend(-cost, 'construction', true);
    cost = 0; net.version++; g.onNetworkChanged();
  };
  const apply = (p: ConnectionPlan | null): string | null => {
      if (!p || p.turnouts.some(t => g.vehicles.isEdgeBusy(t.edge) || g.vehicles.getRes(t.edge))) return 'connection changed or busy';
      if (!reversible(p)) return 'connection needs support works on original infrastructure';
      // Snapshot only the bounded local formation. Native earthworks reach ten units from a curve.
      const curves = p.proposal?.tracks.map(t => t.bez) ?? (p.crossover ? (() => {
        const { a, b } = p.crossover, dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
        const sa = a.tx * dx + a.tz * dz >= 0 ? 1 : -1, sb = b.tx * dx + b.tz * dz >= 0 ? 1 : -1;
        return [bezFromTangents(a.x, a.z, a.tx * sa, a.tz * sa, b.x, b.z, b.tx * sb, b.tz * sb, L * .38, L * .38)];
      })() : []);
      const margin = EARTHWORKS.reach + EARTHWORKS.corePad + 3;
      for (const c of curves) {
        const x0 = Math.max(0, Math.floor(Math.min(c.x0, c.x1, c.x2, c.x3) - margin)), x1 = Math.min(w.size, Math.ceil(Math.max(c.x0, c.x1, c.x2, c.x3) + margin));
        const z0 = Math.max(0, Math.floor(Math.min(c.z0, c.z1, c.z2, c.z3) - margin)), z1 = Math.min(w.size, Math.ceil(Math.max(c.z0, c.z1, c.z2, c.z3) + margin));
        for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) { const i = w.vi(x, z); if (!heights.has(i)) heights.set(i, w.h[i]); }
        for (const id of w.treeGrid.query(x0, z0, x1, z1)) { const t = w.trees[id]; if (t && !trees.has(id)) trees.set(id, t); }
      }
      owner = p.owner; const money = g.company(owner).economy.money;
      const r = commitConnection(g, p, { signals: false }); cost += money - g.company(owner).economy.money;
      // Include partial failed construction too, while excluding every protected split child.
      for (const [id, e] of net.edges) if (!protectedIds.has(id) && e.kind === 'rail') added.add(id);
      return r.error;
  };
  net.onSplit.push(split);
  try {
    for (const s of links) {
      const p = plan(s); error = apply(p); if (error || !p) break;
      if (finish) for (const [i, t] of p.turnouts.entries()) {
        const xo = junctionPlan(g, t.x, t.z, i ? p.dirB : (p.dirA === 1 ? -1 : 1), p.owner, protectedIds, mayAlter);
        if (xo) { error = apply(xo); if (error) break; }
      }
      if (error) break;
    }
  } finally { net.onSplit.splice(net.onSplit.indexOf(split), 1); }
  if (error) rollback();
  return { error, edges: [...added], get cost() { return cost; }, rollback };
}

/** Native return movement beside a double-track turnout, with the same short searches as xlink. */
function junctionPlan(g: Game, x0: number, z0: number, dir: 1 | -1, owner: number, protectedIds: Set<number>, mayAlter: (ids: number[]) => boolean): ConnectionPlan | null {
  const net = g.world.net, plain = (e: NEdge) => protectedIds.has(e.id) && e.station < 0 && e.depot < 0 && mayAlter([e.id]);
  const hit = net.nearestEdge(x0, z0, .6, 'rail', plain); if (!hit) return null;
  const p = { x: 0, y: 0, z: 0 }, d = { x: 0, y: 0, z: 0 }; net.pointAt(hit.edge, hit.s, p, d);
  const tangent = bezDeriv(hit.edge.bez, tAtS(net.table(hit.edge), hit.s)); d.x = tangent.x; d.z = tangent.z;
  const norm = Math.hypot(d.x, d.z) || 1, tx = d.x / norm * dir, tz = d.z / norm * dir;
  for (const ahead of [8, 14, 20]) {
    const a = net.nearestEdge(x0 + tx * ahead, z0 + tz * ahead, 2, 'rail', e => plain(e) && e.type === hit.edge.type); if (!a) continue;
    net.pointAt(a.edge, a.s, p, d);
    const b = net.nearestEdge(p.x, p.z, 1.8, 'rail', e => e.id !== a.edge.id && plain(e) && e.type === a.edge.type);
    if (!b || b.d < .25) continue;
    net.pointAt(b.edge, b.s, p, d); const bt = bezDeriv(b.edge.bez, tAtS(net.table(b.edge), b.s));
    const dot = (bt.x * tx + bt.z * tz) / (Math.hypot(bt.x, bt.z) || 1); if (Math.abs(dot) < .97) continue;
    // Signal cuts can make the eight-unit target lie on the next fragment of the companion track.
    const target = net.nearestEdge(p.x + tx * 8, p.z + tz * 8, .3, 'rail', e => plain(e) && e.id !== a.edge.id && e.type === a.edge.type);
    if (!target || target.s < 1 || target.s > target.edge.len - 1) continue;
    const p2 = planConnection(g, a.edge.id, a.s, target.edge.id, target.s, owner);
    if (reversible(p2) && p2.crossover) return p2;
  }
  return null;
}
