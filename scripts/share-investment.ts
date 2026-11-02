// Native shared-entry pricing, durable selection and paid depot/purchase continuation.
// Starting balances are supported New Game overrides, fully recorded as initial loans.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { Train, consistRule } from '../src/game/train';
import { platformChoices, platformChoicesForStock } from '../src/game/rail-platforms';
import { toggleSignal } from '../src/game/build-ops';
import { atomicTerminalCell } from '../src/game/rail-capacity-cells';
import type { Station } from '../src/game/stations';
import { outAndBack } from '../src/game/lines';
import { stationEnds, nodeSnap, removeEdges } from '../src/game/routing';
import { finishDoubleTrack } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { planEdge, commitProposal } from '../src/game/construction';
import { outerEnd, planTerminusYard, buildTerminusYard } from '../src/game/ai-grow';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { newTown, district, M } from './linegrow-fixtures';
import { checkReservations } from './lib';
import { newShareOptionsCursor, resumeShareOptions, sharedBidLine,
  railInvestmentScore, shareAnchors, sharedServiceEligible, type ShareOption } from '../src/game/ai-share-options';
import { marginalTrainInvestment, sharedTrainAllowed } from '../src/game/ai-capacity';
import { addPattern, setVehiclePattern, patternStops } from '../src/game/patterns';
import { planNativeStationOnTrack, commitNativeStationOnTrack } from '../src/game/station-on-track';
import { buildSideDepot } from '../src/game/depot-sites';

let checks = 0;
function check(value: unknown, label: string): asserts value { assert(value, label); checks++; }
const save = (g: Game) => JSON.stringify(serialize(g));
const cold = (g: Game) => deserialize(JSON.parse(save(g)));
const ledger = (g: Game) => JSON.stringify({ economy: g.company(2).economy.toJSON(),
  vehicles: [...g.vehicles.map.keys()], edges: [...g.world.net.edges.keys()], depots: [...g.depots.map.keys()] });
