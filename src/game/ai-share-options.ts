// Shared-entry bids use the same native private/pool investment as later fleet admission.
import type { Game } from './game';
import type { Line } from './lines';
import type { Station } from './stations';
import type { VehicleModel } from './vehicle-types';
import { MODEL_BY_ID } from './vehicle-types';
import { pickTrain, openingCoaches } from './ai';
import { patternStops, nextStopIndex } from './patterns';
import { consistRule, findRailRoute } from './train';
import { platformChoicesForStock, platformPreference } from './rail-platforms';
import { planSideDepot, sidingSpots, type SideQuote } from './depot-sites';
import { marginalTrainInvestment, sharedTrainAllowed } from './ai-capacity';

export type ShareDepot = { kind: 'existing'; id: number; opening: number }
  | ({ kind: 'planned' } & SideQuote);
export interface ShareBid {
  line: number; lead: number; owner: number; pattern: number; stops: number[]; cars: string[];
  identity: string; depot: ShareDepot; stock: number; works: number; upkeep: number; capital: number;
  native: { investor: number; pooled: number }; rate: number; amortisation: number;
  net: number; poolNet: number; score: number; witness?: PhysicalWitness;
}
export interface ShareOptionsHost {
  g: Game; owner: number; risk: number; focus: number;
  available(): number; capacity(line: Line): number; failed(key: string): boolean;
  serves(a: number, b: number): boolean;
}
export interface PhysicalWitness {
  owner: number;
  access: [number, number][];
  edges: [number, string][]; nodes: [number, string][]; stations: [number, string][];
}
interface Candidate {
  line: number; identity: string; cars: string[]; pattern: number; calls: number[]; at: number;
  phase: 'platforms' | 'existing' | 'sites' | 'siteEntry' | 'value'; witness: PhysicalWitness;
  depots: number[]; depotAt: number; call: number; spots?: { id: number; s: number }[]; site: number;
  depot?: ShareDepot; prospective?: SideQuote;
}
export interface ShareOptionsCursor { lines: number[]; at: number; candidate?: Candidate }
export interface ShareOption {
  score: number; kind: 'share'; towns: number[]; hub: number;
  share: [number, number, number, number]; shareBid: ShareBid;
}
export const newShareOptionsCursor = (g: Game): ShareOptionsCursor => ({ lines: [...g.lines.map.keys()], at: 0 });

/** The literal ordinary-rail ranking transform; the positive-surplus/funds gate belongs to the caller. */
export function railInvestmentScore(net: number, capital: number, risk: number): number {
  const amortisation = .045 - .03 * risk, years = 1 / (.03 + amortisation);
  return (Math.sqrt(Math.max(0, net / Math.max(1, capital))) + .15) * years / 9;
}
function identity(g: Game, l: Line): string {
  return JSON.stringify([l.id, l.owner, l.kind, l.stops, l.loop, l.patterns, l.partners,
    l.vehicles.map(id => { const t = g.vehicles.get(id); return [id, t?.owner, t?.pattern,
      t?.kind === 'train' ? [(t as import('./train').Train).length, (t as import('./train').Train).cars.map(c => c.id).sort()] : []]; })]);
}
function edgeKey(g: Game, id: number): string {
  const e = g.world.net.edges.get(id);
  return JSON.stringify(e ? [e.id, e.kind, e.a, e.b, e.sa, e.sb, e.owner, e.type, e.station, e.depot,
    e.len, e.bez, [...e.prof], e.sections] : null);
}
function nodeKey(g: Game, id: number): string {
  const n = g.world.net.nodes.get(id);
  return JSON.stringify(n ? [n.id, n.kind, n.owner, n.x, n.y, n.z, n.dx, n.dz, n.signal, n.signalKind, n.signalPass, n.edges] : null);
}
function stationKey(g: Game, id: number): string {
  const s = g.stations.get(id);
  return JSON.stringify(s?.rail ? [s.id, s.owner, s.rail.x, s.rail.y, s.rail.z,
    g.stations.railTrackGroups(s).map(q => [q.id, q.length, q.steps])] : null);
}
function remember(g: Game, w: PhysicalWitness, edges: number[], stations: number[], access?: [number, number][]) {
  const permissions = access ?? edges.flatMap(id => { const e = g.world.net.edges.get(id); return e ? [[w.owner, e.owner] as [number, number]] : []; });
  for (const [user, owner] of permissions.concat(stations.flatMap(id => {
    const st = g.stations.get(id); return st ? [[w.owner, st.owner] as [number, number]] : [];
  }))) if (!w.access.some(([u, o]) => u === user && o === owner)) w.access.push([user, owner]);
  for (const id of edges) if (!w.edges.some(q => q[0] === id)) {
    w.edges.push([id, edgeKey(g, id)]);
    const e = g.world.net.edges.get(id);
    for (const nid of e ? [e.a, e.b] : []) if (!w.nodes.some(q => q[0] === nid)) w.nodes.push([nid, nodeKey(g, nid)]);
  }
  for (const id of stations) if (!w.stations.some(q => q[0] === id)) w.stations.push([id, stationKey(g, id)]);
}
export function validSharedWitness(g: Game, w: PhysicalWitness): boolean {
  return Number.isInteger(w.owner) && Array.isArray(w.access) && w.access.every(([user, owner]) => g.canUse(user, owner))
    && w.edges.every(([id, key]) => edgeKey(g, id) === key)
    && w.nodes.every(([id, key]) => nodeKey(g, id) === key)
    && w.stations.every(([id, key]) => stationKey(g, id) === key);
}

