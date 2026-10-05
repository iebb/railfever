// Initial capacity is an investment: compare saved fares and avoided live works with the extra rail's upkeep.
import type { Game } from './game';
import type { Proposal } from './construction';
import { doubleTrackCompletionReserve, quoteDoubleTrackCompletion, type DoublePlan } from './trackops';
import type { Economy } from './economy';
import { SHARED_TRACK, structureFactor } from './construction';
import { TRACK_TYPES, UNIT_M, ELECTRIFY, WATER_Y } from './constants';
import { trackBasePerUnit } from './opcosts';
import { planCapacityTrackUpgrade, commitCapacityTrackUpgrade } from './ai-capacity-works';
import { depotUpkeep } from './build-ops';
import { autoSignalLine, lineTrack, chainsOf } from './signals';
import { consistRule, findRailRoute, platformDepartureFrontiers } from './train';
import type { Line } from './lines';
import type { VehicleModel } from './vehicle-types';

export interface InitialTrackTraffic {
  revenue: number;
  boardings: number;
  seats: number;
  trains: number;
  headway: number;
  kmh: number;
  /** Longest section held until an opposing train can pass, including a connector's station approaches. */
  blockLength: number;
  risk: number;
  /** Existing services conflicting at a connector's junctions, in trains per second (both directions). */
  junctionTraffic?: number;
}
/** Optional capacity pays only the extra debt it causes; mandatory formation/fleet funding is the baseline.
 * Mirror borrowFor's stepped borrowing and £300k cash cushion without spending or requesting a loan.
 * `baseSpend` includes any explicit reserve passed by the caller in addition to that cushion. */
export function initialTrackFinancing(e: Pick<Economy, 'money' | 'loan' | 'maxLoan' | 'loanStep' | 'interestRate'>,
  baseSpend: number, cost: number) {
  const remaining = Math.max(0, Math.floor((e.maxLoan - e.loan) / e.loanStep));
  const borrowed = (spend: number) => Math.min(remaining,
    Math.max(0, Math.ceil((spend + 300_000 - e.money) / e.loanStep))) * e.loanStep;
  const baseLoan = borrowed(baseSpend), totalLoan = borrowed(baseSpend + cost);
  const incrementalLoan = Math.max(0, totalLoan - baseLoan);
  return { baseLoan, totalLoan, incrementalLoan, annualInterest: incrementalLoan * e.interestRate,
    affordable: e.money + totalLoan >= baseSpend + cost };
}

export function initialTrackChoice(t: InitialTrackTraffic, cost: number, upkeep: number, annualInterest = 0) {
  const crossing = t.blockLength * UNIT_M / (Math.max(15, t.kmh) / 3.6) + 20;
  // One train cannot meet itself. With more trains, opposing arrivals contend for the single section.
  const arrivals = 2 / Math.max(30, t.headway) * Math.max(0, t.trains - 1) / Math.max(1, t.trains)
    + Math.max(0, t.junctionTraffic ?? 0);
  const occupancy = crossing * arrivals;
  const singleCapacity = Math.min(1, 0.85 / Math.max(0.85, occupancy));
  const unmet = Math.max(0, t.boardings - t.seats) / Math.max(1, t.boardings);
  // Opposing trains wait roughly half a section traversal. Congested corridors additionally lose departures.
  const delay = Math.min(0.45, Math.max(0, occupancy - 0.35) * crossing / Math.max(30, t.headway));
  const lost = Math.min(0.75, 1 - singleCapacity + delay);
  const recovered = Math.max(0, t.revenue) * lost;
  const horizon = 6 + 12 * Math.max(0, Math.min(1, t.risk));
  // A later upgrade uses the same shared civil formation, but must stop/hold live trains. Discount the future
  // expense; count it only in proportion to a capacity shortfall already supported by this forecast.
  const later = Math.min(1, Math.max(unmet, occupancy - 0.65));
  const closureDays = 2 + t.blockLength / 100;
  const disruption = t.revenue * closureDays / 360;
  const avoidedUpgrade = later * (cost + disruption) / 1.03 ** 3;
  const value = (recovered - upkeep - annualInterest) * horizon + avoidedUpgrade;
  return { double: cost > 0 && value > cost && recovered > upkeep + annualInterest, recovered, upkeep, annualInterest, cost, value,
    occupancy, avoidedUpgrade, singleCapacity, doubleCapacity: Math.min(1, Math.max(30, t.headway) / 45) };
}