/** Native compact mainline platforms; no fixture can change their geometry after quoting. */
function corridor(g: Game, buyerStation = true, trackOwner = 1, lead = 1) {
  const net = g.world.net, sts: Station[] = [];
  for (const [i, x] of [150, 330].entries()) {
    const owner = buyerStation && i === 1 ? 2 : lead;
    const id = g.stations.nextId, p = g.stations.planRail(x, 256, Math.PI / 2, 10, 2, owner,
      { trackType: 'standard', level: 'ground', style: 'none' });
    check(p.ok && !g.stations.commitRail(p, owner), 'native compact mainline platform is fully paid');
    sts.push(g.stations.get(id)!);
  }
  const first = net.nextEdge;
  const from = stationEnds(g, sts[0]).map(e => e.front), to = stationEnds(g, sts[1]).map(e => e.back);
  if (trackOwner === lead) {
    const p = planEdge(g, nodeSnap(g, from[0], 'rail'), nodeSnap(g, to[0], 'rail'),
      { kind: 'rail', type: 'standard', tracks: 2, heightOffset: 0, crossing: 'level', owner: lead });
    check(p.ok && !commitProposal(g, p), 'native double corridor is fully paid');
  } else for (let lane = 0; lane < 2; lane++) {
    let at = from[lane];
    for (const [x, owner] of [[210, lead], [270, trackOwner], [330, lead]]) {
      const n = net.nodes.get(at)!, end = x === 330 ? nodeSnap(g, to[lane], 'rail')
        : { kind: 'free' as const, x, z: n.z, y: 4 };
      const p = planEdge(g, nodeSnap(g, at, 'rail'), end,
        { kind: 'rail', type: 'standard', tracks: 1, heightOffset: 0, crossing: 'level', owner });
      check(p.ok && !commitProposal(g, p), 'native interior track is fully paid by its actual owner');
      const last = p.tracks.at(-1)!.bez;
      at = net.nearestNode(last.x3, last.z3, .1, 'rail')!.id;
    }
  }
  const doubles = [...net.edges.values()].filter(e => e.id >= first && e.kind === 'rail').map(e => e.id);
  const yard = planTerminusYard(g, lead, sts[0], outerEnd(sts[0], sts[1]), null, () => true);
  check(yard, 'native lead-operator yard has a legal site');
  const depot = buildTerminusYard(g, lead, yard, () => true); check(depot >= 0, 'native lead yard is fully paid');
  if (trackOwner === lead) finishDoubleTrack(g, doubles, lead);
  const line = g.lines.create('rail', lead); line.stops = outAndBack(sts.map(s => s.id)); g.lines.rebuild();
  if (trackOwner === lead) autoSignalLine(g, line.id, lead);
  for (let i = 0; i < (lead === 0 ? 1 : 2); i++) check(g.vehicles.buyTrain(depot, [M('diesel_b'), M('coach_ic'), M('coach_ic')], line.id) instanceof Train,
    'lead operator pays for actual native stock');
  (g.aiOf(lead) as any)?.adoptLines();
  g.lines.setPartnerPolicy(line.id, 'open');
  return { line, sts, depot };
}
function fixture(pop = 6000, buyerStation = true, trackOwner = 1, lead = 1) {
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1985, ...(lead === 0 ? { startMoney: 25_000_000 } : {}),
    aiConfigs: [{ startMoney: 25_000_000, accessPolicy: 'open', accessMultiplier: .1 }, { startMoney: 5_000_000, accessPolicy: 'open',
      focus: { rail: 1, road: 0, tram: 0 } }, ...(trackOwner === 3 ? [{ startMoney: 5_000_000, accessPolicy: 'open' as const, accessMultiplier: 0 }] : [])] });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiEnabled = false; g.aiAcquisitions = false;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  if (lead === 0) { g.setAccessPolicy(0, 'open'); g.setAccessMultiplier(0, .1); }
  const a = newTown(g, 'West town', 150, 256), b = newTown(g, 'East town', 330, 256);
  district(g, a, 110, 190, 256, 64, 0); district(g, b, 290, 370, 256, 64, 0);
  const route = corridor(g, buyerStation, trackOwner, lead);
  // Real street-front apartment lots at the native forecourts, as in fleet-investment.
  for (const [i, st] of route.sts.entries()) {
    const town = [a, b][i], fc = g.stations.forecourt(st)!, near = g.world.net.nearestEdge(fc.x, fc.z, 3, 'road')!;
    const point = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(near.edge, near.s, point);
    for (const dx of [-.8, 0, .8]) for (const dz of [1.1, 1.9, 2.7]) {
      const residents = Math.floor(pop / 9), building = g.world.addBuilding({ townId: town.id,
        x: point.x + dx, z: point.z + dz, angle: 0, w: .6, d: .6, type: 4, floors: 8,
        pop: residents, seed: 10000 + town.buildings.size, y: 4, built: 0 });
      town.buildings.add(building.id); town.pop += residents;
    }
  }
  g.stations.recomputeCatchment(); g.demand.rebuild();
  while (g.day < 1) g.stepTick();
  return { g, ...route };
}
function options(g: Game) {
  const ai = g.aiOf(2)! as any, c = newShareOptionsCursor(g), out: ShareOption[] = [];
  let units = 0;
  while (c.at < c.lines.length) {
    const it = resumeShareOptions(ai.sharedServiceHost(), c); let q;
    do { q = it.next(); check(++units < 500, 'bounded shared candidate survey'); } while (!q.done);
    out.push(...q.value);
  }
  return out;
}
const f = fixture(), { g, line } = f, ai = g.aiOf(2)!;
check(g.company(2).economy.initialLoan === 5_000_000 && g.company(1).economy.initialLoan === 25_000_000,
  'fixture starting overrides are real repayable native loans');
check(!g.vehicles.trains().some(t => t.owner === 2), 'new entrant has no existing native matching stock');
const bids = options(g), positive = bids.find(o => o.shareBid.line === line.id);
check(positive, 'native discovery exposes the paying foreign-service candidate before old room rejection');
const bid = positive.shareBid;
check(!!bid && Number.isFinite(bid.score) && bid.score > 0, 'native discovery exposes a complete paying foreign-service bid');
check(f.sts.every(s => s.catchPop > 0) && line.capacity?.demand, 'native walking catchments and saved monthly demand price the bid');
check(Math.min(...f.sts.map(s => s.rail!.tracks - line.vehicles.length)) === 0,
  'old endpoint-track-minus-roster filter would discard this paying native candidate');