/** Preserve the original chooser's anchors even for rings and folded stopping lists. */
export function shareAnchors(g: Game, l: Line, pattern = l.patterns?.[0]?.id ?? 0): { a: Station; b: Station; span: number } | null {
  const calls = patternStops(l, pattern), a = g.stations.get(l.stops[calls[0]]);
  if (!a?.rail) return null;
  let b: Station | undefined, span = 0;
  for (const index of calls) {
    const st = g.stations.get(l.stops[index]), distance = st ? Math.hypot(st.x - a.x, st.z - a.z) : 0;
    if (st && distance > span) { b = st; span = distance; }
  }
  return b?.rail ? { a, b, span } : null;
}

export function sharedServiceEligible(h: ShareOptionsHost, l: Line): boolean {
  const g = h.g, owner = h.owner, anchors = shareAnchors(g, l);
  if (l.kind !== 'rail' || l.owner === owner || !anchors || !l.vehicles.length
    || g.lines.canOperate(l, owner) || !g.companies[l.owner] || g.company(l.owner).defunct
    || g.accessPolicy(l.owner) === 'auto-reject' || g.isBlocked(l.owner, owner)
    || g.requestsBy(owner).some(q => q.owner === l.owner) || g.lines.partnerPolicy(l) !== 'open'
    || !g.canUse(owner, l.owner) || l.stops.some(id => { const s = g.stations.get(id); return !s?.rail || !g.canUse(owner, s.owner); })) return false;
  const { a, b, span } = anchors;
  return a.townId >= 0 && b.townId >= 0 && a.townId !== b.townId && span >= 60 && span <= 260
    && !h.serves(a.townId, b.townId) && !h.failed(`share${l.owner}:${Math.min(a.id, b.id)}-${Math.max(a.id, b.id)}`);
}
function models(c: Candidate): VehicleModel[] { return c.cars.map(id => MODEL_BY_ID.get(id)!).filter(Boolean); }
function current(h: ShareOptionsHost, c: Candidate): Line | null {
  const l = h.g.lines.map.get(c.line);
  return l && sharedServiceEligible(h, l) && identity(h.g, l) === c.identity && validSharedWitness(h.g, c.witness) ? l : null;
}
export function sharedDepotOpening(g: Game, l: Line, cars: VehicleModel[], owner: number, edge: number,
  dir: number, index: number, pattern = l.patterns?.[0]?.id ?? 0) {
  const stub = g.world.net.edges.get(edge); if (!stub) return null;
  const next = nextStopIndex(l, pattern, index);
  const preference = platformPreference(l, pattern, index);
  return findRailRoute(g, [{ edge: stub, dir }], l.stops[index], owner, -1, 60000, false,
    consistRule(cars), true, { preferred: preference?.group, manual: preference?.manual,
      length: cars.reduce((n, m) => n + m.length + .1, 0), onward: l.stops[next] });
}

/** Keep the actual post-works depot path valid across the final saved purchase boundary too. */
export function proveSharedOpening(g: Game, l: Line, cars: VehicleModel[], owner: number, edge: number,
  index: number, previous: PhysicalWitness, pattern = l.patterns?.[0]?.id ?? 0): PhysicalWitness | null {
  if (previous.owner !== owner || !validSharedWitness(g, previous)) return null;
  const route = sharedDepotOpening(g, l, cars, owner, edge, 1, index, pattern);
  if (!route) return null;
  remember(g, previous, [edge, ...route.conts.map(c => c.edge.id)], [l.stops[index]]);
  return previous;
}

