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
import * as Initial from '../src/game/ai-initial-track';
const fleet=loco().reduce((n,c)=>n+c.cost,0)*2,fullTarget=fleet+600_000;
function nativeOpening(constrained=false){
 const g=Game.create({size:512,seed:61,towns:13,hilliness:'hilly',water:'medium',startYear:1980,aiCompanies:3});g.aiEnabled=false;g.aiAcquisitions=false;
 const ai=g.aiOf(1)!,e=g.company(1).economy,spend=e.spend,borrow=e.borrow,sd=Object.getOwnPropertyDescriptor(e,'spend'),bd=Object.getOwnPropertyDescriptor(e,'borrow');
 const spends:{amount:number;kind:string;cash:number;loan:number;throat:boolean;buy:boolean}[]=[],loans:{before:number;after:number;caller:boolean}[]=[];let injected=false,atExpense=0;
 e.spend=function(...args:Parameters<typeof spend>){const stack=new Error().stack??'',ok=spend.apply(this,args);if(ok)spends.push({amount:args[0],kind:args[1],cash:this.money,loan:this.loan,throat:stack.includes('connectStationThroat'),buy:stack.includes('buyTrain')});return ok;};
 e.borrow=function(){const before=this.loan,stack=new Error().stack??'',ok=borrow.call(this);if(ok)loans.push({before,after:this.loan,caller:stack.includes('connectStationThroat')});return ok;};
 check(!AIController.forceBuild&&ai.startProject('rail',[1,4]),'unchanged native profitable opening begins without forceBuild');
 const project=(ai as any).project;const pd=Object.getOwnPropertyDescriptor(project,'openingLine');let openingLine=project.openingLine;if(constrained)Object.defineProperty(project,'openingLine',{configurable:true,enumerable:true,get:()=>openingLine,set:(value:number)=>{openingLine=value;if(!injected&&e.money>2_821_178.489077144){e.spend(e.money-2_821_178.489077144,'maintenance',true);injected=true;atExpense=e.loan;}}});
 let tick=0;try{for(;tick<400*g.ticksPerDay&&ai.busy;tick++){
  const dayTick=g.tick%g.ticksPerDay;ai.work(dayTick,dayTick+1);
  // The observer above forwards the actual openingLine assignment, then pays a native expense before appraisal.
  g.stepTick();
 }}finally{if(constrained){if(pd)Object.defineProperty(project,'openingLine',pd);else{delete project.openingLine;if(openingLine!==undefined)project.openingLine=openingLine;}}if(sd)Object.defineProperty(e,'spend',sd);else delete(e as any).spend;if(bd)Object.defineProperty(e,'borrow',bd);else delete(e as any).borrow;}
 const line=[...g.lines.map.values()].find(l=>l.owner===1&&l.kind==='rail')!,choices=line?.stops.map((_,i)=>platformChoices(g,line,0,i).length)??[],buys=spends.filter(x=>x.buy),optional=spends.filter(x=>x.throat&&x.loan>atExpense);
 console.log('native opening '+JSON.stringify({constrained,tick,injected,atExpense,loan:e.loan,cash:e.money,choices,loans,throat:spends.filter(x=>x.throat),buys}));
 check(!ai.busy&&choices.length===2&&choices.every(x=>x===2)&&buys.length===2&&checkReservations(g).length===0,'native funded callback completes both legal platforms and purchases the full fleet');
 if(constrained)check(injected&&loans.some(x=>x.caller)&&optional.length===1&&e.loan===atExpense+1_000_000&&e.money>=600_000,
  'complete optional quote funds native steps before construction, accounting for the baseline500k and extra500k debt');
 else check(e.loan===9_000_000&&spends.filter(x=>x.throat).some(x=>x.amount===120260)&&e.money>600_000,
  'ample-cash9M-loan native opening keeps its original loan and priced lead');
 if(constrained){const replay=deserialize(JSON.parse(JSON.stringify(serialize(g))));let exact=true;for(let i=0;i<640;i++){g.stepTick();replay.stepTick();if(JSON.stringify(serialize(g))!==JSON.stringify(serialize(replay))){exact=false;break;}}check(exact&&checkReservations(g).length===0&&checkReservations(replay).length===0,'actual funded railJob has complete640 saved-state/RNG/reservation replay');}
}
console.log('Actual railJob callback and unchanged ample cash');nativeOpening();nativeOpening(true);
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