check(bid.depot.kind === 'planned' && bid.works === bid.depot.cost && bid.upkeep === bid.depot.upkeep
  && bid.capital === bid.stock + bid.works && bid.capital <= ai.available(), 'real prospective native depot and full capital fit ordinary funds');
console.log('native complete share bid', { stock: bid.stock, works: bid.works, upkeep: bid.upkeep, capital: bid.capital,
  private: bid.net, pool: bid.poolNet, score: bid.score });
const missing = bid.stock * (bid.rate - .03) + bid.upkeep + bid.works * (bid.rate + bid.amortisation);
check(bid.net === bid.native.investor - missing && bid.poolNet === bid.native.pooled - missing
  && bid.net > 0 && bid.poolNet > 0, 'native private/pool surplus pays only missing civil and finance charges once');
check(bid.score === railInvestmentScore(bid.net, bid.capital, ai.config.risk) * ai.config.focus.rail ** 2,
  'shared bid uses the literal ordinary-rail ranking scale');
const quoted = save(g), fork = cold(g);
check(JSON.stringify(options(fork)) === JSON.stringify(bids) && save(fork) === quoted && save(g) === quoted,
  'complete warm and cold quotes are identical pure reads after native monthly observation');
check(JSON.stringify(options(g)) === JSON.stringify(bids) && save(g) === quoted, 'repeated complete quote preserves every saved field');

for (const risk of [0, .15, .5, .85, 1]) for (const [net, capital] of [[Number.EPSILON, 1], [125000, 1700000], [2e6, 50e6]]) {
  const a = .045 - .03 * risk, years = 1 / (.03 + a);
  const literalOld = (Math.sqrt(Math.max(0, net / Math.max(1, capital))) + .15) * years / 9;
  check(railInvestmentScore(net, capital, risk) === literalOld, 'shared ranking preserves the literal old ordinary-rail arithmetic');
}

const stock = bid.cars.map(id => MODEL_BY_ID.get(id)!), extraLong = [...stock, M('coach_ic'), M('coach_ic')];
const nativeOptions = JSON.stringify(platformChoices(g, line, bid.pattern, 0));
const fitted = platformChoicesForStock(g, line, bid.pattern, 0,
  { owner: 2, length: stock.reduce((n, m) => n + m.length + .1, 0), rule: consistRule(stock) });
check(fitted.length > 0 && platformChoicesForStock(g, line, bid.pattern, 0,
  { owner: 2, length: extraLong.reduce((n, m) => n + m.length + .1, 0), rule: consistRule(extraLong) }).length === 0,
  'explicit proposed consist must physically fit its complete native arriving/onward platform');
fitted[0].witnessEdges.length = 0; fitted[0].witnessAccess.length = 0; fitted[0].steps[0].edge = -1;
check(JSON.stringify(platformChoices(g, line, bid.pattern, 0)) === nativeOptions && save(g) === quoted,
  'explicit proposed-stock output cannot mutate native default platform options or the full save');

const denied = cold(g); denied.blockCompany(1, 2);
check(options(denied).length === 0, 'foreign access denial removes the candidate');
const closed = cold(g); closed.lines.setPartnerPolicy(line.id, 'closed');
check(options(closed).length === 0, 'closed line does not grant an invitation');
const poor = cold(g), poorEco = poor.company(2).economy;
while (poorEco.borrow()) { /* ordinary credit is exhausted by already committed expenditure */ }
check(poorEco.spend(poorEco.money, 'construction'), 'native cash expenditure creates unaffordable reserve');
check(options(poor).length === 0, 'ordinary funds reject capital that cannot be committed');
const ancient = cold(g); ancient.options.startYear = 1800;
check(options(ancient).length === 0, 'no available catalog stock means no shared bid');
const full = cold(g), fullLine = full.lines.get(line.id)!;
for (const n of [...full.world.net.nodes.values()]) if (n.kind === 'rail') while (n.signal)
  check(!toggleSignal(full, n.x, n.z, n.owner), 'native signal edit makes a genuine closed terminal cell');
