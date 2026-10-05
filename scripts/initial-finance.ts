// Native optional-capacity financing and full construction quotes; bundle as initial-finance.mjs.
import { Game } from '../src/game/game';
import { Economy } from '../src/game/economy';
import { initialTrackChoice, initialTrackFinancing, layInitialDoubleTrack, type InitialTrackTraffic } from '../src/game/ai-initial-track';
import { commitCapacityTrackUpgrade } from '../src/game/ai-capacity-works';
import { fundInitialConnector } from '../src/game/ai-network';
import { planDoubleTrack, commitDoubleTrack, quoteDoubleTrackCompletion, planConnection, commitConnection } from '../src/game/trackops';
import { buildDepotOnLine } from '../src/game/routing';
import { routeBetween } from '../src/game/ai-network';
import { lineIsDouble } from '../src/game/dualtrack';
import { autoSignalLine, SIGNAL_COST } from '../src/game/signals';
import { upgradeRoute } from '../src/game/dualtrack';
import { serialize, deserialize } from '../src/game/save';
import { setSignal } from '../src/game/signals';
import { station, endNode, nodeSnap, railOpts, build, check, fails, depotFor, loco } from './stationlib';
import { free, roadOpts } from './lib';

if (!process.argv[1]?.endsWith('initial-finance.mjs')) throw new Error('bundle as initial-finance.mjs');
const traffic: InitialTrackTraffic = { revenue: 6_000_000, boardings: 120_000, seats: 100_000, trains: 4,
  headway: 180, kmh: 70, blockLength: 280, risk: 0.6 };
const eq = (a: number, b: number) => Math.abs(a - b) < 1e-6;

function fixture(level: 'ground' | 'elevated' | 'underground' = 'ground', curved = false, platforms = 2, shared = false, grade = false) {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: shared ? 2 : 1 });
  g.aiEnabled = false; g.world.h.fill(3); g.world.heightsVersion++;
  g.company(1).economy.money = 100_000_000;
  const A = station(g, 30, 190, Math.PI / 2, 12, platforms, 1, { level })!;
  const B = station(g, 350, curved ? 220 : 190, Math.PI / 2, 12, platforms, 1, { level, ...(grade ? { fixedY: 3.8 } : {}) })!;
  const built = build(g, nodeSnap(g, endNode(g, A, 1, true), 'rail'), nodeSnap(g, endNode(g, B, 1, false), 'rail'),
    railOpts(1, 1, { level }), 'finance fixture formation');
  check(!!built, `${level}/${curved}/${platforms}: native formation builds`);
  const l = g.lines.create('rail', 1); l.stops = [A.id, B.id]; g.stations.refreshAccess(true); g.lines.rebuild();
  if (shared) {
    for (const id of upgradeRoute(g, A.id, B.id, 1)) g.world.net.edges.get(id)!.owner = 2;
    g.setAccessPolicy(2, 'auto-approve'); g.requestAccess(1, 2);
  }
  return { g, A, B, l };
}

function funding(e: Economy, spend: number) {
  while (e.money < spend + 300_000 && e.borrow()) { /* the native AI funding rule */ }
  return e.money >= spend;
}

console.log('Opening fleet and incremental native debt');
const one = { ...traffic, trains: 1, headway: 720, seats: 20_000, boardings: 120_000 };
const single = initialTrackChoice(one, 1_000_000, 30_000);
check(single.recovered === 0 && !single.double && single.avoidedUpgrade > 0,
  'one purchased train cannot recover present opposing delays; future shortfall remains priced separately');
check(initialTrackChoice({ ...one, junctionTraffic: 0.006 }, 1_000_000, 30_000).double,
  'one purchased train can still repay capacity against genuine existing junction traffic');

