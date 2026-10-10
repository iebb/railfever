// Native spare-platform leads must register depot-spur diamonds and preserve every occupied/held resource.
import {flatGame,station,endNode,nodeSnap,build,railOpts,loco,check,fails} from './stationlib';
import {buildDepotOnLine} from '../src/game/routing';
import {connectStationThroat,holdThroat,releaseHold,WORKS_HOLD} from '../src/game/trackops';
import {autoSignalLine,setSignal} from '../src/game/signals';
import {platformChoices} from '../src/game/rail-platforms';
import {Train,findRailRoute,consistRule} from '../src/game/train';
import {Game} from '../src/game/game';
import {AIController} from '../src/game/ai';
import {serialize,deserialize} from '../src/game/save';
import {checkReservations} from './lib';
import {roadOpts} from './lib';
import {addTramTracks,removeTramTracks} from '../src/game/build-ops';
import * as InitialTrack from '../src/game/ai-initial-track';
const openingThroatBaseline = (...args: Parameters<typeof InitialTrack.openingThroatBaseline>) =>
  (InitialTrack as unknown as { openingThroatBaseline?: typeof InitialTrack.openingThroatBaseline }).openingThroatBaseline?.(...args);
const openingThroatReturn = (...args: Parameters<typeof InitialTrack.openingThroatReturn>) =>
  (InitialTrack as unknown as { openingThroatReturn?: typeof InitialTrack.openingThroatReturn }).openingThroatReturn?.(...args);

function railJobCall(expenseBoundary=false){
  const g=Game.create({size:512,seed:61,towns:13,hilliness:'hilly',water:'medium',startYear:1980,aiCompanies:3});
  g.aiEnabled=false;g.aiAcquisitions=false;
  const ai=g.aiOf(1)!,eco=g.company(1).economy,spend=eco.spend,descriptor=Object.getOwnPropertyDescriptor(eco,'spend');
  const events:{amount:number;category:string;cashBefore:number;cashAfter:number;loanBefore:number;loanAfter:number;throat:boolean;vehicle:boolean}[]=[];
  eco.spend=function(...args:Parameters<typeof spend>){
    const stack=new Error().stack??'',cashBefore=this.money,loanBefore=this.loan,accepted=spend.apply(this,args);
    if(accepted&&stack.includes('railPlanJob'))events.push({amount:args[0],category:args[1],cashBefore,cashAfter:this.money,loanBefore,loanAfter:this.loan,throat:stack.includes('connectStationThroat'),vehicle:stack.includes('buyTrain')});
    return accepted;
  };
  check(!AIController.forceBuild&&ai.startProject('rail',[1,4]),'native profitable railJob begins with original company finance and no forceBuild override');
  let tick=0,injected=false,loanAtExpense=0;
  try{for(;tick<400*g.ticksPerDay&&ai.busy;tick++){
    const t0=g.tick%g.ticksPerDay;ai.work(t0,t0+1);
    if(expenseBoundary&&!injected&&events.some(e=>e.throat)&&events.some(e=>e.category==='construction'&&e.amount===9000&&!e.throat)&&!events.some(e=>e.vehicle)){
      const target=2*loco().reduce((n,c)=>n+c.cost,0)+600_000;
      if(eco.money>=target){eco.spend(eco.money-target+1,'maintenance',true);injected=true;loanAtExpense=eco.loan;}
    }
    g.stepTick();
  }}
  finally{if(descriptor)Object.defineProperty(eco,'spend',descriptor);else delete(eco as any).spend;}
  const l=[...g.lines.map.values()].find(l=>l.kind==='rail'&&l.owner===1)!,throat=events.filter(e=>e.throat),buys=events.filter(e=>e.vehicle);
  const choices=l?.stops.map((_,i)=>platformChoices(g,l,0,i).length)??[];
  if(expenseBoundary){
    console.log('  resumed expense boundary '+JSON.stringify({ticks:tick,injected,loanAtExpense,loanAfter:eco.loan,buys:buys.length,logs:ai.log}));
    check(injected&&eco.loan===loanAtExpense&&buys.length===0&&ai.log.some(s=>s.includes('fleet reserve changed before purchase')),
      'ordinary native expense after the signal yield cancels the paid opening before a repair-induced loan or purchase');
    return;
  }
  console.log('  railJob '+JSON.stringify({ticks:tick,day:g.day,choices,throat,buys,diamonds:g.world.net.crossings.size,phase:ai.phase}));
  check(!ai.busy&&!!l&&choices.length===2&&choices.every(n=>n===2),'actual railJob completes both legal receiving/return platform groups before opening');
  check(throat.length===1&&throat[0].amount===120260&&buys.length===2
    &&throat[0].cashAfter>=buys.reduce((n,e)=>n+e.amount,0)+300_000&&throat[0].loanBefore===throat[0].loanAfter,
    'railJob reaches native approved diamond construction, paying once before both purchases with the complete fleet cushion');
  check(g.world.net.crossings.size===1&&checkReservations(g).length===0,
    'the real railJob opening registers its crossing resource and preserves native reservations');
}
console.log('Actual bounded railJob opening call path');railJobCall();
if(process.argv.includes('--railjob-only')){console.log(fails.length?`${fails.length} CHECKS FAILED`:'ALL CHECKS PASSED');process.exit(fails.length?1:0);}
railJobCall(true);