check(atomicTerminalCell(full, fullLine.stops, 2, bid.cars.map(id => MODEL_BY_ID.get(id)!))?.slots.length === 4,
  'closed-corridor control has exactly four full-length native platform slots');
check(full.vehicles.buyTrain(f.depot, (full.vehicles.get(fullLine.vehicles[0]) as Train).madeUp, line.id) instanceof Train,
  'full-corridor control really pays for its additional native stock');
check(!sharedTrainAllowed(full, fullLine, 2, bid.cars.map(id => MODEL_BY_ID.get(id)!)) && options(full).length === 0,
  'full native terminal cells and unchanged line-capacity admission reject another entrant');
const quiet = fixture(0);
check(options(quiet.g).length === 0, 'empty native catchment cannot pay a shared train or depot');
const loser = fixture(6000, false);
const privateLoss = marginalTrainInvestment(loser.g, loser.line, 2, bid.cars.map(id => MODEL_BY_ID.get(id)!));
check(privateLoss.pooled > 0 && privateLoss.investor < 0 && options(loser.g).length === 0,
  'native pooled gain cannot purchase a loss-making private entrant with no walking/traffic bid');
const changed = cold(g); changed.lines.get(line.id)!.stops.reverse(); changed.lines.rebuild();
check(!sharedBidLine(changed, bid), 'redirected saved itinerary cannot reuse the old physical bid');
const damaged = cold(g), witness = bid.witness!.edges.find(([id]) => damaged.world.net.edges.get(id)?.station === -1)!;
damaged.world.net.removeEdge(witness[0]); damaged.onNetworkChanged();
check(!sharedBidLine(damaged, bid), 'actual native route removal invalidates the retained chosen-path witness');

// Replay the real selector's saved stages, not a parallel test-only option list.
const selection = cold(g), h = selection.aiOf(2)! as any;
const chooser = h.chooseProject(); let step = chooser.next(), cursorChecks = 0, sharedPublished = false, legacy: Game | undefined;
while (!step.done) {
  if (h.selection?.stage === 'sharing' && !legacy) legacy = cold(selection);
  if (h.selection?.stage === 'alternatives' || h.selection?.stage === 'sharing' || h.selection?.stage === 'surfaceAlternatives') {
    const twin = cold(selection), th = twin.aiOf(2)! as any, before = save(selection);
    check(save(twin) === before, 'native selector phase round-trips before next unit');
    step = chooser.next(); th.job.next();
    check(save(selection) === save(twin), 'native selector next unit/option publication is exactly cold-replayable');
    const published = h.selection?.opts.filter((o: any) => o.kind === 'share') ?? [];
    check(published.length <= 1, 'resumed shared survey cannot append duplicate bids');
    sharedPublished ||= published.length === 1; cursorChecks++;
  } else step = chooser.next();
  check(cursorChecks < 150, 'native selector cursor terminates');
}
check(sharedPublished && cursorChecks >= 5, 'actual selector values and publishes a native shared bid across saved work units');
console.log('selector choice', h.project?.kind, 'cursor comparisons', cursorChecks);
check(h.project?.kind === 'share', 'unrestricted native economic chooser actually selects the paying shared corridor');
check(legacy, 'native pre-sharing options/context checkpoint exists for legacy DTO setup');
const legacyNext = cold(legacy), lh = legacyNext.aiOf(2)! as any;
// A previous-version cursor after alternatives already contains all its old candidates. It must
// resume its saved next stage, without appending current sharing/coaches or repeating corridor preference.
lh.selection.stage = 'growth'; const lateTwin = cold(legacyNext), lt = lateTwin.aiOf(2)! as any;
let legacyUnits = 0;
while (lh.selection) {
  lh.job.next(); lt.job.next();
  check(save(legacyNext) === save(lateTwin), 'old later-stage selector resumes with exactly its original options');
  check(!lh.selection?.sharing && !lh.selection?.opts.some((o: any) => o.shareBid), 'old later-stage cursor does not append new sharing bids');
  check(++legacyUnits < 200, 'legacy selector terminates');
}

