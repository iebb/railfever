// Explicit optional opening debt is priced against native no-repair stock funding, before any borrowing.
import {Game} from '../src/game/game';
import {AIController} from '../src/game/ai';
import {Train} from '../src/game/train';
import {serialize,deserialize} from '../src/game/save';
import {platformChoices} from '../src/game/rail-platforms';
import {connectStationThroat,holdThroat,releaseHold,WORKS_HOLD} from '../src/game/trackops';
import {autoSignalLine,setSignal} from '../src/game/signals';
import {buildDepotOnLine} from '../src/game/routing';
import {flatGame,station,endNode,nodeSnap,railOpts,build,loco,check,fails} from './stationlib';
import {checkReservations} from './lib';
import {controlledOpeningWorld} from './opening-fixtures';
import * as Initial from '../src/game/ai-initial-track';
const fleet=loco().reduce((n,c)=>n+c.cost,0)*2,fullTarget=fleet+600_000;
function nativeOpening(expectedStock?:ReturnType<typeof loco>){
 const constrained=!!expectedStock,f=controlledOpeningWorld(),{g,ai,owner}=f,e=g.company(owner).economy,spend=e.spend,borrow=e.borrow,sd=Object.getOwnPropertyDescriptor(e,'spend'),bd=Object.getOwnPropertyDescriptor(e,'borrow');
 const spends:{amount:number;kind:string;cash:number;loan:number;throat:boolean;buy:boolean;opening:boolean;order:number}[]=[],loans:{before:number;after:number;caller:boolean;order:number}[]=[];
 let injected=false,atExpense=0,opening=false,order=0,original:ReturnType<typeof Initial.openingFundingBaseline>|undefined,approved:ReturnType<typeof Initial.openingFundingAppraisal>|undefined,quote:{cost:number;finishing:number;upkeep:number}|undefined;
 e.spend=function(...args:Parameters<typeof spend>){const stack=new Error().stack??'',ok=spend.apply(this,args);if(ok)spends.push({amount:args[0],kind:args[1],cash:this.money,loan:this.loan,throat:stack.includes('connectStationThroat'),buy:stack.includes('buyTrain'),opening,order:order++});return ok;};
 e.borrow=function(){const before=this.loan,stack=new Error().stack??'',ok=borrow.call(this);if(ok)loans.push({before,after:this.loan,caller:stack.includes('connectStationThroat'),order:order++});return ok;};
 check(!AIController.forceBuild&&ai.startProject('rail',[0,1]),'controlled native profitable opening begins without forceBuild');
 const project=(ai as any).project,pd=Object.getOwnPropertyDescriptor(project,'openingLine');let openingLine=project.openingLine;
 Object.defineProperty(project,'openingLine',{configurable:true,enumerable:true,get:()=>openingLine,set:(value:number)=>{
  openingLine=value;opening=true;atExpense=e.loan;
  const line=g.lines.get(value)!,A=[...g.stations.map.values()].find(s=>s.owner===owner&&s.townId===0)!;
  const before=JSON.stringify(serialize(g)),ordinary=connectStationThroat(g,A.id,owner);
  check(ordinary.connected===0&&ordinary.failed.length>0&&JSON.stringify(serialize(g))===before,'controlled depot spur blocks the ordinary ladder without changing native state');
  check(ai.stats.doubled===0&&f.blockers.every(id=>g.world.buildings.has(id)),'native demolition pricing preserves the developed narrow single formation instead of an initial pair');
  if(!expectedStock)return;
  const nativeFleet=expectedStock.reduce((n,c)=>n+c.cost,0)*2,normal=autoSignalLine(g,line.id,owner,{preview:true}).cost,signals=Initial.openingSignalPlan(g,line,project.depots[0],expectedStock,line.stops[0]);
  if(!signals)throw Error('controlled native full-stock signalling quote');
  // Declining this independent dry appraisal captures a genuine protected quote without funding or
  // construction. The real railJob approve/fund closures execute immediately after this observer.
  connectStationThroat(g,A.id,owner,{junctions:true,reserve:nativeFleet+600_000,signals,approve:(cost,upkeep,finishing)=>{quote??={cost,upkeep,finishing};return false;},fund:()=>{throw Error('preview must not fund');}});
  check(!!quote&&JSON.stringify(serialize(g))===before,'native optional complete geometry and signalling quote is available without mutation');
  if(!quote)throw Error('controlled optional quote unavailable');
  const extra=quote.cost+quote.finishing-normal;
  check(extra>0&&extra<500_000,'complete optional works add a positive sub-step price beyond ordinary signals');
  const cash=nativeFleet+600_000+normal-500_000+extra/2;
  check(e.money>cash,'explicit native expense can create the intended financing boundary');
  if(e.money<=cash)throw Error('controlled expense requires ample original cash');
  e.spend(e.money-cash,'maintenance',true);injected=true;
  original=Initial.openingFundingBaseline(e,nativeFleet,normal);
  approved=Initial.openingFundingAppraisal(e,original,quote.cost+quote.finishing,ai.loanAppetite,ai.available());
  check(original.noRepairLoan===atExpense+500_000&&approved.affordable&&approved.incrementalLoan===500_000&&approved.endLoan===original.noRepairLoan+500_000&&approved.annualInterest===500_000*e.interestRate,'before borrowing, complete native quote adds exactly500k debt and actual interest beyond baseline stock/signals');
 }});
 let tick=0;try{for(;tick<400*g.ticksPerDay&&ai.busy;tick++){const dayTick=g.tick%g.ticksPerDay;ai.work(dayTick,dayTick+1);g.stepTick();}}
 finally{if(pd)Object.defineProperty(project,'openingLine',pd);else{delete project.openingLine;if(openingLine!==undefined)project.openingLine=openingLine;}if(sd)Object.defineProperty(e,'spend',sd);else delete(e as any).spend;if(bd)Object.defineProperty(e,'borrow',bd);else delete(e as any).borrow;f.restore();}
 const line=[...g.lines.map.values()].find(l=>l.owner===owner&&l.kind==='rail')!,choices=line?.stops.map((_,i)=>platformChoices(g,line,0,i).length)??[],buys=spends.filter(x=>x.buy),optional=spends.filter(x=>x.throat&&x.opening),trains=g.vehicles.trains().filter(t=>t.owner===owner),stock=trains[0]?.cars;
 console.log('controlled native opening '+JSON.stringify({constrained,tick,injected,atExpense,loan:e.loan,cash:e.money,choices,original,approved,quote,loans,throat:spends.filter(x=>x.throat),buys,notes:ai.log.slice(-6)}));
 check(!ai.busy&&choices.length===2&&choices.every(x=>x===2)&&buys.length===2&&trains.length===2&&checkReservations(g).length===0,'actual funded railJob completes both legal platforms and purchases the full two-train fleet');
 check(optional.length===1&&e.money>=600_000,'actual optional callback completes one paid lead while preserving the full fleet plus600k reserve');
 if(!stock)throw Error('controlled native opening did not purchase stock');
 const stockIds=stock.map(c=>c.id);check(trains.every(t=>JSON.stringify(t.cars.map(c=>c.id))===JSON.stringify(stockIds)),'both opening trains receive the same full native stock');
 if(expectedStock){
  check(JSON.stringify(stockIds)===JSON.stringify(expectedStock.map(c=>c.id)),'constrained funding retains the complete native ample-case stock');
  const funded=loans.filter(x=>x.caller);
  check(injected&&funded.length===2&&funded.every(x=>x.after-x.before===500_000)&&funded.every(x=>x.order<optional[0]?.order)&&optional[0]?.amount===quote?.cost&&e.loan===approved?.endLoan&&e.loan===atExpense+1_000_000,'real railJob funding closure borrows baseline500k and extra500k before its approved paid works');
  const replay=deserialize(JSON.parse(JSON.stringify(serialize(g))));let exact=true;for(let i=0;i<640;i++){g.stepTick();replay.stepTick();if(JSON.stringify(serialize(g))!==JSON.stringify(serialize(replay))){exact=false;break;}}
  check(exact&&checkReservations(g).length===0&&checkReservations(replay).length===0,'actual funded railJob has complete640 saved-state/RNG/reservation replay');
 }else check(e.loan===atExpense,'ample cash completes the native optional opening without adding debt');
 return stock;
}
console.log('Actual railJob callback on controlled native geometry');const openingStock=nativeOpening();nativeOpening(openingStock);
if(process.argv.includes('--native-only')){console.log(fails.length?`${fails.length} CHECKS FAILED`:'ALL CHECKS PASSED');process.exit(fails.length?1:0);}