for (const [money, loan, maxLoan, base, extra] of [
  [10_000_000, 5_000_000, 25_000_000, 3_000_000, 1_000_000],
  [350_000, 5_000_000, 25_000_000, 2_300_000, 750_000],
  [1_300_000, 5_000_000, 25_000_000, 1_000_000, 1],
  [350_000, 24_500_000, 25_000_000, 0, 700_000],
  [350_000, 24_750_000, 25_000_000, 0, 700_000],
]) {
  const e = Object.assign(new Economy(), { money, loan, maxLoan });
  const before = JSON.stringify(e), quote = initialTrackFinancing(e, base, extra);
  const baseline = Economy.fromJSON(JSON.parse(before)), paired = Economy.fromJSON(JSON.parse(before));
  funding(baseline, base); funding(paired, base + extra);
  check(eq(quote.incrementalLoan, paired.loan - baseline.loan) && quote.affordable === (paired.money >= base + extra),
    `native step/cap/base funding matches quote at ${money}/${loan}/${base}/${extra}`);
  baseline.endMonth(1990, 1); paired.endMonth(1990, 1);
  check(eq(quote.annualInterest / 12, baseline.months[0].v.interest - paired.months[0].v.interest),
    'incremental quote interest agrees with the native monthly debt ledger');
  check(JSON.stringify(e) === before, 'borrowing quote leaves cash, loan and books unchanged');
}

console.log('Native geometry quotes and paid finishing');
let maximumQuoteMs = 0;
for (const [level, curved, platforms, shared, signals, grade, reused] of [
  ['ground', false, 2, false, false, false, false], ['ground', true, 2, false, true, false, false],
  ['elevated', false, 2, false, false, false, false], ['underground', true, 2, false, false, false, false],
  ['ground', true, 4, true, true, false, false], ['ground', true, 2, false, false, true, false],
  ['ground', false, 2, false, false, false, true], ['elevated', false, 2, false, false, false, true],
] as const) {
  const f = fixture(level, curved, platforms, shared, grade), { g } = f;
  if (reused) {
    const route = upgradeRoute(g, f.A.id, f.B.id, 1);
    const loop = ([1, -1] as const).map(side => planDoubleTrack(g, route, side, 1, false)).find(p => p.ok)!;
    const built = commitDoubleTrack(g, loop);
    check(!built.error && !built.finishError && built.edges.length > 0, 'native earlier loop supplies reused companion track/signals');
  }
  if (signals) {
    const id = upgradeRoute(g, f.A.id, f.B.id, 1)[0], e = g.world.net.edges.get(id)!;
    check(!setSignal(g, id, e.len / 2, 'oneway', true, 1), 'native pre-existing signal builds');
  }
  const edges = upgradeRoute(g, f.A.id, f.B.id, 1);
  const plans = ([1, -1] as const).map(side => planDoubleTrack(g, edges, side, 1)).filter(p => p.ok && p.complete
    && p.start.kind !== 'turnout' && p.end.kind !== 'turnout').sort((a, b) => a.cost - b.cost || b.side - a.side);
  check(plans.length > 0, 'native complete pair fits the quoted geometry');
  if (!plans.length) continue;
  const state = JSON.stringify(serialize(g)), planState = JSON.stringify(plans[0]), version = g.world.net.version;
  const t0 = performance.now(), quote = quoteDoubleTrackCompletion(g, plans[0]);
  const ms = performance.now() - t0; maximumQuoteMs = Math.max(maximumQuoteMs, ms);
  check(state === JSON.stringify(serialize(g)) && version === g.world.net.version && planState === JSON.stringify(plans[0]),
    'complete native quote preserves world, network IDs/version, proposal, books, RNG and reservations');
  const quotes = plans.map(p => quoteDoubleTrackCompletion(g, p).cost);
  if (reused && level === 'ground') {
    const endpointOnly = plans.find(p => p.proposals.every(x => !x.crossings.length)
      && quoteDoubleTrackCompletion(g, p).endpointCrossings! > 0);
    check(!!endpointOnly, 'native endpoint lead diamonds are counted even when segment proposals contain no crossings');
  }
  if (reused && level === 'elevated') {
    // This existing native loop cannot join the platform: the uncapped native commit refuses the same
    // endpoint obstacle. Still verify that reused elevated rail is priced and a funded refusal refunds.
    const ground = fixture(), route = upgradeRoute(ground.g, ground.A.id, ground.B.id, 1);
    const loop = ([1, -1] as const).map(side => planDoubleTrack(ground.g, route, side, 1, false)).find(p => p.ok)!;
    commitDoubleTrack(ground.g, loop);
    const comparable = planDoubleTrack(ground.g, upgradeRoute(ground.g, ground.A.id, ground.B.id, 1), plans[0].side, 1);
    check(quote.cost > quoteDoubleTrackCompletion(ground.g, comparable).cost,
      'the completion reserve retains the native structure cost of reused elevated companion rail');
    const eco = g.company(1).economy, money = eco.money, construction = eco.current.construction;
    const result = commitCapacityTrackUpgrade(g, plans[0], undefined, quote.cost);
    check(result.error === 'End connection: other track in the way' && eco.money === money
      && eco.current.construction === construction,
      'the native reused elevated endpoint obstacle is refused and refunded within its funded ceiling');
    continue;
  }
  let funded = 0;
  const money = g.company(1).economy.money, construction = g.company(1).economy.current.construction;
  const upkeepBefore = [...g.world.net.edges.values()].filter(e => e.kind === 'rail').reduce((n, e) => n + g.edgeMaintenance(e), 0);
  const result = layInitialDoubleTrack(g, edges, 1, traffic, cost => { funded = cost; return true; });
  const paid = money - g.company(1).economy.money;
  if (reused) console.log(`  reused quote ${quote.cost}, raw ${plans[0].cost}, fund ${funded}, choices ${plans.map(p => p.side + ':' + p.cost).join('/')}`);
  check(result.built && eq(paid, result.cost) && eq(paid, construction - g.company(1).economy.current.construction),
    'native completed pair pays every crossover and signal in its construction ledger');
  check(result.built && paid <= funded && eq(funded, result.choice!.cost) && quotes.some(q => eq(q, funded)),
    'the full native paid cost fits the same complete geometry quote used for funding and valuation');
  const upkeepAfter = [...g.world.net.edges.values()].filter(e => e.kind === 'rail').reduce((n, e) => n + g.edgeMaintenance(e), 0);
  check(result.built && upkeepAfter - upkeepBefore <= result.choice!.upkeep,
    'complete native lead/crossover upkeep fits the same capacity valuation reserve');
  if (level === 'ground' && !curved && !reused) check(plans[0].cost + 80_000 < paid,
    'regression preimage: the former fixed £80k finish quote underfunds this native four-crossover pair');
  console.log(`  ${level}/${curved ? 'curve' : 'straight'}/${platforms}/${shared ? 'shared' : 'own'}: quote ${funded}, paid ${paid}, quote ${ms.toFixed(2)}ms`);
}