// A separately paid reusable native yard adds no new civil cost and must survive cancellation.
const reuse = cold(g), d = bid.depot;
check(d.kind === 'planned', 'reusable-yard setup starts with a real prospective site');
const reuseId = buildSideDepot(reuse, d.edge, d.s, 2, { dir: d.dir, side: d.side });
check(reuseId >= 0, 'buyer really pays native siding and depot before reusing it');
const reuseBid = options(reuse).find(o => o.shareBid.depot.kind === 'existing')?.shareBid;
check(reuseBid && reuseBid.works === 0 && reuseBid.upkeep === 0 && reuseBid.capital === reuseBid.stock,
  'existing owned depot is routed natively without duplicated fixed cost');
const reuseAI = reuse.aiOf(2)! as any;
check(reuseAI.startShare(reuseBid.lead, reuseBid.stops[0], reuseBid.stops.at(-1)!, reuseBid.line, reuseBid), 'reuse job starts');
for (let i = 0; i < 50 && reuseAI.shareTask?.stage !== 'bidOpening'; i++) reuseAI.job.next();
check(reuseAI.shareTask?.stage === 'bidOpening', 'reuse job actually reaches saved depot opening');
const reusedAssets = ledger(reuse), reusePending = save(reuse), reuseTwin = cold(reuse);
reuseAI.cancelJob(); (reuseTwin.aiOf(2)! as any).cancelJob();
check(reuse.depots.get(reuseId)?.owner === 2 && ledger(reuse) === reusedAssets && save(reuse) === save(reuseTwin),
  'cancelling a saved reuse job preserves its pre-existing paid depot/cash/debt exactly');

// The physical opening is another saved boundary: a legal yard may be disconnected after
// its call was selected. Reject before buying/reselling a train and losing its purchase premium.
const entry = deserialize(JSON.parse(reusePending)), eh = entry.aiOf(2)! as any;
const oldProof = new Set<number>(eh.shareTask.proof.edges.map((p: [number, string]) => p[0]));
for (let i = 0; i < line.stops.length && eh.shareTask.stage === 'bidOpening'; i++) eh.job.next();
check(eh.shareTask.stage === 'purchase', 'actual reused depot opening is selected before purchase');
const openingEdge = eh.shareTask.proof.edges.map((p: [number, string]) => p[0]).find((id: number) => {
  const e = entry.world.net.edges.get(id); return !oldProof.has(id) && e?.owner === 2 && e.depot < 0 && e.station < 0;
});
check(openingEdge !== undefined, 'saved final proof includes the actual depot approach, beyond service-call geometry');
removeEdges(entry, [openingEdge], 2);
check(!entry.world.net.edges.has(openingEdge) && entry.depots.get(reuseId), 'native demolition cuts only an idle existing approach');
const entryLedger = ledger(entry), entryTwin = cold(entry);
for (let i = 0; i < 4; i++) { eh.work(0, entry.ticksPerDay); entryTwin.aiOf(2)!.work(0, entryTwin.ticksPerDay); }
check(!eh.busy && ledger(entry) === entryLedger && save(entry) === save(entryTwin),
  'changed final opening is rejected before any purchase/resale loss, preserving the existing yard and exact replay');

// All third-party running track is constructed and paid by that owner; no ownership field is forged.
const foreign = fixture(6000, true, 3), foreignBid = options(foreign.g)[0]?.shareBid;
check(foreignBid && foreignBid.witness!.access.some(([user, owner]) => user === 2 && owner === 3),
  'native chosen route records entrant access to the third-party interior corridor');