function fixture(foreignSpur=false){
  const g=flatGame(384),me=g.addAICompany({startMoney:100_000_000}).id,foreign=g.addAICompany({startMoney:100_000_000}).id;
  g.aiEnabled=false;g.aiAcquisitions=false;g.vehicles.ambientEnabled=false;
  // User rule (2.10): the starting balance is fully a loan and the credit line only grows to it (maxLoan = balance), so
  // a 100M start has no credit left. Keep 2.9's 20M of credit room (5M loan, 25M line) for the stepped-borrowing checks.
  {const e=g.company(me).economy;e.maxLoan=e.loan+20_000_000;}
  const A=station(g,30,192,Math.PI/2,10,2,me)!,B=station(g,350,192,Math.PI/2,10,2,me)!;
  build(g,nodeSnap(g,endNode(g,A,0,true),'rail'),nodeSnap(g,endNode(g,B,0,false),'rail'),railOpts(me),'single main');
  const n=g.world.net.nodes.get(endNode(g,A,0,true))!,hit=g.world.net.nearestEdge(n.x+3,n.z,1,'rail',e=>e.station<0&&e.depot<0)!;
  const depot=buildDepotOnLine(g,hit.edge.id,hit.s,foreignSpur?foreign:me,{dir:-1,side:-1});
  check(depot>=0,'native owned depot spur is built beside the unused platform');
  const mainNode=endNode(g,A,0,true),adj=g.world.net.nodes.get(mainNode)!.edges.find(id=>g.world.net.edges.get(id)!.station<0)!,first=g.world.net.edges.get(adj)!,junction=first.a===mainNode?first.b:first.a;
  const spur=g.world.net.nodes.get(junction)!.edges.map(id=>g.world.net.edges.get(id)!).find(e=>e.id!==adj&&Math.abs(g.world.net.nodes.get(e.a)!.z-g.world.net.nodes.get(e.b)!.z)>.2)!;
  connectStationThroat(g,B.id,me);
  const l=g.lines.create('rail',me);l.stops=[A.id,B.id];g.lines.rebuild();
  return{g,me,foreign,A,B,l,depot,spur:spur.id};
}
const fullState=(g:ReturnType<typeof flatGame>)=>JSON.stringify({save:serialize(g),reservations:[...(g.vehicles as any).res]});
const reserve=2*loco().reduce((n,c)=>n+c.cost,0)+300_000;
const signalsFor=(f: ReturnType<typeof fixture>)=>(InitialTrack as unknown as {openingSignalPlan?:typeof InitialTrack.openingSignalPlan}).openingSignalPlan?.(f.g,f.l,f.depot,loco(),f.A.id);