console.log('Native endpoint formation allowances');
function endpointAllowance(g: Game, edges: number[], label: string, preserve?: (p: ReturnType<typeof planDoubleTrack>) => boolean) {
  const plans = ([1, -1] as const).map(side => planDoubleTrack(g, edges, side, 1)).filter(p => p.ok && p.complete
    && p.start.kind !== 'turnout' && p.end.kind !== 'turnout' && (!preserve || preserve(p))).sort((a, b) => a.cost - b.cost || b.side - a.side);
  check(plans.length > 0, `${label}: native complete candidate fits`);
  if (!plans.length) return;
  const plan = plans[0], state = JSON.stringify(serialize(g)), proposal = JSON.stringify(plan), quote = quoteDoubleTrackCompletion(g, plan);
  check(state === JSON.stringify(serialize(g)) && proposal === JSON.stringify(plan), `${label}: full formation quote is pure`);
  const preimage = deserialize(JSON.parse(state)), native = commitDoubleTrack(preimage, plan, false);
  // With finish=false only autoSignalLine can add signals; each placed signal pays the native £9k.
  const formationPaid = native.cost - native.signals * SIGNAL_COST;
  check(!native.error && formationPaid > plan.cost && formationPaid <= quote.formationCost,
    `${label}: native lead/diamond formation exceeds the old raw quote and fits its explicit allowance`);
  const eco = g.company(1).economy, cash = eco.money, book = eco.current.construction;
  let funded = 0;
  const result = layInitialDoubleTrack(g, edges, 1, traffic, cost => { funded = cost; return true; }, undefined, preserve);
  check(result.built && result.cost <= funded && funded === quote.cost
    && cash - eco.money === book - eco.current.construction && eq(cash - eco.money, result.cost),
    `${label}: the same funded total completes native geometry and pays the full ledger`);
  console.log(`  ${label}: raw ${plan.cost}, native formation ${formationPaid}, formation allowance ${quote.formationCost}, total quote ${funded}, paid ${result.cost}`);
}
const depotOpening = fixture(), depotEdge = depotOpening.g.world.net.edges.get(upgradeRoute(depotOpening.g, depotOpening.A.id, depotOpening.B.id, 1)[0])!;
const interiorDepot = buildDepotOnLine(depotOpening.g, depotEdge.id, depotEdge.len / 2, 1, { dir: 1, side: -1 });
check(interiorDepot >= 0, 'native direction+1 interior depot is built before quoting');
endpointAllowance(depotOpening.g, upgradeRoute(depotOpening.g, depotOpening.A.id, depotOpening.B.id, 1), 'direction+1 depot',
  p => (depotOpening.g.ais[0] as any).initialPairDepot(p, interiorDepot, depotOpening.A.id, depotOpening.B.id));