const fa = foreign.g.aiOf(2)! as any;
check(fa.startShare(foreignBid.lead, foreignBid.stops[0], foreignBid.stops.at(-1)!, foreignBid.line, foreignBid), 'third-party bid starts natively');
for (let i = 0; i < 50 && fa.shareTask?.stage !== 'bidFund'; i++) fa.job.next();
check(fa.shareTask?.stage === 'bidFund', 'access control reaches final physical proof before funding');
foreign.g.blockCompany(3, 2); const foreignBefore = ledger(foreign.g), foreignTwin = cold(foreign.g);
for (let i = 0; i < 4; i++) { fa.work(0, foreign.g.ticksPerDay); foreignTwin.aiOf(2)!.work(0, foreignTwin.ticksPerDay); }
check(!fa.busy && ledger(foreign.g) === foreignBefore && save(foreign.g) === save(foreignTwin),
  'third-party access revoked after full proof atomically rejects before debt/works/purchase with exact replay');


const unfunded = cold(g), uh = unfunded.aiOf(2)! as any;
check(uh.startShare(bid.lead, bid.stops[0], bid.stops.at(-1)!, bid.line, bid), 'post-works cash control starts its native bid');
for (let i = 0; i < 50 && !(uh.shareTask?.works > 0); i++) uh.job.next();
check(uh.shareTask?.stage === 'bidProof' && uh.shareTask.works > 0, 'real depot works are paid before stock is purchased');
const builtDepot = uh.shareTask.depot, paidWorks = uh.shareTask.works, emptyEco = unfunded.company(2).economy;
while (emptyEco.borrow()) { /* native unrelated commitments exhaust remaining credit */ }
check(emptyEco.spend(emptyEco.money, 'construction'), 'unrelated paid commitments consume remaining stock funds');
const emptyWorth = emptyEco.netWorth, emptyTwin = cold(unfunded), oldVehicles = unfunded.vehicles.map.size;
for (let i = 0; i < 4; i++) { uh.work(0, unfunded.ticksPerDay); emptyTwin.aiOf(2)!.work(0, emptyTwin.ticksPerDay); }
check(!uh.busy && !unfunded.depots.get(builtDepot) && unfunded.vehicles.map.size === oldVehicles,
  'post-works funding recheck buys no train and removes only the new failed depot');
check(emptyEco.netWorth === emptyWorth + paidWorks && save(unfunded) === save(emptyTwin),
  'native rollback refunds exact paid works/removal while preserving unrelated debt/expenditure and replay');
check(platformChoices(unfunded, unfunded.lines.get(line.id)!, bid.pattern, 0).length > 0
  && platformChoices(unfunded, unfunded.lines.get(line.id)!, bid.pattern, 1).length > 0,
  'failed shared works preserve the foreign operating railway and full-fit calls');

// A human can explicitly open both network access and line membership. The chooser must not
// assume an AI lead: the unchanged native marginal auction protects the human's existing traffic.
const human = fixture(6000, true, 0, 0);
check(sharedServiceEligible((human.g.aiOf(2)! as any).sharedServiceHost(), human.line)
  && options(human.g).length === 0, 'open human lead remains eligible while its unchanged frozen-human capacity limit still applies');
// The native shared auction may grow an existing AI channel. Add one genuinely paid partner,
// rather than overriding the human-only capacity limit to manufacture admission for the buyer.
const humanSite = bid.depot;
check(humanSite.kind === 'planned', 'human partner setup uses the already proven native siding location');
check(!human.g.lines.join(human.line.id, 1), 'existing AI partner legally joins the explicitly open player line');
const humanDepot = buildSideDepot(human.g, humanSite.edge, humanSite.s, 1,
  { dir: humanSite.dir, side: humanSite.side });
check(humanDepot >= 0, 'existing AI partner really pays for its own legal native depot');
check(human.g.vehicles.buyTrain(humanDepot, [M('diesel_b'), M('coach_ic'), M('coach_ic')], human.line.id) instanceof Train,
  'existing AI partner really pays for its own stock on the player line');
const humanBid = options(human.g)[0]?.shareBid;
check(human.g.company(0).ai === false && human.g.company(0).economy.initialLoan === 25_000_000,
  'human lead owns genuinely paid infrastructure from the uniform native starting-loan override');
check(humanBid?.lead === 0 && humanBid.net > 0 && humanBid.poolNet > 0,
  'player-owned explicitly open line retains a complete positive native private/pool bid');
const humanQuoted = save(human.g);
check(JSON.stringify(options(cold(human.g))) === JSON.stringify(options(human.g)) && save(human.g) === humanQuoted,
  'player-lead native bid is pure and exactly cold-repeatable');