console.log('Supported stock, full return and signal-bound prerequisites');
const wrongReturn=fixture(),blocked=wrongReturn.g.world.net.nearestEdge(320,192.49,1,'rail',e=>e.station<0&&e.depot<0)!;
check(setSignal(wrongReturn.g,blocked.edge.id,blocked.s,'oneway',true,wrongReturn.me)===null,'native one-way approach admits arrival but denies the terminal return');
const prefix=findRailRoute(wrongReturn.g,[{edge:wrongReturn.g.world.net.edges.get(wrongReturn.g.depots.get(wrongReturn.depot)!.edge)!,dir:1}],wrongReturn.A.id,wrongReturn.me,-1,60000,false,consistRule(loco()),true,
  {length:loco().reduce((n,c)=>n+c.length+.1,0),onward:wrongReturn.B.id});
const returnBefore=fullState(wrongReturn.g);
check(!!prefix&&signalsFor(wrongReturn)===null&&fullState(wrongReturn.g)===returnBefore,
  'actual first+next-arrival prefix passes, while full-body second return refuses the paid optional repair purely');
const tooWide=fixture();tooWide.l.stops=[tooWide.A.id,tooWide.B.id,tooWide.A.id];tooWide.g.lines.rebuild();
const wideBefore=fullState(tooWide.g);
check(signalsFor(tooWide)===null&&fullState(tooWide.g)===wideBefore,'a multi-call itinerary is excluded without a speculative remaining-stock proof');


console.log('Native depot-spur obstruction and paid registered diamond');
const f=fixture(),raw=JSON.stringify(serialize(f.g)),old=deserialize(JSON.parse(raw)),oldA=old.stations.get(f.A.id)!;
const unchanged=connectStationThroat(old,oldA.id,f.me);
check(unchanged.connected===0&&platformChoices(old,old.lines.get(f.l.id)!,0,0).length===1,
  'original native throat refuses the spur crossing and leaves one usable receiving platform');
const money=f.g.company(f.me).economy.money,loan=f.g.company(f.me).economy.loan,book=f.g.company(f.me).economy.current.construction;
let quoted=0,quotedUpkeep=0;
const completed=connectStationThroat(f.g,f.A.id,f.me,{junctions:true,reserve,signals:signalsFor(f),approve:(cost,upkeep)=>{quoted=cost;quotedUpkeep=upkeep;return true;}});
console.log(`  completion ${JSON.stringify(completed)}, quote${quoted}, upkeep${quotedUpkeep}`);
check(completed.connected===1&&completed.cost===quoted&&quoted>0&&quotedUpkeep>0,
  'existing native junction mode completes one priced lead');
check(money-f.g.company(f.me).economy.money===quoted&&book-f.g.company(f.me).economy.current.construction===quoted
  &&f.g.company(f.me).economy.loan===loan&&f.g.company(f.me).economy.money>=reserve,
  'actual construction ledger pays the quote once and preserves both trains plus cushion without new debt');
const diamonds=[...f.g.world.net.crossings.values()].filter(c=>c.kind==='diamond');
check(diamonds.length===1&&(diamonds[0].e1===f.spur||diamonds[0].e2===f.spur),
  'the crossed physical depot spur receives its native diamond reservation resource');
const exactFinish=signalsFor(f)!;
check(exactFinish.cost<=completed.finishing!&&f.g.company(f.me).economy.money>=reserve+exactFinish.cost,
  'exact native post-repair signal quote fits the approved completion bound and retained fleet cushion');
const appliedFinish=autoSignalLine(f.g,[...exactFinish.edges],f.me);
check(appliedFinish.placed===exactFinish.plan.placed&&appliedFinish.changed===exactFinish.plan.changed
  &&appliedFinish.warnings.every(w=>exactFinish.plan.warnings.includes(w)),
  'native signal application matches additions, reorientations and preview warnings');
old.lines.rebuild();autoSignalLine(old,f.l.id,f.me);f.g.lines.rebuild();
check(platformChoices(f.g,f.l,0,0).length===2&&platformChoices(f.g,f.l,0,1).length===2,
  'all receiving platforms have native full-fit incoming and return routes after ordinary signalling');