check(lineIsDouble(depotOpening.g, depotOpening.l, 1), 'funded depot geometry remains a complete native pair');
const junction = fixture(), j = junction.g, C = station(j, 30, 300, Math.PI / 2, 12, 2, 1)!, D = station(j, 350, 300, Math.PI / 2, 12, 2, 1)!;
build(j, nodeSnap(j, endNode(j, C, 1, true), 'rail'), nodeSnap(j, endNode(j, D, 1, false), 'rail'), railOpts(1), 'second native connector trunk');
const secondLine = j.lines.create('rail', 1); secondLine.stops = [C.id, D.id];
for (const [a, b, line] of [[junction.A, junction.B, junction.l], [C, D, secondLine]] as const) {
  const route = upgradeRoute(j, a.id, b.id, 1), plan = ([1, -1] as const).map(side => planDoubleTrack(j, route, side, 1)).find(p => p.ok)!;
  check(!commitDoubleTrack(j, plan).error, 'native directional fixture trunk builds'); autoSignalLine(j, line.id, 1);
}
const source = routeBetween(j, junction.A.id, junction.B.id, 1)!, target = routeBetween(j, C.id, D.id, 1)!;
const a = j.world.net.nearestEdge(120, 190, 2, 'rail', e => source.includes(e.id))!, b = j.world.net.nearestEdge(235, 300, 2, 'rail', e => target.includes(e.id))!;
const connectorPlan = planConnection(j, a.edge.id, a.s, b.edge.id, b.s, 1, { dirA: 1, dirB: 1, junctionUpgrade: true });
check(connectorPlan.ok, 'native connector formation can be priced');
if (connectorPlan.ok) {
  const connector = commitConnection(j, connectorPlan, { signals: false });
  check(!connector.error, 'native single connector commits');
  endpointAllowance(j, connector.edges, 'directional connector');
  check(!!routeBetween(j, junction.A.id, D.id, 1) && !!routeBetween(j, D.id, junction.A.id, 1),
    'funded connector preserves lawful native service routes in both directions');
}