const foldedAnchor = shareAnchors(g, { ...line, stops: [f.sts[0].id, f.sts[1].id, f.sts[0].id] });
check(foldedAnchor?.a.id === f.sts[0].id && foldedAnchor.b.id === f.sts[1].id,
  'pure anchor selection preserves first plus farthest even when the last stored stop returns to the first');

// Explicit two-call rings and folded native stopping lists keep their actual whole-call proofs.
for (const shape of ['loop', 'folded'] as const) {
  const world = cold(g), l = world.lines.get(line.id)!;
  if (shape === 'loop') l.loop = true;
  else { l.loop = false; l.stops = [f.sts[0].id, f.sts[1].id, f.sts[0].id, f.sts[1].id]; }
  world.lines.rebuild();
  const anchor = shareAnchors(world, l)!, result = options(world)[0]?.shareBid;
  check(anchor.a.id === f.sts[0].id && anchor.b.id === f.sts[1].id && anchor.span === 180,
    `${shape}: first plus strictly-farthest anchors retain old stored-call tie ordering`);
  check(result && result.stops.join() === l.stops.join() && result.pattern === (l.patterns?.[0]?.id ?? 0),
    `${shape}: full actual route is natively priced without a linear-route category ban`);
  check(patternStops(l, result.pattern).every(index => platformChoicesForStock(world, l, result.pattern, index,
    { owner: 2, length: stock.reduce((n, m) => n + m.length + .1, 0), rule: consistRule(stock) }).length > 0),
    `${shape}: every advertised actual served occurrence has native full-fit arrival and onward paths`);
  const quotedShape = save(world);
  check(JSON.stringify(options(cold(world))) === JSON.stringify(options(world)) && save(world) === quotedShape,
    `${shape}: complete native bids are pure with cold route caches`);
}

// A native intermediate platform creates a real express/short-turn service, rather than a
// fabricated route/capacity. The tiny skipped platform must not undersize the express's stock.
const express = cold(g), etown = newTown(express, 'Intermediate town', 220, 256);
district(express, etown, 208, 232, 256, 32, 0);
const running = express.world.net.nearestEdge(220, 256, 2, 'rail', e => e.station < 0 && e.depot < 0)!;
const middlePlan = planNativeStationOnTrack(express, running.edge.id, running.s,
  { reuseTrack: true, length: 4, tracks: 2, mode: 'mainline', style: 'none' }, 1);
check(middlePlan.ok, 'real intermediate platforms have a native legal placement');
const middle = commitNativeStationOnTrack(express, middlePlan);
check(!middle.error && middle.station >= 0, 'real intermediate platforms are fully paid on unchanged running rail');
const el = express.lines.get(line.id)!; el.stops = outAndBack([f.sts[0].id, middle.station, f.sts[1].id]);
const ep = addPattern(express, el.id, 'express', el.stops.map(id => id !== middle.station), 'Express')!;
el.patterns = [ep, ...el.patterns!.filter(p => p.id !== ep.id)];
for (const id of el.vehicles) check(!setVehiclePattern(express, id, ep.id), 'native incumbents use the real first express service');
express.lines.rebuild();
const expressBid = options(express)[0]?.shareBid;
check(expressBid?.pattern === ep.id && expressBid.stops.length === el.stops.length && patternStops(el, ep.id).length === 2,
  'valid partial first express retains exact native pricing and actual served-call proof');
check(expressBid.cars.join() === bid.cars.join(), 'skipped tiny platform cannot undersize a native express consist');
check(shareAnchors(express, el)!.b.id === f.sts[1].id, 'express advertised anchor is actually served');
const expressQuoted = save(express);
check(JSON.stringify(options(cold(express))) === JSON.stringify(options(express)) && save(express) === expressQuoted,
  'first-pattern express quote and exact native pattern identity are pure across cold save continuation');