function fixture(old=false,foreignSpur=false){
 const g=flatGame(384),owner=g.addAICompany({startMoney:100_000_000}).id,foreign=g.addAICompany({startMoney:100_000_000}).id;g.aiEnabled=false;g.aiAcquisitions=false;
 const oldStation=old?station(g,80,60,Math.PI/2,10,1,owner):null;const before=Initial.openingThroatBaseline(g,owner);
 const A=station(g,30,192,Math.PI/2,10,2,owner)!,B=station(g,350,192,Math.PI/2,10,2,owner)!;
 build(g,nodeSnap(g,endNode(g,A,0,true),'rail'),nodeSnap(g,endNode(g,B,0,false),'rail'),railOpts(owner),'funding main');
 const n=g.world.net.nodes.get(endNode(g,A,0,true))!,hit=g.world.net.nearestEdge(n.x+3,n.z,1,'rail',e=>e.station<0&&e.depot<0)!;
 const depot=buildDepotOnLine(g,hit.edge.id,hit.s,foreignSpur?foreign:owner,{dir:-1,side:-1});if(depot<0)throw Error('native depot');
 const initial=connectStationThroat(g,B.id,owner);check(initial.connected>0,'native ordinary opposite throat is completed');
 const line=g.lines.create('rail',owner);line.stops=[A.id,B.id];g.lines.rebuild();
 const e=g.company(owner).economy;e.money=2_821_178.489077144;e.loan=12_500_000;e.maxLoan=25_000_000;e.loanStep=500_000;e.interestRate=.04;
 const p={edges:[...g.world.net.edges.values()].filter(e=>e.owner===owner).map(e=>e.id),stations:[A.id,B.id],depots:[depot]};
 return{g,owner,foreign,oldStation,A,B,depot,line,e,before,p,service:{total:5_479_996.425021907,fleet,income:1_013_082.1751979147,running:202_239.22472643858,maintenance:145_000,wear:2000,amortisation:.03}};
}
const saved=(f:ReturnType<typeof fixture>)=>JSON.stringify([serialize(f.g),[...(f.g.vehicles as any).res]]);
function complete(f:ReturnType<typeof fixture>,income=f.service.income){
 const signals=Initial.openingSignalPlan(f.g,f.line,f.depot,loco(),f.A.id),original=Initial.openingFundingBaseline(f.e,fleet,autoSignalLine(f.g,f.line.id,f.owner,{preview:true}).cost);
 let approved:ReturnType<typeof Initial.openingFundingAppraisal>|undefined,quoted:any,called=0;
 const result=connectStationThroat(f.g,f.A.id,f.owner,{junctions:true,reserve:fullTarget,signals:signals??undefined,
  approve:(cost,upkeep,finishing)=>{quoted=Initial.openingFundingAppraisal(f.e,original,cost+finishing,.6,f.g.aiOf(f.owner)!.available());approved=quoted.affordable&&Initial.openingThroatReturn(f.g,f.before,f.p,{...f.service,income},cost+finishing,upkeep,quoted.annualInterest)?.pays?quoted:undefined;return!!approved;},
  fund:()=>{called++;if(!approved)return false;return(f.g.aiOf(f.owner)as any).borrowFor(approved.amount)&&f.e.money>=approved.target;}});
 return{result,original,quoted,called};
}
console.log('Native funded geometry, actual interest and refusal boundaries');
const positive=fixture(),normal=autoSignalLine(positive.g,positive.line.id,positive.owner,{preview:true}).cost,original=Initial.openingFundingBaseline(positive.e,fleet,normal),raw=JSON.stringify(positive.e);
const appraisal=Initial.openingFundingAppraisal(positive.e,original,177_490,.6,positive.g.aiOf(1)!.available());
check(appraisal.affordable&&appraisal.incrementalLoan===500_000&&appraisal.annualInterest===20_000&&JSON.stringify(positive.e)===raw,'pure native500k incremental step is priced at actual20k interest versus original normal signalling');
const built=complete(positive);console.log('funded geometry '+JSON.stringify(built));
check(built.result.connected===1&&built.called===1&&positive.e.loan===13_500_000&&built.quoted.incrementalLoan===500_000&&positive.e.money>=fullTarget+(built.result.finishing??0),'native paid diamond uses caller funding after the approved full-stock/finishing quote');
const cliff=fixture();cliff.e.money=fullTarget;const normalQuote=autoSignalLine(cliff.g,cliff.line.id,cliff.owner,{preview:true}).cost;
const withNormal=Initial.openingFundingBaseline(cliff.e,fleet,normalQuote),withoutNormal=Initial.openingFundingBaseline(cliff.e,fleet,0),onlyNormal=Initial.openingFundingAppraisal(cliff.e,withNormal,normalQuote,.6,cliff.g.aiOf(cliff.owner)!.available());
autoSignalLine(cliff.g,cliff.line.id,cliff.owner);(cliff.g.aiOf(cliff.owner)as any).borrowFor(fleet+300_000);
check(normalQuote>0&&cliff.e.loan===withNormal.noRepairLoan&&withNormal.noRepairLoan===withoutNormal.noRepairLoan+500_000&&onlyNormal.incrementalLoan===0,
 'actual ordinary signal payment crosses a native loan step and belongs only to the no-repair baseline');