console.log('Denied rights, budget and native future/physical/works holds');
const denied=fixture(true);denied.g.blockCompany(denied.foreign,denied.me);
const deniedBefore=fullState(denied.g),noRights=connectStationThroat(denied.g,denied.A.id,denied.me,{junctions:true,reserve,signals:signalsFor(denied)});
check(noRights.connected===0&&fullState(denied.g)===deniedBefore,'denied crossed-spur upgrade rights preserve complete state, finance and native holds');
const poor=fixture();poor.g.company(poor.me).economy.money=reserve+1;
const poorBefore=fullState(poor.g),noBudget=connectStationThroat(poor.g,poor.A.id,poor.me,{junctions:true,reserve,signals:signalsFor(poor)});
check(noBudget.connected===0&&fullState(poor.g)===poorBefore,'inadequate spendable cash refuses without consuming fleet money or borrowing');
const boundary=fixture(),nativeTarget=reserve+300_000;boundary.g.company(boundary.me).economy.money=nativeTarget+quoted-1;
const boundaryState=JSON.stringify(serialize(boundary.g)),without=deserialize(JSON.parse(boundaryState)),oldReserve=deserialize(JSON.parse(boundaryState));
const baselineLoan=without.company(boundary.me).economy.loan;autoSignalLine(without,boundary.l.id,boundary.me);(without.aiOf(boundary.me)as any).borrowFor(reserve);
check(without.company(boundary.me).economy.loan===baselineLoan,'ordinary native funding does not borrow at the measured boundary without optional repair');
const oldPlan=(InitialTrack as any).openingSignalPlan?.(oldReserve,oldReserve.lines.get(boundary.l.id),boundary.depot,loco(),boundary.A.id);
const consumed=connectStationThroat(oldReserve,boundary.A.id,boundary.me,{junctions:true,reserve,signals:oldPlan});
if(consumed.connected){const finish=(InitialTrack as any).openingSignalPlan(oldReserve,oldReserve.lines.get(boundary.l.id),boundary.depot,loco(),boundary.A.id);autoSignalLine(oldReserve,[...finish.edges],boundary.me);}
(oldReserve.aiOf(boundary.me)as any).borrowFor(reserve);
check(consumed.connected===1&&oldReserve.company(boundary.me).economy.loan>baselineLoan,
  'the former300k-only optional reserve induces actual native stepped borrowing after signal completion');
const boundaryBefore=fullState(boundary.g),safeBoundary=connectStationThroat(boundary.g,boundary.A.id,boundary.me,{junctions:true,reserve:nativeTarget,signals:signalsFor(boundary)});
check(safeBoundary.connected===0&&fullState(boundary.g)===boundaryBefore,'the actual native600k funding target refuses optional repair before any mutation');
autoSignalLine(boundary.g,boundary.l.id,boundary.me);(boundary.g.aiOf(boundary.me)as any).borrowFor(reserve);
check(boundary.g.company(boundary.me).economy.loan===baselineLoan,'declined repair preserves ordinary opening funding without repair-induced debt');
const roi=fixture(),roiBasis=openingThroatBaseline(roi.g,roi.me),roiBefore=fullState(roi.g),noReturn=connectStationThroat(roi.g,roi.A.id,roi.me,{junctions:true,reserve,signals:signalsFor(roi),
  approve:(cost,upkeep)=>openingThroatReturn(roi.g,roiBasis,{edges:[],stations:[],depots:[]},
    {total:reserve+500_000,fleet:reserve-300_000,income:0,running:100_000,maintenance:50_000,wear:1000,amortisation:.04},cost,upkeep)?.pays===true});
check(noReturn.connected===0&&fullState(roi.g)===roiBefore,'a declined actual construction/upkeep return preserves the full native state');
const held=fixture();autoSignalLine(held.g,held.l.id,held.me);
const otherLine=held.g.lines.create('rail',held.me);otherLine.stops=[held.A.id,held.B.id];held.g.lines.rebuild();
const t=held.g.vehicles.buyTrain(held.depot,loco(),otherLine.id) as Train;t.stopIndex=0;held.g.stepTick();
check(t.onMap&&held.g.vehicles.getRes(held.spur)===t.id&&!t.occupiedEdges().includes(held.spur),
  'actual departing train holds the crossed spur ahead of its body');