console.log('Same geometry, cash versus incremental interest');
for (const debt of [false, true]) {
  const f = fixture(), edges = upgradeRoute(f.g, f.A.id, f.B.id, 1), e = f.g.company(1).economy;
  const plan = ([1, -1] as const).map(side => planDoubleTrack(f.g, edges, side, 1)).filter(p => p.ok && p.complete
    && p.start.kind !== 'turnout' && p.end.kind !== 'turnout').sort((a, b) => a.cost - b.cost || b.side - a.side)[0];
  const quote = quoteDoubleTrackCompletion(f.g, plan);
  const marginal = { ...traffic, revenue: 245_000, boardings: 100_000, seats: 100_000 };
  e.money = debt ? 300_000 : 100_000_000; e.interestRate = 0.25;
  const before = JSON.stringify(serialize(f.g)), nativeLoan = e.loan;
  let called = 0;
  const finance = initialTrackFinancing(e, 0, quote.cost);
  const result = layInitialDoubleTrack(f.g, edges, 1, marginal, cost => { called++; return f.g.aiOf(1)!.capacityFunds(cost); });
  console.log(`  ${debt ? 'debt' : 'cash'} ${JSON.stringify(result.choice)}`);
  if (debt) check(!result.built && called === 0 && result.choice!.annualInterest > 0
    && before === JSON.stringify(serialize(f.g)), 'high-interest marginal pair declines before funding with byte-identical native state');
  else check(result.built && called === 1 && result.choice!.annualInterest === 0,
    'cash-funded same geometry/traffic can repay the pair without an invented finance charge');
  if (!debt) check(finance.incrementalLoan === 0 && e.loan === nativeLoan, 'cash-funded pair leaves native debt unchanged');
}
const borrowed = fixture(), e = borrowed.g.company(1).economy;
e.money = 300_000;
const loan = e.loan, beforeInterest = e.current.interest;
let predicted = 0;
const funded = layInitialDoubleTrack(borrowed.g, upgradeRoute(borrowed.g, borrowed.A.id, borrowed.B.id, 1), 1, traffic,
  cost => { predicted = initialTrackFinancing(e, 0, cost).incrementalLoan; return borrowed.g.aiOf(1)!.capacityFunds(cost); });
check(funded.built && e.loan - loan === predicted && predicted > 0, 'a paying pair borrows exactly its native quoted stepped funding');
e.endMonth(1990, 1);
check(eq(beforeInterest - e.months[0].v.interest, (loan + predicted) * e.interestRate / 12)
  && eq(funded.choice!.annualInterest, predicted * e.interestRate), 'real borrowed build and native interest ledger match the valuation charge');
const fallback = fixture(), fallbackEdges = upgradeRoute(fallback.g, fallback.A.id, fallback.B.id, 1);
const loop = ([1, -1] as const).map(side => planDoubleTrack(fallback.g, fallbackEdges, side, 1, false)).find(p => p.ok)!;
check(!commitDoubleTrack(fallback.g, loop).error, 'debt fallback fixture builds its native previous loop');
const fe = fallback.g.company(1).economy; fe.money = 300_000;
const entryLoan = fe.loan; let attempts = 0;
const fresult = layInitialDoubleTrack(fallback.g, upgradeRoute(fallback.g, fallback.A.id, fallback.B.id, 1), 1, traffic,
  cost => { attempts++; return fallback.g.aiOf(1)!.capacityFunds(cost); });
check(fresult.built && attempts >= 2 && eq(fresult.choice!.annualInterest, (fe.loan - entryLoan) * fe.interestRate),
  'failed-side borrowing remains charged when the next native side succeeds');
fe.endMonth(1990, 1);
check(eq(-fe.months[0].v.interest, fe.loan * fe.interestRate / 12), 'native fallback monthly ledger charges the retained borrowed loan');
const reserveEco = Object.assign(new Economy(), { money: 350_000 });
const fleet = 2_660_000, pair = 1_926_224;
const reserveQuote = initialTrackFinancing(reserveEco, fleet + 300_000, pair);
const baseline = Economy.fromJSON(JSON.parse(JSON.stringify(reserveEco))), doubled = Economy.fromJSON(JSON.parse(JSON.stringify(reserveEco)));
funding(baseline, fleet + 300_000);
funding(doubled, pair); doubled.spend(pair, 'construction'); funding(doubled, fleet + 300_000);
check(eq(reserveQuote.incrementalLoan, doubled.loan - baseline.loan)
  && doubled.money >= fleet + 600_000 && baseline.money >= fleet + 600_000,
  'explicit £300k opening reserve plus borrowFor £300k cushion matches sequential native funding');
const noFunds = fixture(), noFundsEco = noFunds.g.company(1).economy;
noFundsEco.money = 100_000; noFundsEco.maxLoan = noFundsEco.loan;
const noFundsSave = JSON.stringify(serialize(noFunds.g)); let noFundsCalls = 0;
const refused = layInitialDoubleTrack(noFunds.g, upgradeRoute(noFunds.g, noFunds.A.id, noFunds.B.id, 1), 1, traffic,
  () => { noFundsCalls++; return true; });