/** Quote a second rail using planEdge's materials/structures/earthworks shares, with full overhead-wire cost. */
export function initialSecondTrackCost(prof: { y: number[]; terr: number[]; s: number[] }, type: string) {
  const per = TRACK_TYPES.standard.costPerUnit, wire = TRACK_TYPES[type]?.electrified ? ELECTRIFY.costPerUnit : 0;
  let cost = 0, upkeep = 0, depth = 0, height = 0, tunnel = false, bridge = false;
  for (let i = 1; i < prof.s.length; i++) {
    const ds = prof.s[i] - prof.s[i - 1], delta = prof.y[i] - prof.terr[i];
    const section = delta < -1.9 ? 'tunnel' : delta > 1.1 || prof.terr[i] < WATER_Y + 0.05 ? 'bridge' : 'ground';
    tunnel ||= section === 'tunnel'; bridge ||= section === 'bridge';
    cost += ds * (per * SHARED_TRACK.materials + wire);
    if (section !== 'ground') cost += ds * per * (structureFactor('rail', section, Math.abs(delta)) - 1) * SHARED_TRACK.structures;
    else cost += Math.abs(delta) * ds * (2.14 + Math.abs(delta) * 2) * 900 * SHARED_TRACK.earthworks;
    upkeep += ds * trackBasePerUnit(type) * (section === 'ground' ? 1 : section === 'tunnel' ? 5 : 4);
  }
  for (let i = 0; i < prof.y.length; i++) {
    depth = Math.max(depth, prof.terr[i] - prof.y[i]); height = Math.max(height, prof.y[i] - prof.terr[i]);
  }
  const finish = doubleTrackCompletionReserve(type, prof.s[prof.s.length - 1], depth, height, tunnel, bridge);
  return { cost: cost * 1.15 + 100_000 + finish.cost, upkeep: upkeep + finish.upkeep };
}

/**
 * The ONE initial-double construction adapter. Given an already committed, unserved single formation or
 * connector, choose a complete second rail from its real plans and lay it before trains enter it.
 * Endpoint platforms and companion junction leads are supplied by the existing capacity/track-rights planner.
 * Contract: no yielding, no stored Proposal, real costs charged to payer, existing titles preserved; reject an
 * uneconomic or obstructed pair without replacing it with a partial loop. Future saved sections with tracks=2
 * should replace this function's physical implementation while retaining the traffic/value contract.
 * capacity-integration: tracks=3/4 or parallel pairs may extend this adapter when double capacity is exhausted;
 * platform and overtaking works continue through the shared-capacity adapter today. `preserveEntry` can
 * reject a plan direction which would strand an already proven depot, before any extra capacity is paid.
 * Native formation failures refund new construction but can retain old splits; native finishing errors can
 * retain a paid unfinished companion and return built=false. The funded ceiling bounds spending; it does
 * not replace those native rollback/finish semantics with a whole-network transaction.
 */
export function layInitialDoubleTrack(g: Game, edges: number[], payer: number, traffic: InitialTrackTraffic,
  fund: (cost: number) => boolean, consent?: (p: Proposal) => boolean, preserveEntry?: (p: DoublePlan) => boolean, baseSpend = 0) {
  const e = g.company(payer).economy;
  // A failed physical attempt refunds construction, but its native borrowing remains. Both sides must be
  // valued against the same mandatory-only opening counterfactual, not against cash borrowed by the first.
  const financeAtEntry = { money: e.money, loan: e.loan, maxLoan: e.maxLoan, loanStep: e.loanStep, interestRate: e.interestRate };
  const plans = ([1, -1] as const).map(side => planCapacityTrackUpgrade(g, edges, side, payer))
    .filter(p => p.ok && p.complete && p.start.kind !== 'turnout' && p.end.kind !== 'turnout'
      && (!consent || p.proposals.every(consent)) && (!preserveEntry || preserveEntry(p))).sort((a, b) => a.cost - b.cost || b.side - a.side);
  for (const plan of plans) {
    const type = g.world.net.edges.get(edges[0])?.type ?? 'standard', per = trackBasePerUnit(type);
    const upkeep = plan.proposals.reduce((n, p, i) => n + (plan.skipped?.includes(i) ? 0 : p.tracks.reduce((n, t) =>
      n + t.len * per + t.sections.reduce((n, s) => n + (s.s1 - s.s0) * per * (s.type === 'tunnel' ? 4 : 3), 0), 0)), 0);
    const complete = quoteDoubleTrackCompletion(g, plan), finance = initialTrackFinancing(financeAtEntry, baseSpend, complete.cost);
    const retainedLoan = Math.max(0, e.loan - financeAtEntry.loan - finance.baseLoan);
    const annualInterest = Math.max(finance.incrementalLoan, retainedLoan) * financeAtEntry.interestRate;
    const choice = initialTrackChoice(traffic, complete.cost, upkeep + complete.upkeep, annualInterest);
    if (!choice.double || !finance.affordable || !fund(complete.cost)) return { built: false, choice, edges: [], signals: 0, cost: 0 };
    const result = commitCapacityTrackUpgrade(g, plan, consent, complete.cost, complete);
    if (!result.error) return { built: !result.finishError, choice, ...result };
  }
  return { built: false, choice: undefined, edges: [], signals: 0, cost: 0 };
}