/** Existing native investor/pool terms already contain running, fees, wear and 3% stock carry. */
export function priceSharedBid(h: ShareOptionsHost, l: Line, cars: VehicleModel[], pattern: number,
  depot: ShareDepot, actual?: { cost: number; upkeep: number }): ShareBid | null {
  if (!sharedServiceEligible(h, l) || !cars.length || patternStops(l, pattern).length < 2
    || l.vehicles.length >= h.capacity(l)) return null;
  let works = 0, upkeep = 0, refreshed = depot;
  if (actual) { works = actual.cost; upkeep = actual.upkeep; }
  else if (depot.kind === 'planned') {
    const q = planSideDepot(h.g, depot.edge, depot.s, h.owner, { dir: depot.dir, side: depot.side });
    if (!q || q.demolish.length) return null;
    refreshed = { kind: 'planned', ...q }; works = q.cost; upkeep = q.upkeep;
  } else if (h.g.depots.get(depot.id)?.owner !== h.owner) return null;
  const stock = cars.reduce((n, m) => n + m.cost, 0), capital = stock + works;
  // Already-paid works belong to the investment return, but only the remaining stock needs cash.
  if ((actual ? stock : capital) > h.available()) return null;
  const native = marginalTrainInvestment(h.g, l, h.owner, cars, pattern);
  const rate = Math.max(.03, h.g.company(h.owner).economy.interestRate), amortisation = .045 - .03 * h.risk;
  const missing = stock * (rate - .03) + upkeep + works * (rate + amortisation);
  const net = native.investor - missing, poolNet = native.pooled - missing;
  if (!(net > 0 && poolNet > 0) || !sharedTrainAllowed(h.g, l, h.owner, cars, pattern)) return null;
  return { line: l.id, lead: l.owner, owner: h.owner, pattern, stops: [...l.stops], cars: cars.map(m => m.id),
    identity: identity(h.g, l), depot: refreshed, stock, works, upkeep, capital, native, rate, amortisation,
    net, poolNet, score: railInvestmentScore(net, capital, h.risk) * h.focus * h.focus };
}
export function sharedBidLine(g: Game, bid: ShareBid, physical = true): Line | null {
  const l = g.lines.map.get(bid.line);
  return l && l.owner === bid.lead && identity(g, l) === bid.identity
    && (!physical || !bid.witness || validSharedWitness(g, bid.witness)) ? l : null;
}

/** A selected bid rechecks one advertised occurrence per saved job unit before funding/purchase. */
export function proveSharedCall(g: Game, l: Line, pattern: number, index: number, owner: number,
  cars: VehicleModel[], previous: PhysicalWitness = { owner, access: [], edges: [], nodes: [], stations: [] }): PhysicalWitness | null {
  if (previous.owner !== owner || !validSharedWitness(g, previous)) return null;
  const choices = platformChoicesForStock(g, l, pattern, index,
    { owner, length: cars.reduce((n, m) => n + m.length + .1, 0), rule: consistRule(cars) });
  if (!choices.length) return null;
  remember(g, previous, choices[0].witnessEdges, [...new Set(l.stops)], choices[0].witnessAccess);
  return previous;
}

