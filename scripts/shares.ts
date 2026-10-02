// Headless corporate shares tests. Bundle into the scratch directory with esbuild, then run with node.
import { Game, PLAYER } from '../src/game/game';
import { Economy, emptyRecord, profitOf, CATEGORIES } from '../src/game/economy';
import { SHARE_COUNT, BUY_PREMIUM, CONTROL_PREMIUM_STEP, SELL_FEE, DIVIDEND_RATE } from '../src/game/shares';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { DAYS_PER_MONTH, MONTHS_PER_YEAR } from '../src/game/constants';

let checks = 0;
const failures: string[] = [];
function check(ok: unknown, label: string) {
  checks++;
  if (!ok) { failures.push(label); console.log('FAIL: ' + label); }
}
function near(actual: number, expected: number, label: string) { check(Math.abs(actual - expected) < 0.000001, `${label}: ${actual} vs ${expected}`); }
const totalCash = (g: Game) => g.companies.reduce((sum, c) => sum + c.economy.money, 0);

function fixture(n = 2) {
  const g = new Game({ size: 128, seed: 41, towns: 0, hilliness: 'flat', water: 'low', startYear: 1985 });
  g.world.h.fill(4);
  g.aiEnabled = false;
  g.aiAcquisitions = false;
  g.vehicles.ambientEnabled = false;
  g.economy.money = 100_000_000;
  g.economy.loan = 0;
  for (let i = 0; i < n; i++) {
    const co = g.addAICompany({ activeness: 0.25, risk: 0.1 });
    co.economy.money = 1_000_000;
    co.economy.loan = 0;
  }
  g.demand.rebuild();
  return g;
}

function buyShares(g: Game, owner: number, target: number, count: number) {
  for (let i = 0; i < count; i++) {
    const err = g.shares.invest(owner, target);
    check(err === null, `${owner} buys share ${i + 1}/${count} in ${target}${err ? ': ' + err : ''}`);
  }
}

function assets(g: Game, owner: number) {
  const e = g.company(owner).economy;
  e.money = 20_000_000;
  const net = g.world.net;
  for (const [kind, z, roadOwner, tram] of [['rail', 80, owner, false], ['road', 96, owner, false], ['road', 112, -1, true]] as const) {
    const a = net.addNode(kind, 20, 4, z, 1, 0, roadOwner), b = net.addNode(kind, 60, 4, z, 1, 0, roadOwner);
    net.addEdge(kind, a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array([4, 4]), [], kind === 'rail' ? 'standard' : 'road', roadOwner,
      tram ? { tram: true, tramOwner: owner } : {});
  }
  const plan = g.stations.planRail(40, 40, Math.PI / 2, 16, 1, owner);
  check(plan.ok && g.stations.commitRail(plan, owner) === null, 'fixture railway station built');
  const depot = g.depots.plan('road', 40, 92, 0, owner);
  const depotId = g.depots.nextId;
  const depotError = depot.ok ? g.depots.commit('road', depot, owner) : depot.error;
  check(depot.ok && depotError === null, `fixture depot built${depotError ? ': ' + depotError : ''}`);
  const line = g.lines.create('road', owner);
  const vehicle = g.vehicles.buyRoad(depotId, MODEL_BY_ID.get('bus_c')!, line.id);
  check(typeof vehicle !== 'string', 'fixture bus bought');
  e.loan = 750_000;
  g.lines.rebuild();
  g.flushNetworkChanges();
  return { line, vehicle, depotId };
}

