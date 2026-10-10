// Uniform new-game funding is entirely debt, including amounts above the ordinary ceiling.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { Economy, loanLimit } from '../src/game/economy';
import { serialize, deserialize } from '../src/game/save';
import { aiConfigsFor } from '../src/ui/gameapi';
for(const amount of [0,2_500_000,5_000_000,30_000_000,1_000_000_000,NaN,Infinity]) {
 const expected=Number.isFinite(amount)?amount:5_000_000;
 const g=Game.create({size:128,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1950,startMoney:amount,aiCompanies:3,aiConfigs:aiConfigsFor('mixed',3)});
 for(const c of g.companies) {
  const e=c.economy;assert.equal(e.money,expected);assert.equal(e.loan,expected);assert.equal(e.initialLoan,expected);assert.equal(e.netWorth,0);
  assert(e.maxLoan>=e.loan);assert(loanLimit(e,.15)>=e.loan || e.loan>e.maxLoan*.15 && e.initialLoan<e.loan);
  const monthly=Economy.fromJSON(JSON.parse(JSON.stringify(e))),cash=monthly.money;monthly.endMonth(1950,0);
  assert(Math.abs(cash-monthly.money-expected*.04/12)<1e-7);
 }
 const data=serialize(g);assert.equal(JSON.stringify(serialize(deserialize(data))),JSON.stringify(data));
 if(expected>25e6){assert.equal(g.ais[0].available(),expected-1e6);assert.equal(g.companies[1].economy.borrow(),false,'startup debt floor grants no additional loan');}
}
const e=new Economy();e.startWithLoan(30e6);assert(e.repay());assert.equal(e.loan,29.5e6);assert.equal(e.initialLoan,29.5e6);
const legacy=Economy.fromJSON({money:8e6,loan:5e6,maxLoan:25e6});assert.equal(legacy.money,8e6);assert.equal(legacy.loan,5e6);assert.equal(legacy.initialLoan,0);assert.equal(loanLimit(legacy,.4),10e6);
const g=Game.create({size:128,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1950,aiCompanies:1});
g.companies[0].economy.startWithLoan(30e6);g.companies[1].economy.startWithLoan(30e6);
const p=g.companies[0].economy,t=g.companies[1].economy;
for(let share=0;share<10;share++)assert.equal(g.shares.invest(0,1),null);
assert.equal(g.mergeOwnedCompany(0,1),null);assert.equal(p.initialLoan,60e6);assert.equal(p.loan,60e6);assert(p.maxLoan>=p.initialLoan);assert.equal(t.initialLoan,0);assert.equal(t.loan,0);
console.log('PASS uniform full starting debt, all amounts, full interest, no extra credit, repay, merger and old/current saves');