interface OpeningAsset { kind: 'edge' | 'node' | 'station' | 'depot'; id: number; signature: string }
export interface OpeningThroatBaseline {
  owner: number; year: number; construction: number; maintenance: number; assets: OpeningAsset[];
}
function openingAssetSignature(g: Game, kind: OpeningAsset['kind'], id: number): string | undefined {
  const net = g.world.net;
  if (kind === 'edge') {
    const e = net.edges.get(id);
    return e && JSON.stringify([e.owner, e.kind, e.type, e.len, e.tram, e.tramOwner, e.a, e.b, e.sa, e.sb, e.bez, e.prof, e.sections, e.station, e.depot]);
  }
  if (kind === 'node') {
    const n = net.nodes.get(id);
    return n && JSON.stringify([n.owner, n.x, n.y, n.z, n.edges, n.signal, n.signalPass, n.signalKind]);
  }
  if (kind === 'station') { const s = g.stations.get(id); return s && JSON.stringify([s.owner, s.rail, s.stops]); }
  const d = g.depots.get(id); return d && JSON.stringify(d);
}
/** Native opening books, before construction. Legacy rail generators cancel on load; they do not resume this baseline. */
export function openingThroatBaseline(g: Game, owner: number): OpeningThroatBaseline {
  const assets: OpeningAsset[] = [], nodes = new Set<number>();
  const add = (kind: OpeningAsset['kind'], id: number) => { const signature = openingAssetSignature(g, kind, id); if (signature !== undefined) assets.push({ kind, id, signature }); };
  for (const e of g.world.net.edges.values()) if (e.owner === owner || e.tram && e.tramOwner === owner) { add('edge', e.id); nodes.add(e.a); nodes.add(e.b); }
  for (const id of nodes) add('node', id);
  for (const s of g.stations.map.values()) if (s.owner === owner) add('station', s.id);
  for (const d of g.depots.map.values()) if (d.owner === owner) add('depot', d.id);
  return { owner, year: g.year, construction: g.company(owner).economy.thisYear.construction, maintenance: g.maintenanceOf(owner), assets };
}

/** Reprice paid native formation, not the depot/throat estimate twice. Unrelated expense is conservative;
 * changes to old owned assets invalidate the baseline so their refunds/upkeep falls cannot subsidise this opening. */
export function openingThroatReturn(g: Game, before: OpeningThroatBaseline,
  project: { edges: readonly number[]; stations: readonly number[]; depots: readonly number[] },
  service: { total: number; fleet: number; income: number; running: number; maintenance: number; wear: number; amortisation: number },
  cost: number, upkeep: number): { pays: boolean; capital: number; maintenance: number; need: number; paid: number } | null {
  if (before.assets.some(a => openingAssetSignature(g, a.kind, a.id) !== a.signature)) return null;
  const eco = g.company(before.owner).economy;
  let construction = eco.thisYear.construction;
  for (let year = before.year; year < g.year; year++) {
    const record = eco.yearTotals.find(r => r.year === year);
    if (!record) return null;
    construction += record.v.construction;
  }
  const paid = before.construction - construction;
  if (paid < 0 || !Number.isFinite(paid)) return null;
  let assets = 0;
  for (const id of new Set(project.edges)) { const e = g.world.net.edges.get(id); if (e?.owner === before.owner) assets += g.edgeMaintenance(e); }
  for (const id of new Set(project.stations)) { const s = g.stations.get(id); if (s?.owner === before.owner) assets += g.stationMaintenance(s); }
  for (const id of new Set(project.depots)) { const d = g.depots.get(id); if (d?.owner === before.owner) assets += depotUpkeep(d); }
  const capital = Math.max(service.total, paid + service.fleet + cost);
  const maintenance = Math.max(service.maintenance, Math.max(assets, g.maintenanceOf(before.owner) - before.maintenance) + service.wear + upkeep);
  const need = (capital - service.fleet) * service.amortisation + capital * .03;
  return { pays: [capital, maintenance, need].every(Number.isFinite) && service.income - service.running - maintenance >= need, capital, maintenance, need, paid };
}