const retained=Initial.openingFundingAppraisal(positive.e,original,0,.6,positive.g.aiOf(1)!.available());check(retained.incrementalLoan===500_000&&retained.annualInterest===20_000,'a later candidate keeps already borrowed additional debt and its actual interest');
const lowProfit=fixture(),lp= saved(lowProfit),declined=complete(lowProfit,0);check(declined.result.connected===0&&declined.called===0&&saved(lowProfit)===lp,'unprofitable complete opening refuses before any loan or spend');
const capped=fixture();capped.e.maxLoan=13_000_000;const cp=saved(capped),denied=complete(capped);check(denied.result.connected===0&&denied.called===0&&saved(capped)===cp,'credit cap that funds baseline stock but not the complete600k target refuses without partial borrowing');
const appetite=fixture();appetite.e.maxLoan=21_500_000;const ap=saved(appetite),noAppetite=complete(appetite);check(noAppetite.result.connected===0&&noAppetite.called===0&&saved(appetite)===ap,'native appetite refuses optional extra debt while preserving default credit rules');
const oldAsset=fixture(true);oldAsset.g.stations.removeStation(oldAsset.oldStation!.id);const op=saved(oldAsset),badBasis=complete(oldAsset);check(badBasis.result.connected===0&&badBasis.called===0&&saved(oldAsset)===op,'native old-asset removal invalidates the financing baseline before any loan');
const held=fixture(),other=held.g.lines.create('rail',held.owner);other.stops=[held.A.id,held.B.id];held.g.lines.rebuild();const t=held.g.vehicles.buyTrain(held.depot,loco(),other.id)as Train;
if(!(t instanceof Train))throw Error(String(t));t.stopIndex=0;held.g.stepTick();const hp=saved(held),heldResult=complete(held);check(t.onMap&&heldResult.called===0&&heldResult.result.connected===0&&saved(held)===hp,'real native future/body holds refuse the funded opening without a loan');
const rights=fixture(false,true);rights.g.blockCompany(rights.foreign,rights.owner);const rp=saved(rights),noRights=complete(rights);check(noRights.called===0&&noRights.result.connected===0&&saved(rights)===rp,'denied native construction rights refuse before funding');
const works=fixture(),wn=works.g.world.net.nodes.get(endNode(works.g,works.A,0,true))!,wa=works.g.world.net.nearestEdge(wn.x+60,wn.z,1,'rail',e=>e.station<0&&e.depot<0)!;
check(setSignal(works.g,wa.edge.id,wa.s,'oneway',false,works.owner)===null,'native incoming boundary prepares a works possession');const possession=holdThroat(works.g,works.A.id,'front',works.owner,1);
check(possession.some(id=>works.g.vehicles.getRes(id)===WORKS_HOLD),'actual native works hold is present');const wp=saved(works),workResult=complete(works);check(workResult.called===0&&workResult.result.connected===0&&saved(works)===wp,'native WORKS_HOLD refuses any optional funding without clearing the possession');releaseHold(works.g,possession);
// The pure return comparison must pay real interest even after the debt has already been retained.
const quote=Initial.openingThroatReturn(positive.g,positive.before,positive.p,positive.service,0,0,20_000);
const cutoff=quote!.need+positive.service.running+quote!.maintenance+19_999;
check(Initial.openingThroatReturn(positive.g,positive.before,positive.p,{...positive.service,income:cutoff},0,0,20_000)?.pays===false,
 'retained debt interest cannot disappear from a subsequent borderline return appraisal');
console.log(fails.length?`${fails.length} CHECKS FAILED`:'ALL CHECKS PASSED');if(fails.length)process.exitCode=1;