check(!refused.built && noFundsCalls === 0 && noFundsSave === JSON.stringify(serialize(noFunds.g)),
  'unaffordable native loan cap rejects before funding and preserves all serialized state');
console.log('Connector reserved fleet funding');
for (const prefunded of [false, true]) {
  const f = fixture(), depot = depotFor(f.g, f.A, f.B, 1), cars = loco();
  check(depot >= 0, 'native connector fleet has a working depot');
  const fleetCost = cars.reduce((n, m) => n + m.cost, 0) * 2;
  const eco = f.g.company(1).economy;
  eco.money = prefunded ? 20_000_000 : 900_000;
  const snapshot = { money: eco.money, loan: eco.loan, maxLoan: eco.maxLoan, loanStep: eco.loanStep, interestRate: eco.interestRate };
  const originalFunds = f.g.aiOf(1)!.capacityFunds;
  let requested = 0;
  f.g.aiOf(1)!.capacityFunds = function(cost) { requested = cost; return originalFunds.call(this, cost); };
  const result = layInitialDoubleTrack(f.g, upgradeRoute(f.g, f.A.id, f.B.id, 1), 1, traffic,
    cost => fundInitialConnector(f.g.aiOf(1)!, cost, fleetCost), undefined, undefined, fleetCost + 150_000);
  f.g.aiOf(1)!.capacityFunds = originalFunds;
  const quotedPair = requested - fleetCost - 150_000;
  const quote = initialTrackFinancing(snapshot, fleetCost + 150_000, quotedPair);
  check(result.built && quotedPair > 0 && eq(eco.loan - snapshot.loan, quote.totalLoan),
    'actual connector callback funds full quote plus its native fleet/reserve at stepped loan boundaries');
  for (let i = 0; i < 2; i++) check(typeof f.g.vehicles.buyTrain(depot, cars, f.l.id) !== 'string',
    'direct native through-train purchase remains funded after connector capacity spending');
  check(eco.money >= 450_000 && (prefunded ? eco.loan === snapshot.loan : eco.loan > snapshot.loan),
    'connector retains explicit 150k plus native 300k cushion without unnecessary prefunded borrowing');
  eco.endMonth(1990, 1);
  check(eq(-eco.months[0].v.interest, eco.loan * eco.interestRate / 12), 'connector borrowing is charged by the native monthly interest ledger');
}
console.log('Scoped funded construction ceiling');
for (const mode of ['success', 'cap', 'refund', 'throw', 'quoteThrow'] as const) {
  const f = fixture(), eco = f.g.company(1).economy;
  const plans = ([1, -1] as const).map(side => planDoubleTrack(f.g, upgradeRoute(f.g, f.A.id, f.B.id, 1), side, 1));
  const plan = plans.filter(p => p.ok && p.complete && p.start.kind !== 'turnout' && p.end.kind !== 'turnout')
    .sort((a, b) => a.cost - b.cost || b.side - a.side)[0];
  const full = quoteDoubleTrackCompletion(f.g, plan).cost, cap = mode === 'cap' ? plan.cost + 80_000 : full;
  const cash = eco.money, ledger = eco.current.construction, canAfford = eco.canAfford, spend = eco.spend;
  // Exercise an existing own method as well as the ordinary prototype state.
  if (mode === 'refund') Object.defineProperty(eco, 'canAfford', { value: canAfford, configurable: true, writable: false });
  const own = Object.getOwnPropertyDescriptor(eco, 'canAfford'), ownSpend = Object.getOwnPropertyDescriptor(eco, 'spend');
  let calls = 0, threw = false;
  let result: ReturnType<typeof commitCapacityTrackUpgrade> | undefined;
  if (mode === 'quoteThrow') Object.defineProperty(plan, 'steps', { get() { throw new Error('intentional quote failure'); } });
  try {
    result = commitCapacityTrackUpgrade(f.g, plan, () => {
      check(eco.money === cash + eco.current.construction - ledger, 'callbacks see native cash and books throughout the capped construction');
      if (mode === 'throw') throw new Error('intentional ceiling cleanup check');
      return mode !== 'refund' || ++calls === 1;
    }, cap);
  } catch { threw = true; }
  check(eco.canAfford === canAfford && eco.spend === spend
    && JSON.stringify(Object.getOwnPropertyDescriptor(eco, 'canAfford')) === JSON.stringify(own)
    && JSON.stringify(Object.getOwnPropertyDescriptor(eco, 'spend')) === JSON.stringify(ownSpend),
    `native method/prototype descriptors restore after ${mode}`);
  check(cash - eco.money <= cap && eq(cash - eco.money, ledger - eco.current.construction),
    `native paid construction remains within the funded ceiling after ${mode}`);
  if (mode === 'success') check(!result!.error && !result!.finishError, 'funded complete quote still finishes natively');
  if (mode === 'refund') check(!!result!.error && eco.money === cash && eco.current.construction === ledger,
    'a failed native segment refunds paid construction without losing the scoped ceiling state');
  if (mode === 'cap') check(!!result!.error || !!result!.finishError, 'underfunded legacy finish reserve refuses excess native spending');
  if (mode === 'throw') check(threw, 'native callback exceptions preserve method restoration');
  if (mode === 'quoteThrow') check(threw && calls === 0 && eco.money === cash && eco.current.construction === ledger,
    'a fallback quote exception leaves native methods and books untouched before construction');
  check(eco.canAfford(full * 2), 'ordinary native affordability is no longer capped after return');
}
const changed = fixture(), oldEdges = upgradeRoute(changed.g, changed.A.id, changed.B.id, 1);
const oldPlan = ([1, -1] as const).map(side => planDoubleTrack(changed.g, oldEdges, side, 1)).filter(p => p.ok && p.complete
  && p.start.kind !== 'turnout' && p.end.kind !== 'turnout').sort((a, b) => a.cost - b.cost || b.side - a.side)[0];