/** Exact current timetable and native initial-departure rails; no prospective graph or allocated IDs. */
export function openingSignalPlan(g: Game, line: Line, depot: number, cars: VehicleModel[], first: number) {
  // The supported fresh opening has native default stock; custom patterns need their own departure proof.
  if (line.patterns?.length || line.operators?.length || line.vehicles.length || line.stops.length !== 2 || line.stops[0] === line.stops[1]
    || line.stops.some(id => g.stations.get(id)?.owner !== line.owner)) return null;
  const dp = g.depots.get(depot), stub = dp && g.world.net.edges.get(dp.edge), index = line.stops.indexOf(first);
  if (!dp || dp.owner !== line.owner || !stub || index < 0) return null;
  const onward = line.stops[1 - index], rule = consistRule(cars), length = cars.reduce((n, c) => n + c.length + .1, 0);
  const path = findRailRoute(g, [{ edge: stub, dir: 1 }], first, line.owner, -1, 60000, false, rule, true, { length, onward });
  if (!path) return null;
  const end = path.conts[path.conts.length - 1];
  const group = g.stations.railTrackGroups(g.stations.get(first)!).find(q => q.steps.some(s => s.edge === end.edge.id));
  if (!group) return null;
  const arrival = group.steps.find(s => s.edge === end.edge.id)!;
  const ordered = arrival.dir === end.dir ? group.steps : [...group.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }));
  const departure = platformDepartureFrontiers(g, ordered, line.owner, rule, length);
  const returning = findRailRoute(g, [...departure.forward, ...departure.reverse], onward, line.owner, -1, 60000, false, rule, true, { length, onward: first });
  if (!returning) return null;
  const secondEnd = returning.conts[returning.conts.length - 1];
  const secondGroup = g.stations.railTrackGroups(g.stations.get(onward)!).find(q => q.steps.some(s => s.edge === secondEnd.edge.id));
  if (!secondGroup) return null;
  const secondArrival = secondGroup.steps.find(s => s.edge === secondEnd.edge.id)!;
  const secondOrdered = secondArrival.dir === secondEnd.dir ? secondGroup.steps : [...secondGroup.steps].reverse().map(s => ({ edge: s.edge, dir: -s.dir }));
  const secondDeparture = platformDepartureFrontiers(g, secondOrdered, line.owner, rule, length);
  const home = findRailRoute(g, [...secondDeparture.forward, ...secondDeparture.reverse], first, line.owner, -1, 60000, false, rule, true, { length, onward });
  if (!home) return null;
  const edges = new Set([...lineTrack(g, line.id), stub.id, ...path.conts.map(c => c.edge.id), ...returning.conts.map(c => c.edge.id), ...home.conts.map(c => c.edge.id)]);
  if ([...edges].some(id => g.vehicles.isEdgeBusy(id) || g.vehicles.getRes(id) !== 0)
    || [...g.world.net.crossings.values()].some(c => (edges.has(c.e1) || edges.has(c.e2)) && g.vehicles.crossingReservedBy(c.id) !== 0)) return null;
  const through = new Set(g.stations.all().flatMap(s => s.rail?.throughEdges ?? []));
  const chains = chainsOf(g, edges, e => e.station >= 0 || e.depot >= 0 || through.has(e.id));
  // A split of a circular two-way chain can create new twin-loop exits outside the local role bound.
  if (chains.some(c => c.start === c.end)) return null;
  const plan = autoSignalLine(g, [...edges], line.owner, { preview: true });
  if (plan.warnings.some(w => w === 'Opposing one-way signals: track unchanged')) return null;
  return { edges, cost: plan.cost, plan };
}
