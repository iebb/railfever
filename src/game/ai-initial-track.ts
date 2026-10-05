// Initial capacity is an investment: compare saved fares and avoided live works with the extra rail's upkeep.
import type { Game } from './game';
import type { Proposal } from './construction';
import { doubleTrackCompletionReserve, quoteDoubleTrackCompletion, type DoublePlan } from './trackops';
import type { Economy } from './economy';
import { SHARED_TRACK, structureFactor } from './construction';
import { TRACK_TYPES, UNIT_M, ELECTRIFY, WATER_Y } from './constants';
import { trackBasePerUnit } from './opcosts';
import { planCapacityTrackUpgrade, commitCapacityTrackUpgrade } from './ai-capacity-works';

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