// ------------------------------------------------------------------ valuation and one-share transactions
{
  const g = fixture(), e = g.company(1).economy;
  const q = g.shares.quote(PLAYER, 1);
  check(SHARE_COUNT === 10 && g.shares.freeFloat(1) === 10, 'ten shares initially in free float');
  near(q.value, 100_000, 'one share is a tenth of the buyout valuation');
  near(q.premium, 0.15, 'initial premium 15%');
  near(q.premiumAmount, 15_000, 'initial premium amount');
  near(q.buyPrice, 115_000, 'buy price includes premium');
  near(q.fee, 0.10, 'sale fee 10%');
  near(q.feeAmount, 10_000, 'sale fee amount');
  near(q.sellPrice, 90_000, 'sale proceeds exclude fee');
  const initial = totalCash(g), cash = g.economy.money;
  check(g.shares.invest(PLAYER, 1) === null, 'buy first 10%');
  check(g.shares.shareCount(PLAYER, 1) === 1 && g.shares.freeFloat(1) === 9, 'buy changes ownership by one share');
  near(g.economy.money, cash - q.buyPrice, 'investor pays full purchase price');
  near(e.money, 1_000_000 + q.value, 'target receives the share base value as funding');
  near(g.economy.thisYear.investments, -q.buyPrice, 'investor finance investment debit');
  near(e.thisYear.investments, q.value, 'target finance funding credit');
  near(totalCash(g), initial - q.premiumAmount, 'purchase premium leaves company cash as a real charge');
  near(e.lastYearProfit, 0, 'funding is excluded from profit');
  const q2 = g.shares.quote(PLAYER, 1);
  near(q2.value, 110_000, 'funding increases valuation through target cash');
  near(q2.premium, 0.20, 'premium increases with the held stake');
  near(q2.buyPrice, 132_000, 'second purchase price with 20% premium');
  check(g.shares.invest(PLAYER, 1) === null, 'buy second 10%');
  const sale = g.shares.quote(PLAYER, 1), p = g.economy.money, t = e.money, saleCash = totalCash(g);
  check(g.shares.divest(PLAYER, 1) === null, 'sell one 10%');
  check(g.shares.shareCount(PLAYER, 1) === 1 && g.shares.freeFloat(1) === 9, 'divest releases exactly one share');
  near(g.economy.money, p + sale.sellPrice, 'investor receives net sale price');
  near(e.money, t - sale.value, 'target pays the gross repurchase value');
  near(g.economy.thisYear.divestments, sale.sellPrice, 'investor finance divestment credit');
  near(e.thisYear.divestments, -sale.value, 'target finance repurchase debit');
  near(totalCash(g), saleCash - sale.feeAmount, 'divestment fee leaves company cash as a real charge');
  near(e.lastYearProfit, 0, 'repurchases are excluded from profit');
  near(g.shares.quote(PLAYER, 1).premium, 0.20, 'divesting reduces the next purchase premium');
  check(g.shares.divest(PLAYER, 1) === null && g.shares.freeFloat(1) === 10, 'last divest returns all shares to free float');
  check(g.shares.divest(PLAYER, 1) !== null, 'cannot sell a share not owned');
  check(g.shares.invest(PLAYER, PLAYER) !== null && g.shares.divest(PLAYER, PLAYER) !== null, 'cannot trade own stock');
  check(g.shares.invest(-1, 1) !== null && g.shares.invest(PLAYER, 999) !== null, 'invalid companies cannot trade');
  g.economy.money = 0;
  const before = JSON.stringify(g.shares.toJSON()), targetMoney = e.money;
  check(g.shares.invest(PLAYER, 1) !== null, 'unaffordable buy rejected');
  check(JSON.stringify(g.shares.toJSON()) === before && e.money === targetMoney, 'rejected buy is atomic');
}
{
  const g = fixture(), e = g.company(1).economy;
  e.loan = 200_000;
  e.yearTotals.push({ year: 1984, v: { ...emptyRecord(), income: 200_000 } });
  near(g.acquisitionValue(1), 1_200_000, 'valuation includes cash minus loan plus two years of profit');
  near(g.shares.quote(PLAYER, 1).value, 120_000, 'earnings included in share value');
  near(g.buyoutPrice(1), 1_500_000, 'existing full buyout premium unchanged');
  e.yearTotals[0].v.income = -200_000;
  near(g.acquisitionValue(1), 800_000, 'negative earnings add no value');
  e.money = -1_000_000;
  near(g.acquisitionValue(1), 400_000, 'existing minimum buyout valuation prevents free control');
  near(g.buyoutPrice(1), 500_000, 'old full buyout floor unchanged');
}