const futureBefore=fullState(held.g),future=connectStationThroat(held.g,held.A.id,held.me,{junctions:true,reserve,signals:signalsFor(held)});
check(future.connected===0&&fullState(held.g)===futureBefore,'native reserved future crossed-spur path defers before spending or geometry edits');
for(let tick=0;tick<600&&!t.occupiedEdges().includes(held.spur);tick++)held.g.stepTick();
check(t.occupiedEdges().includes(held.spur),'native body reaches the physical crossed spur');
const busyBefore=fullState(held.g),busy=connectStationThroat(held.g,held.A.id,held.me,{junctions:true,reserve,signals:signalsFor(held)});
check(busy.connected===0&&fullState(held.g)===busyBefore,'actual crossed-spur body defers with all train/routes/reservations intact');
for(let tick=0;tick<1000&&t.state!=='loading';tick++)held.g.stepTick();
check(t.state==='loading'&&t.occupiedEdges().every(id=>held.g.world.net.edges.get(id)?.station===held.A.id),
  'native train has arrived fully within the existing receiving platform');
const platformBefore=fullState(held.g),platform=connectStationThroat(held.g,held.A.id,held.me,{junctions:true,reserve,signals:signalsFor(held)});
check(platform.connected===0&&fullState(held.g)===platformBefore,'an occupied adjacent platform protects its native receiving and reversal resources');
const works=fixture(),n=works.g.world.net.nodes.get(endNode(works.g,works.A,0,true))!,at=works.g.world.net.nearestEdge(n.x+60,n.z,1,'rail',e=>e.station<0&&e.depot<0)!;
check(setSignal(works.g,at.edge.id,at.s,'oneway',false,works.me)===null,'native incoming one-way boundary is prepared for a works possession');
const possession=holdThroat(works.g,works.A.id,'front',works.me,1);
check(possession.length>0&&possession.some(id=>works.g.vehicles.getRes(id)===WORKS_HOLD),'native holdThroat creates an actual protected works reservation');
const signalNode=[...works.g.world.net.nodes.values()].find(n=>n.signal>=2)!;
const signalEdge=works.g.world.net.edges.get(signalNode.edges[0])!;
check(setSignal(works.g,signalEdge.id,signalEdge.a===signalNode.id?0:signalEdge.len,'twoway',true,works.me)===null,
  'native possession remains held while the fixture restores its lawful two-way service');
const worksBefore=fullState(works.g),working=connectStationThroat(works.g,works.A.id,works.me,{junctions:true,reserve,signals:signalsFor(works)});
check(working.connected===0&&fullState(works.g)===worksBefore,'WORKS_HOLD on the actual approach is retained and defers construction');
releaseHold(works.g,possession);
check(connectStationThroat(works.g,works.A.id,works.me,{junctions:true,reserve,signals:signalsFor(works)}).connected===1,'normal release of native works holds permits the same affordable completion');
const circular=fixture(),circleMain=circular.g.world.net.nearestEdge(180,192.49,1,'rail',e=>e.station<0&&e.depot<0)!;
const split=circular.g.world.net.splitEdge(circleMain.edge.id,circleMain.s)!;const cn=split.node;
circular.g.world.net.addEdge('rail',cn.id,cn.id,{x0:cn.x,z0:cn.z,x1:cn.x+45,z1:cn.z-50,x2:cn.x-45,z2:cn.z-50,x3:cn.x,z3:cn.z},new Float32Array(400).fill(3),[],'standard',circular.me);
circular.g.onNetworkChanged();
const circleBefore=fullState(circular.g);
check(signalsFor(circular)===null&&connectStationThroat(circular.g,circular.A.id,circular.me,{junctions:true,reserve,signals:signalsFor(circular)}).connected===0
  &&fullState(circular.g)===circleBefore,'native circular plain chain refuses the local signal bound without state or finance mutation');