/** One candidate, native call proof or depot site per saved unit. No process-cache readiness is authority. */
export function* resumeShareOptions(h: ShareOptionsHost, cursor: ShareOptionsCursor): Generator<void, ShareOption[]> {
  const options: ShareOption[] = [], g = h.g;
  const finish = () => { delete cursor.candidate; cursor.at++; };
  while (cursor.at < cursor.lines.length) {
    if (!cursor.candidate) {
      const l = g.lines.map.get(cursor.lines[cursor.at]);
      if (!l || !sharedServiceEligible(h, l)) { cursor.at++; yield; continue; }
      const { a, b, span } = shareAnchors(g, l)!;
      const pattern = l.patterns?.[0]?.id ?? 0, calls = patternStops(l, pattern);
      const length = Math.min(...calls.map(index => g.stations.get(l.stops[index])!.rail!.length));
      const cars = pickTrain(g.year, length, span * 1.25,
        openingCoaches(g.towns.list[a.townId].pop, g.towns.list[b.townId].pop));
      if (!cars || calls.length < 2 || l.vehicles.length >= h.capacity(l)) { cursor.at++; yield; continue; }
      cursor.candidate = { line: l.id, identity: identity(g, l), cars: cars.map(m => m.id), pattern, calls, at: 0,
        phase: 'platforms', witness: { owner: h.owner, access: [], edges: [], nodes: [], stations: [] },
        depots: [...g.depots.map.values()].filter(d => d.kind === 'rail' && d.owner === h.owner).map(d => d.id),
        depotAt: 0, call: 0, site: 0 };
      yield; continue;
    }
    const c = cursor.candidate, l = current(h, c), cars = models(c);
    if (!l || cars.length !== c.cars.length) { finish(); yield; continue; }
    if (c.phase === 'platforms') {
      const index = c.calls[c.at++], choices = platformChoicesForStock(g, l, c.pattern, index,
        { owner: h.owner, length: cars.reduce((n, m) => n + m.length + .1, 0), rule: consistRule(cars) });
      if (!choices.length) { finish(); yield; continue; }
      const q = choices[0];
      remember(g, c.witness, q.witnessEdges, [l.stops[index]], q.witnessAccess);
      if (c.at === c.calls.length) c.phase = 'existing';
      yield; continue;
    }
    if (c.phase === 'existing') {
      const dp = g.depots.get(c.depots[c.depotAt]);
      if (!dp || dp.owner !== h.owner || dp.kind !== 'rail') {
        c.depotAt++; c.call = 0;
        if (c.depotAt >= c.depots.length) c.phase = 'sites';
        yield; continue;
      }
      const index = c.calls[c.call++], r = sharedDepotOpening(g, l, cars, h.owner, dp.edge, 1, index);
      if (r) {
        remember(g, c.witness, [dp.edge, ...r.conts.map(q => q.edge.id)], [l.stops[index]]);
        c.depot = { kind: 'existing', id: dp.id, opening: index }; c.phase = 'value';
      } else if (c.call === c.calls.length) { c.call = 0; c.depotAt++; }
      if (!c.depot && c.depotAt >= c.depots.length) c.phase = 'sites';
      yield; continue;
    }
    if (c.phase === 'sites') {
      if (!c.spots) {
        const { a, b } = shareAnchors(g, l)!, ends = [a, b];
        // Same native siding helpers, ground first and at most sixteen sites per end/pass.
        const edges = c.witness.edges.map(q => q[0]);
        c.spots = [['ground'], ['bridge', 'tunnel']].flatMap(sections => ends.flatMap(st =>
          sidingSpots(g, edges, st.x, st.z, l.owner, Infinity, 16,
            sections as ('ground' | 'bridge' | 'tunnel')[]).slice(0, 16)));
        yield; continue;
      }
      const site = c.spots[c.site++];
      if (!site) { finish(); yield; continue; }
      const q = planSideDepot(g, site.id, site.s, h.owner);
      if (q && !q.demolish.length) { c.prospective = q; c.call = 0; c.phase = 'siteEntry'; }
      yield; continue;
    }
    if (c.phase === 'siteEntry') {
      const q = c.prospective!, index = c.calls[c.call++];
      const r = sharedDepotOpening(g, l, cars, h.owner, q.edge, q.dir, index);
      if (r) { remember(g, c.witness, r.conts.map(q => q.edge.id), [l.stops[index]]);
        c.depot = { kind: 'planned', ...q }; c.phase = 'value';
      } else if (c.call === c.calls.length) { delete c.prospective; c.phase = 'sites'; }
      yield; continue;
    }
    const bid = c.depot && priceSharedBid(h, l, cars, c.pattern, c.depot);
    if (bid) {
      bid.witness = { owner: h.owner, access: c.witness.access.map(q => [...q]),
        edges: c.witness.edges.map(q => [...q]), nodes: c.witness.nodes.map(q => [...q]),
        stations: c.witness.stations.map(q => [...q]) };
      const { a, b } = shareAnchors(g, l)!;
      // Append and cursor advance are one unit; the caller publishes before the next yield.
      options.push({ score: bid.score, kind: 'share', towns: [a.townId, b.townId], hub: a.id,
        share: [l.owner, a.id, b.id, l.id], shareBid: bid });
    }
    finish();
    return options;
  }
  return options;
}