// ------------------------------------------------------------------ several corporate shareholders, cash constraints
{
  const g = fixture();
  buyShares(g, PLAYER, 1, 2);
  buyShares(g, 2, 1, 1);
  check(JSON.stringify(g.shares.shareholders(1)) === JSON.stringify([{ owner: 0, shares: 2 }, { owner: 2, shares: 1 }]), 'shareholders are companies with integer holdings');
  check(g.shares.freeFloat(1) === 7, 'free float excludes all company holdings');
  near(g.shares.quote(2, 1).premium, BUY_PREMIUM + CONTROL_PREMIUM_STEP, 'premium depends on the buying company stake');
  const own = JSON.stringify(g.shares.toJSON());
  check(g.buyCompany(2, 1) !== null && g.buyCompany(PLAYER, 1) !== null, 'legacy buyout cannot erase minority shareholders');
  check(JSON.stringify(g.shares.toJSON()) === own, 'blocked legacy buyouts preserve ownership');
  g.company(1).economy.money = 0;
  check(g.shares.divest(PLAYER, 1) !== null, 'target must afford a repurchase');
  check(JSON.stringify(g.shares.toJSON()) === own, 'rejected sale preserves ownership');
  g.company(1).economy.money = 210_000;
  g.company(1).economy.thisYear.income = 1_000_000;
  const quote = g.shares.quote(PLAYER, 1);
  check(g.company(1).economy.canAfford(quote.sellPrice) && !g.company(1).economy.canAfford(quote.value), 'fixture can afford net proceeds but not gross repurchase');
  check(g.shares.divest(PLAYER, 1) !== null && JSON.stringify(g.shares.toJSON()) === own, 'sale requires cash for the base value including its fee');
  g.company(2).defunct = true;
  check(g.shares.invest(2, 1) !== null && g.shares.divest(2, 1) !== null, 'defunct investors cannot trade');
}

// ------------------------------------------------------------------ profit, yearly returns and limited cash
{
  const g = fixture(), target = g.company(1).economy;
  buyShares(g, PLAYER, 1, 3);
  buyShares(g, 2, 1, 2);
  target.earn(120_000, 'income');
  target.spend(20_000, 'running');
  const cash = totalCash(g), p = g.economy.money, a = g.company(2).economy.money, t = target.money;
  g.shares.payDividends(1985);
  near(g.economy.money - p, 9_000, '30% owner receives 30% of the 30% profit distribution');
  near(g.company(2).economy.money - a, 6_000, '20% owner receives its pro rata dividend');
  near(t - target.money, 15_000, 'free float dividend portion stays in target');
  near(totalCash(g), cash, 'dividends conserve company cash');
  near(target.thisYear.dividends, -15_000, 'target dividend distribution debit');
  near(g.economy.thisYear.dividends, 9_000, 'shareholder dividend income credit');
  near(target.lastYearProfit, 100_000, 'dividend payout does not reduce the profit base');
  near(g.economy.lastYearProfit, 0, 'dividend income is separate from operating earnings');
  near(g.shares.dividendLastYear(PLAYER, 1), 9_000, 'per-investment dividend history');
  near(g.shares.dividendsPaidLastYear(1), 15_000, 'total dividend history');
  check(g.shares.dividendYear(1) === 1985, 'dividend year saved');
  const paid = JSON.stringify(g.shares.toJSON());
  g.shares.payDividends(1985);
  check(JSON.stringify(g.shares.toJSON()) === paid && g.economy.money === p + 9_000, 'yearly dividends cannot pay twice');
  g.shares.payDividends(1984);
  check(JSON.stringify(g.shares.toJSON()) === paid && g.economy.money === p + 9_000, 'an older year cannot replay dividends');
  for (const co of g.activeCompanies) co.economy.endYear(1985);
  target.spend(25_000, 'running');
  const lossCash = target.money;
  g.shares.payDividends(1986);
  near(target.money, lossCash, 'loss-making year pays no dividend');
  near(g.shares.dividendLastYear(PLAYER, 1), 0, 'last-year history resets after a loss');
}
{
  const g = fixture(), target = g.company(1).economy;
  buyShares(g, PLAYER, 1, 1);
  buyShares(g, 2, 1, 2);
  target.thisYear.income = 1_000;
  target.money = 0.05;
  g.shares.payDividends(1985);
  near(g.shares.dividendLastYear(PLAYER, 1), 0.02, 'cash-limited distribution allocates leftover cents deterministically');
  near(g.shares.dividendLastYear(2, 1), 0.03, 'cash-limited dividend is pro rata to nearest cent');
  near(target.money, 0, 'dividends cannot overdraw target cash');
  target.money = -1;
  g.shares.payDividends(1986);
  near(g.shares.dividendsPaidLastYear(1), 0, 'negative cash pays nothing despite positive profit');
}
{
  const g = fixture(), target = g.company(1).economy;
  buyShares(g, PLAYER, 1, 3);
  target.earn(200_000, 'income');
  target.spend(80_000, 'running');
  const cash = g.economy.money;
  const yearDays = DAYS_PER_MONTH * MONTHS_PER_YEAR;
  g.day = yearDays - 1;
  g.dayFrac = 0.99;
  while (g.day < yearDays) g.update(0.05);
  near(g.economy.money - cash, 10_800, 'calendar year-end hook pays dividends');
  near(target.yearTotals[0].v.dividends, -10_800, 'dividends recorded in the completed year');
  near(g.economy.months[0].v.dividends, 10_800, 'year-end dividends recorded in December');
  near(g.economy.current.dividends, 0, 'January does not repeat December dividend entry');
  near(target.lastYearProfit, 120_000, 'complete-year profit remains before distribution');
  check(g.shares.dividendYear(1) === 1985 && g.year === 1986, 'dividends labelled for completed year');
}
{
  const g = fixture();
  buyShares(g, 1, 2, 1);
  buyShares(g, 2, 1, 1);
  g.company(1).economy.thisYear.income = 100_000;
  g.company(2).economy.thisYear.income = 200_000;
  g.shares.payDividends(1985);
  near(g.shares.dividendLastYear(2, 1), 3_000, 'cross-holding payout uses snapshot of operating profit');
  near(g.shares.dividendLastYear(1, 2), 6_000, 'received dividend does not compound another payout');
}