console.log('Native opening books, year rollover and unrelated refunds');
const finances=fixture(),basis=openingThroatBaseline(finances.g,finances.me),eco=finances.g.company(finances.me).economy;
const service={total:3_000_000,fleet:reserve-300_000,income:1_000_000,running:200_000,maintenance:0,wear:1000,amortisation:.04};
const emptyProject={edges:[] as number[],stations:[] as number[],depots:[] as number[]};
const financeBefore=fullState(finances.g),baseQuote=openingThroatReturn(finances.g,basis,emptyProject,service,50_000,1000);
check(baseQuote?.capital===service.total&&fullState(finances.g)===financeBefore,
  'the native quoted depot/throat allowance is not charged twice by read-only repricing');
const nextEdge=finances.g.world.net.nextEdge;
build(finances.g,{kind:'free',x:160,z:40,y:3},{kind:'free',x:230,z:40,y:3},railOpts(finances.me),'independent paid rail');
const project={edges:[...finances.g.world.net.edges.keys()].filter(id=>id>=nextEdge),stations:[] as number[],depots:[] as number[]};
const paid=(basis?.construction??NaN)-eco.thisYear.construction,actualUpkeep=project.edges.reduce((n,id)=>n+finances.g.edgeMaintenance(finances.g.world.net.edges.get(id)!),0);
const paidQuote=openingThroatReturn(finances.g,basis,project,service,50_000,1000);
check(paidQuote?.paid===paid&&paidQuote.capital>=paid+service.fleet+50_000&&paidQuote.maintenance>=actualUpkeep+service.wear+1000,
  'native construction books and explicit new-asset upkeep reprice the finished formation conservatively');
build(finances.g,{kind:'free',x:260,z:40,y:3},{kind:'free',x:300,z:40,y:3},railOpts(finances.me),'unrelated paid rail');
const conservativePaid=(basis?.construction??NaN)-eco.thisYear.construction,unrelatedQuote=openingThroatReturn(finances.g,basis,project,service,50_000,1000);
check(unrelatedQuote?.paid===conservativePaid&&conservativePaid>paid&&unrelatedQuote.capital>=paidQuote!.capital,
  'unrelated native expense is conservatively included rather than claimed as exact project attribution');
const startYear=finances.g.year;
for(let tick=0;tick<361*finances.g.ticksPerDay&&finances.g.year===startYear;tick++)finances.g.stepTick();
const rolled=openingThroatReturn(finances.g,basis,project,service,50_000,1000);
check(finances.g.year===startYear+1&&rolled?.paid===conservativePaid,
  'ordinary native year rollover retains the actual opening construction delta without month double counting');
const quoteBeforeRefund=fullState(finances.g);
check(openingThroatReturn(finances.g,basis,project,service,50_000,1000)!==null&&fullState(finances.g)===quoteBeforeRefund,
  'warm rolled-year repricing preserves complete finance, native state and RNG');
finances.g.stations.removeStation(finances.B.id);eco.spend(-200_000,'construction',true);
check(openingThroatReturn(finances.g,basis,project,service,50_000,1000)===null,
  'unrelated old-asset removal/refund invalidates the baseline and cannot subsidise new capital or upkeep');
const refundOnly=fixture(),refundBasis=openingThroatBaseline(refundOnly.g,refundOnly.me);
refundOnly.g.company(refundOnly.me).economy.spend(-1,'construction',true);
check(openingThroatReturn(refundOnly.g,refundBasis,emptyProject,service,50_000,1000)===null,
  'unattributed net construction refund refuses repricing without a valid paid-formation baseline');