const approvedQuote = quoteDoubleTrackCompletion(changed.g, oldPlan), approved = approvedQuote.cost;
check(!!build(changed.g, free(changed.g, 190, 150), free(changed.g, 190, 230), roadOpts(1), 'native crossing price change'),
  'native crossing can change a stored formation price before commit');
const revised = planDoubleTrack(changed.g, upgradeRoute(changed.g, changed.A.id, changed.B.id, 1), oldPlan.side, 1);
const crossingPreimage = deserialize(JSON.parse(JSON.stringify(serialize(changed.g)))), fresh = commitDoubleTrack(crossingPreimage, revised, false);
check(revised.ok && !fresh.error && fresh.cost - fresh.signals * SIGNAL_COST > approvedQuote.formationCost,
  'actual native crossing formation exceeds the previously approved formation allowance');
const changedEco = changed.g.company(1).economy, originalCash = changedEco.money, originalBook = changedEco.current.construction;
const failure = commitCapacityTrackUpgrade(changed.g, oldPlan, undefined, approved, approvedQuote);
check(!!failure.error && changedEco.money === originalCash && changedEco.current.construction === originalBook,
  'native higher-cost formation replan refunds before it consumes the mandatory finishing reserve');
const middle = fixture(), middlePlan = ([1, -1] as const).map(side => planDoubleTrack(middle.g,
  upgradeRoute(middle.g, middle.A.id, middle.B.id, 1), side, 1)).find(p => p.ok && p.complete)!;
const beforeHill = quoteDoubleTrackCompletion(middle.g, middlePlan).cost;
for (let z = 187; z <= 193; z++) for (let x = 180; x <= 200; x++) middle.g.world.h[middle.g.world.vi(x, z)] = 30;
middle.g.world.heightsVersion++;
check(quoteDoubleTrackCompletion(middle.g, middlePlan).cost === beforeHill,
  'an unrelated interior hill does not inflate the terminal crossover finishing reserve');
console.log(`  maximum completion quote ${maximumQuoteMs.toFixed(2)}ms`);
if (fails.length) { console.log(`${fails.length} CHECKS FAILED`); process.exitCode = 1; }
else console.log('ALL CHECKS PASSED');