// ------------------------------------------------------------------ full control and merge with all assets
{
  const g = fixture(), target = g.company(1);
  const built = assets(g, 1);
  const assetsValue = g.companyAssets(1).total;
  const initialCash = totalCash(g);
  near(g.acquisitionValue(1), assetsValue + target.economy.money - target.economy.loan, 'share valuation includes all depreciated assets');
  check(g.mergeCompany(PLAYER, 1) !== null && g.shares.keepAsSubsidiary(PLAYER, 1) !== null, 'zero stake cannot merge or keep a subsidiary');
  buyShares(g, PLAYER, 1, 9);
  const before = JSON.stringify(g.shares.toJSON()), cash = g.economy.money;
  check(g.mergeCompany(PLAYER, 1) !== null && !target.defunct && g.economy.money === cash, '90% ownership cannot merge');
  check(JSON.stringify(g.shares.toJSON()) === before, 'rejected merge preserves holdings');
  near(g.shares.quote(PLAYER, 1).premium, 0.60, 'controlling share premium rises to 60%');
  check(g.shares.invest(PLAYER, 1) === null, 'buy controlling tenth share');
  check(g.shares.ownerOf(1) === PLAYER && g.shares.freeFloat(1) === 0, '100% wholly owned');
  check(!target.defunct && g.ais.some((a) => a.companyId === 1), 'reaching 100% waits for a merge/keep choice');
  check(g.shares.invest(PLAYER, 1) !== null && g.shares.invest(2, 1) !== null, 'cannot buy beyond ten shares');
  const pCash = g.economy.money, tCash = target.economy.money, loan = g.economy.loan + target.economy.loan;
  const premiums = -g.economy.thisYear.investments - target.economy.thisYear.investments;
  check(g.mergeCompany(PLAYER, 1) === null, 'merge at 100% succeeds');
  check(target.defunct && target.boughtBy === PLAYER && !g.ais.some((a) => a.companyId === 1), 'merged company becomes defunct and loses AI controller');
  near(g.economy.money, pCash + tCash, 'merge takes cash without charging a second purchase price');
  check(premiums > 0, 'control purchases paid real premiums');
  near(totalCash(g), initialCash - premiums, 'merge does not refund transaction premiums');
  near(g.economy.loan, loan, 'merge inherits loan');
  check(target.economy.money === 0 && target.economy.loan === 0, 'merged economy emptied');
  check([...g.world.net.edges.values()].every((e) => e.owner !== 1 && e.tramOwner !== 1), 'rail, road and tram ownership transferred');
  check([...g.world.net.nodes.values()].every((n) => n.owner !== 1), 'network node ownership transferred');
  check(g.stations.all().every((s) => s.owner === PLAYER) && g.depots.all().every((d) => d.owner === PLAYER), 'stations and depots transferred');
  check(built.line.owner === PLAYER && typeof built.vehicle !== 'string' && built.vehicle.owner === PLAYER, 'lines and vehicles transferred');
  check(g.shares.shareCount(PLAYER, 1) === 0 && g.shares.subsidiaryOf(1) === null, 'defunct target stock cancelled');
  check(g.shares.invest(PLAYER, 1) !== null && g.shares.divest(PLAYER, 1) !== null && g.mergeCompany(PLAYER, 1) !== null, 'defunct target cannot trade or merge again');
}