const overlay=fixture(),roadStart=overlay.g.world.net.nextEdge;
build(overlay.g,{kind:'free',x:30,z:60,y:3},{kind:'free',x:300,z:60,y:3},roadOpts(0),'public road for owned tram overlay');
const roadIDs=[...overlay.g.world.net.edges.keys()].filter(id=>id>=roadStart);
check(!addTramTracks(overlay.g,roadIDs,overlay.me).error,'native tram overlay is owned by the railway company on public road title');
const overlayBasis=openingThroatBaseline(overlay.g,overlay.me),openingRoadStart=overlay.g.world.net.nextEdge;
build(overlay.g,{kind:'free',x:30,z:100,y:3},{kind:'free',x:170,z:100,y:3},roadOpts(overlay.me),'new paid access road');
const accessUpkeep=[...overlay.g.world.net.edges.values()].filter(e=>e.id>=openingRoadStart).reduce((n,e)=>n+overlay.g.edgeMaintenance(e),0);
const beforeRemoval=openingThroatReturn(overlay.g,overlayBasis,emptyProject,service,50_000,1000);
check(!!beforeRemoval&&beforeRemoval.capital>service.total&&beforeRemoval.maintenance>=accessUpkeep+service.wear+1000,
  'native new access expenses exceed the original allowance and carry actual upkeep even outside project edge tracking');
const removalMoney=overlay.g.company(overlay.me).economy.money,maintBeforeRemoval=overlay.g.maintenanceOf(overlay.me);
check(!removeTramTracks(overlay.g,roadIDs,overlay.me).error
  &&overlay.g.company(overlay.me).economy.money<removalMoney&&overlay.g.maintenanceOf(overlay.me)<maintBeforeRemoval,
  'native overlay removal charges capital while lowering old owned-overlay upkeep');
const overlayState=fullState(overlay.g);
const overlayAfter=openingThroatReturn(overlay.g,overlayBasis,emptyProject,service,50_000,1000);
console.log(`  overlay accessUpkeep${accessUpkeep} before${JSON.stringify(beforeRemoval)} after${JSON.stringify(overlayAfter)}`);
check(overlayAfter===null&&fullState(overlay.g)===overlayState,
  'old owned overlay changes invalidate repricing on public road title and cannot subsidise new access upkeep');

console.log('Native paid service and complete fixed-step replay');
function operate(g:typeof f.g){
  const l=g.lines.get(f.l.id)!,trains:Train[]=[];for(let i=0;i<2;i++){const t=g.vehicles.buyTrain(f.depot,loco(),l.id);if(!(t instanceof Train))throw new Error(String(t));t.stopIndex=0;trains.push(t);}
  let waiting=0,noroute=0,max=0;const groups=new Set<number>();
  for(let tick=0;tick<240*g.ticksPerDay;tick++){
    for(const sid of l.stops){const st=g.stations.get(sid)!,dest=l.stops.find(q=>q!==sid)!;g.stations.addWaiting(st,l.id,dest,dest,Math.max(0,20-st.waitingTotal));}
    g.stepTick();for(const t of trains){waiting+=Number(t.state==='waiting');noroute+=Number(t.state==='noroute');max=Math.max(max,t.stuckTime);if(t.state==='loading'&&t.atStation===f.A.id)groups.add(t.segs[t.headSeg].e);}
  }
  return{waiting,noroute,max,groups:[...groups],delivered:trains.reduce((n,t)=>n+t.delivered,0)};
}
const oldOps=operate(old),fixedOps=operate(f.g);console.log('  old '+JSON.stringify(oldOps)+' fixed '+JSON.stringify(fixedOps));
check(fixedOps.noroute===0&&fixedOps.delivered>0&&fixedOps.waiting<oldOps.waiting,
  'native full-loop service delivers paid passengers with fewer actual waiting ticks than the obstructed preimage');
check(checkReservations(f.g).length===0&&checkReservations(old).length===0,'both operating variants retain lawful native reservations');
const replay=deserialize(JSON.parse(JSON.stringify(serialize(f.g))));let exact=true;
for(let tick=0;tick<640;tick++){f.g.stepTick();replay.stepTick();if(JSON.stringify(serialize(f.g))!==JSON.stringify(serialize(replay))){exact=false;break;}}
check(exact&&checkReservations(f.g).length===0&&checkReservations(replay).length===0,'complete640 native saves/RNG replay exactly after paid diamond operation');
console.log(fails.length?`${fails.length} CHECKS FAILED`:'ALL CHECKS PASSED');process.exitCode=fails.length?1:0;