const skipFirst = addPattern(express, el.id, 'local', el.stops.map(id => id !== f.sts[0].id), 'Inner short turn')!;
el.patterns = [skipFirst, ...el.patterns!.filter(p => p.id !== skipFirst.id)];
const shortAnchors = shareAnchors(express, el)!;
check(shortAnchors.a.id === middle.station && shortAnchors.b.id === f.sts[1].id
  && shortAnchors.a.townId === etown.id, 'skipped terminus cannot remain the short-turn advertised town/span/depot anchor');
// This four-unit platform cannot receive the catalog express consist: native fit remains the veto.
check(options(express).length === 0, 'invalid served short-turn platform receives no candidate despite preserved category eligibility');

if (!process.argv.includes('--quotes-only')) {
  for (const [label, source, selected] of [['AI lead', g, bid], ['human lead', human.g, humanBid]] as const) {
    const paid = cold(source), buyer = paid.aiOf(2)!;
    const bid = selected!;
    check(buyer.startShare(bid.lead, bid.stops[0], bid.stops.at(-1)!, bid.line, bid), 'native job accepts its exact complete bid');
    paid.aiEnabled = true;
    let twin = cold(paid), added: Train | undefined, purchased = -1, stages = new Set<string>(), exactDays = 0;
    const first = paid.vehicles.nextId, startWorth = paid.company(2).economy.netWorth;
    let totalFare = 0; const calls = new Set<number>(), income = paid.onIncome, stop = paid.recordStop;
    paid.onIncome = function(amount, v, st) { const result = income.call(this, amount, v, st);
      if (v.id >= first && v.owner === 2 && v.lineId === bid.line) totalFare += amount; return result; };
    paid.recordStop = function(v, st) { const result = stop.call(this, v, st);
      if (v.id >= first && v.owner === 2 && v.lineId === bid.line) calls.add(st.id); return result; };
    for (let i = 0; i < paid.ticksPerDay * 600; i++) {
      paid.stepTick(); twin.stepTick();
      const current = (paid.aiOf(2)! as any).shareTask?.stage;
      if (current && !stages.has(current)) {
        check(save(paid) === save(twin), `paid ${current} native continuation is exactly cold-replayable`);
        stages.add(current); twin = cold(twin);
      }
      if (!added) { const v = paid.vehicles.get(first); if (v instanceof Train && v.owner === 2) { added = v; purchased = paid.day; } }
      if (paid.tick % paid.ticksPerDay === 0) {
        check(save(paid) === save(twin), 'every paid native day matches its unobserved cold twin'); exactDays++;
        if (added?.delivered && calls.size >= 2 && paid.day >= purchased + 60) break;
      }
    }
    check(added instanceof Train && added.madeUp.map(m => m.id).join() === bid.cars.join(), 'actual purchase is the exact quoted native consist');
    check(stages.has('bidBuild') && stages.has('bidProof') && stages.has('bidOpening'), 'native job persists civil, full-fit and depot-entry work');
    check(added.onMap && added.delivered > 0 && totalFare > 0 && calls.size === 2, 'paid shared service actually calls, delivers and earns both-end fares');
    check(paid.access.some(a => a.owner === bid.lead && a.user === 2 && a.paidTotal > 0), 'new operator pays real foreign access charges');
    check(paid.company(2).economy.netWorth < startWorth && !checkReservations(paid).length,
      'full native capital/operating cash and valid physical reservations remain charged');
    console.log('paid shared service', label, { days: exactDays, delivered: added.delivered, fares: totalFare, stages: [...stages] });
  }

  // Revocation after a saved bid cannot turn that bid into a permission or a speculative asset.
  const revoked = cold(g), ra = revoked.aiOf(2)!;
  check(ra.startShare(bid.lead, bid.stops[0], bid.stops.at(-1)!, bid.line, bid), 'revocation control starts a native saved bid');
  revoked.blockCompany(1, 2); const before = ledger(revoked); revoked.aiEnabled = true;
  for (let i = 0; i < 4; i++) ra.work(0, revoked.ticksPerDay);
  check(!ra.busy, 'revoked bid actually completes its failed native job');
  check(ledger(revoked) === before, 'revoked native bid spends no cash, debt or assets');
}
console.log(`${checks} native shared investment checks`);
console.log('ALL CHECKS PASSED');