// ------------------------------------------------------------------ keep as subsidiary, exact save/load, then merge later
{
  const g = fixture(3), target = g.company(1);
  target.economy.money = 20_000_000;
  const line = g.lines.create('road', 1);
  buyShares(g, 1, 2, 2);
  buyShares(g, 1, PLAYER, 1);
  buyShares(g, PLAYER, 1, 10);
  const name = target.name, color = target.color, money = target.economy.money;
  check(g.shares.keepAsSubsidiary(PLAYER, 1) === null, 'keep-as-subsidiary choice succeeds');
  check(g.shares.subsidiaryOf(1) === PLAYER && !target.defunct && g.activeCompanies.includes(target), 'subsidiary remains active');
  check(target.name === name && target.color === color && line.owner === 1 && g.ais.some((a) => a.companyId === 1), 'subsidiary retains identity, lines and AI');
  near(target.economy.money, money, 'keeping subsidiary transfers no assets or cash');
  check(g.shares.keepAsSubsidiary(PLAYER, 1) === null, 'keeping a subsidiary twice is harmless');
  target.economy.earn(120_000, 'income');
  g.shares.payDividends(1985);
  near(g.shares.dividendLastYear(PLAYER, 1), 120_000 * DIVIDEND_RATE, '100% subsidiary pays full shareholder dividend');
  const data = JSON.stringify(serialize(g)), loaded = deserialize(JSON.parse(data));
  check(JSON.stringify(loaded.shares.toJSON()) === JSON.stringify(g.shares.toJSON()), 'ownership, subsidiary flag and dividends survive save/load exactly');
  check(JSON.stringify(serialize(loaded)) === data, 'full save round trip is byte-for-byte exact');
  check(loaded.company(1).name === name && loaded.company(1).color === color && loaded.ais.some((a) => a.companyId === 1), 'loaded subsidiary still has its AI and identity');
  const p = loaded.economy.money, t = loaded.company(1).economy.money;
  check(loaded.mergeCompany(PLAYER, 1) === null, 'loaded subsidiary can merge later');
  near(loaded.economy.money, p + t, 'later merge transfers remaining subsidiary cash');
  check(loaded.lines.get(line.id)?.owner === PLAYER, 'later merge transfers subsidiary lines');
  check(loaded.shares.shareCount(PLAYER, 2) === 2 && loaded.shares.shareCount(1, 2) === 0, 'subsidiary stakes in other companies transfer to owner');
  check(loaded.shares.shareCount(1, PLAYER) === 0 && loaded.shares.shareCount(PLAYER, PLAYER) === 0 && loaded.shares.freeFloat(PLAYER) === 10, 'inherited buyer shares become free float instead of self-owned stock');
}
{
  const g = fixture();
  buyShares(g, PLAYER, 1, 10);
  check(g.shares.keepAsSubsidiary(PLAYER, 1) === null, 'keep subsidiary before a partial divestment');
  check(g.shares.divest(PLAYER, 1) === null && g.shares.shareCount(PLAYER, 1) === 9 && g.shares.subsidiaryOf(1) === null, 'selling 10% clears full-ownership subsidiary status');
  check(g.mergeCompany(PLAYER, 1) !== null, 'divested subsidiary cannot merge at 90%');
  check(g.shares.invest(PLAYER, 1) === null && g.mergeCompany(PLAYER, 1) === null, 'can reacquire final share then merge');
}
{
  const g = fixture();
  g.company(1).economy.money = 40_000_000;
  buyShares(g, 1, 2, 10);
  check(g.shares.keepAsSubsidiary(1, 2) === null, 'AI owner can explicitly keep a subsidiary');
  buyShares(g, PLAYER, 1, 10);
  check(g.mergeCompany(PLAYER, 1) === null && g.shares.subsidiaryOf(2) === PLAYER && g.shares.shareCount(PLAYER, 2) === 10, 'nested subsidiary follows owner after its parent merges');
  check(g.mergeCompany(PLAYER, 2) === null, 'inherited subsidiary can itself merge');
}
{
  const g = fixture();
  g.company(1).economy.money = 20_000_000;
  buyShares(g, 1, 2, 10);
  g.company(2).economy.money = 100_000_000;
  buyShares(g, 2, 1, 9);
  check(g.shares.invest(2, 1) !== null && g.shares.shareCount(2, 1) === 9, 'last purchase cannot create circular full ownership');
}

// ------------------------------------------------------------------ minority ownership, legacy saves and legacy acquisition path
{
  const g = fixture();
  buyShares(g, PLAYER, 1, 2);
  buyShares(g, 2, 1, 1);
  check(g.shares.divest(PLAYER, 1) === null, 'partial ownership save includes divestment');
  const json = JSON.stringify(serialize(g)), copy = deserialize(JSON.parse(json));
  check(JSON.stringify(copy.shares.toJSON()) === JSON.stringify(g.shares.toJSON()), 'multiple minority shareholders save exactly');
  check(JSON.stringify(serialize(copy)) === json, 'minority save round trip identical');
  const old = JSON.parse(json);
  delete old.shares;
  for (const c of old.companies) {
    for (const v of [c.economy.current, c.economy.thisYear, ...c.economy.months.map((m: any) => m.v), ...c.economy.yearTotals.map((y: any) => y.v)]) {
      delete v.investments; delete v.divestments; delete v.dividends;
    }
  }
  const legacy = deserialize(old);
  check(JSON.stringify(legacy.shares.toJSON()) === '{}' && legacy.companies.every((c) => legacy.shares.freeFloat(c.id) === 10), 'old saves load with no shareholders');
  check(legacy.companies.every((c) => c.economy.current.investments === 0 && c.economy.thisYear.divestments === 0 && c.economy.thisYear.dividends === 0), 'old finance records fill new categories with zero');
  check(legacy.shares.invest(PLAYER, 1) === null, 'loaded old save supports share investments');
  const e = Economy.fromJSON({ thisYear: { income: 5_000 }, yearTotals: [{ year: 1984, v: { income: 8_000, running: -2_000 } }] });
  near(e.lastYearProfit, 6_000, 'old completed-year profits are preserved');
  check(['investments', 'divestments', 'dividends'].every((k) => CATEGORIES.includes(k as any)), 'all new finance categories are registered');
  near(profitOf({ income: 1_000, investments: 10_000, divestments: -5_000, dividends: -250, acquisition: -2_000 }), 1_000, 'finance profit excludes all ownership transfers');
}
{
  const g = fixture(), target = g.company(1), price = g.buyoutPrice(1), cash = g.economy.money, t = target.economy.money;
  check(g.buyCompany(PLAYER, 1) === null && target.defunct, 'unowned legacy full buyout still acquires then merges');
  near(g.economy.money, cash - price + t, 'legacy buyout cash semantics unchanged');
  check(g.shares.shareCount(PLAYER, 1) === 0, 'legacy merged shares are cancelled');
}

console.log(`shares: ${checks - failures.length}/${checks} checks passed; ${failures.length} failures`);
process.exitCode = failures.length ? 1 : 0;
