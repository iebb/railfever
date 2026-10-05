// Capacity cuts must improve the actual fleet before hypothetical replacements are purchased.
// Optional preserved native checkpoint/control comparison advances only one ordinary saved-world day.
import {readFileSync, writeFileSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
import {flatGame, station, endNode, build, railOpts, nodeSnap, loco, depotFor} from './stationlib';
import {check, fails, checkReservations} from './lib';
import {Train} from '../src/game/train';
import {connectStationThroat} from '../src/game/trackops';
import {sharedCapacityPlan, sharedTrainAllowed, observeRailCapacity} from '../src/game/ai-capacity';
import {serialize, deserialize} from '../src/game/save';

const option=(name:string)=>process.argv.find(a=>a.startsWith('--'+name+'='))?.slice(name.length+3);
const details:any={saved:null,synthetic:null};
const checkpoint=option('checkpoint'),controlPath=option('control-module');
if(checkpoint || controlPath){
  if(!checkpoint || !controlPath)throw new Error('checkpoint comparison needs both --checkpoint and --control-module');
  const control=await import(pathToFileURL(controlPath).href),raw=JSON.parse(readFileSync(checkpoint,'utf8'));
  const old=control.deserialize(JSON.parse(JSON.stringify(raw))),fixed=deserialize(JSON.parse(JSON.stringify(raw)));
  check(JSON.stringify(control.serialize(old))===JSON.stringify(serialize(fixed)), 'old and fixed auction begin from the same native loaded checkpoint');
  const line=Number(option('line')??5),owner=Number(option('owner')??6),a=old.lines.get(line)!,b=fixed.lines.get(line)!;
  if(!a||!b)throw new Error('preserved auction line missing');
  // Existing native demand snapshots may be initialised by the first pricing query; compare warm plans too.
  control.sharedCapacityPlan(old,a);sharedCapacityPlan(fixed,b);
  const oldPlan=control.sharedCapacityPlan(old,a),newPlan=sharedCapacityPlan(fixed,b);
  const positive=oldPlan.withdraw.filter((c:any)=>c.owner===owner&&c.value>0);
  check(positive.length>0, 'preimage auction requests removal of positive actual contribution');
  check(positive.every((c:any)=>!newPlan.withdraw.some(n=>n.train===c.train)), 'positive actual contribution remains without buying any proposed replacement');
  check(newPlan.withdraw.every(c=>c.value < -1e-6), 'every executable saved-state cut has negative actual contribution');
  const stable=JSON.stringify(serialize(fixed)),repeat=sharedCapacityPlan(fixed,b);
  check(JSON.stringify(repeat)===JSON.stringify(newPlan)&&JSON.stringify(serialize(fixed))===stable,
    'warm pricing is stable and preserves the native serialized decision state');
  const sameDayStamp=oldPlan.lines.some((id:number)=>old.lines.get(id)?.capacity?.withdrawn===old.day);
  const decisionState=(g:any,save:any)=>{
    const state=save(g);
    return{tick:g.tick,day:g.day,rng:state.rng,vehicleRng:state.vrng,mail:state.mail,
      fleet:[...g.vehicles.map.values()].filter((t:any)=>t.owner===owner&&t.lineId===line)
        .map((t:any)=>({id:t.id,boughtDay:t.boughtDay,cars:t.cars.map((c:any)=>c.id)})),
      withdrawalDays:oldPlan.lines.map((id:number)=>({line:id,day:g.lines.get(id)?.capacity?.withdrawn})),
      books:state.companies[owner]};
  };
  const before={old:decisionState(old,control.serialize),fixed:decisionState(fixed,serialize)};
  const oldManager=(old.aiOf(owner) as any).manageSharedCapacity.bind(old.aiOf(owner));
  const fixedManager=(fixed.aiOf(owner) as any).manageSharedCapacity.bind(fixed.aiOf(owner));
  const calls:any[]=[];
  for(const[mode,g,plan,manager]of[['old',old,control.sharedCapacityPlan,oldManager],['fixed',fixed,sharedCapacityPlan,fixedManager]]as any[]){
    (g.aiOf(owner)as any).manageSharedCapacity=()=>{
      const quote=plan(g,g.lines.get(line));
      calls.push({mode,day:g.day,tick:g.tick,cuts:quote.withdraw,allocations:quote.allocations});
      return manager();
    };
  }
  const beforeTicks=fixed.tick,beforeDay=fixed.day;
  // This existing checkpoint follows the first sale on day654. Advance one native day so its ordinary
  // one-cut-per-day marker expires; neither the stamp nor prices/clock are manually rewritten.
  for(let tick=0;tick<fixed.ticksPerDay;tick++){old.stepTick();fixed.stepTick();}
  check(positive.some((c:any)=>!old.vehicles.get(c.train)), 'original native auction actually sells the valuable incumbent');
  check(positive.every((c:any)=>fixed.vehicles.get(c.train)), 'fixed native auction retains the valuable incumbent without a replacement purchase');
  check(fixed.tick===beforeTicks+fixed.ticksPerDay&&fixed.day===beforeDay+1,
    'saved auction comparison advances only its approved one native day');
  const after={old:decisionState(old,control.serialize),fixed:decisionState(fixed,serialize)};
  check(after.fixed.fleet.every((t:any)=>before.fixed.fleet.some((b:any)=>b.id===t.id)),
    'saved positive incumbent is retained without purchasing a replacement train');
  details.saved={rawDay:raw.day,loadedDay:fixed.day,line,owner,oldCuts:oldPlan.withdraw,newCuts:newPlan.withdraw,
    oldAllocations:oldPlan.allocations,newAllocations:newPlan.allocations,positiveOriginalContribution:positive,
    sameDayStamp,actualManagerCalls:calls,nativeTicksAdvanced:fixed.tick-beforeTicks,before,after};
  console.log('saved native auction '+JSON.stringify({day:fixed.day,ticks:fixed.tick-beforeTicks,
    positiveOriginalContribution:positive,actualManagerCalls:calls,
    oldFleet:after.old.fleet,fixedFleet:after.fixed.fleet}));
}

// The existing throughcap two-operator fixture and its native report inputs are retained.
function fixture(revenue=12_000_000,trains=2){
  const g=flatGame(256);g.aiEnabled=false;g.vehicles.ambientEnabled=false;
  for(let i=0;i<2;i++)g.addAICompany({startMoney:50_000_000,focus:{rail:3,road:0,tram:0}});
  const A=station(g,20,128,Math.PI/2,10,2,1)!,B=station(g,236,128,Math.PI/2,10,2,2)!;
  build(g,nodeSnap(g,endNode(g,A,0,true),'rail'),nodeSnap(g,endNode(g,B,0,false),'rail'),railOpts(1));
  for(const st of[A,B])connectStationThroat(g,st.id,st.owner);
  const depots=[depotFor(g,A,B,1),depotFor(g,B,A,2)],l=g.lines.create('rail',1);l.stops=[A.id,B.id];g.lines.invite(l.id,2);g.lines.rebuild();
  const ts:Train[]=[];
  for(let i=0;i<trains;i++){const owner=i?2:1,t=g.vehicles.buyTrain(depots[owner-1],loco(),l.id);if(!(t instanceof Train))throw new Error(String(t));ts.push(t);}
  l.incomeLast=revenue;l.passLast=Math.round(revenue/5000/12);observeRailCapacity(g);return{g,l,ts,depots,A,B};
}
const positive=fixture();positive.ts[0].delivered=1000;positive.ts[1].delivered=500;
const positivePlan=sharedCapacityPlan(positive.g,positive.l);
console.log('positive actual incumbent '+JSON.stringify({allocations:positivePlan.allocations,withdraw:positivePlan.withdraw}));
check((positivePlan.allocations.find(a=>a.owner===2)?.trains??0)>=1
  &&!positivePlan.withdraw.some(c=>c.train===positive.ts[1].id),
  'positive actual incumbent is retained before any hypothetical replacement is bought');
check(positivePlan.withdraw.every(c=>c.value < -1e-6),'positive-history fixture never executes a positive-contribution cut');
(positive.g.aiOf(2)as any).manageSharedCapacity();
check(!!positive.g.vehicles.get(positive.ts[1].id),'native auction keeps the positively contributing second operator');
details.positive={allocations:positivePlan.allocations,withdraw:positivePlan.withdraw,retained:!!positive.g.vehicles.get(positive.ts[1].id)};
const f=fixture();
for(let i=0;i<12;i++){
  const plan=sharedCapacityPlan(f.g,f.l),bid=plan.allocations.find(a=>a.trains>f.l.vehicles.filter(id=>f.g.vehicles.get(id)?.owner===a.owner).length);
  if(!bid||!sharedTrainAllowed(f.g,f.l,bid.owner,loco()))break;
  const t=f.g.vehicles.buyTrain(f.ts[bid.owner-1].depotId,loco(),f.l.id);if(!(t instanceof Train))throw new Error(String(t));f.ts.push(t);
}
check(!sharedTrainAllowed(f.g,f.l,2,loco()), 'ordinary positive bids fill the existing shared corridor and decline a further train');
const extra=f.g.vehicles.buyTrain(f.ts[1].depotId,loco(),f.l.id);if(!(extra instanceof Train))throw new Error(String(extra));
f.ts[0].delivered=1000;f.ts[1].delivered=1000;extra.delivered=0;
f.l.capacity!.delay=120;f.l.capacity!.longest=150;
const congested=sharedCapacityPlan(f.g,f.l);
console.log('actual congested fleet '+JSON.stringify({trains:f.l.vehicles.map(id=>{const t=f.g.vehicles.get(id)!;return{id,owner:t.owner,delivered:t.delivered};}),allocations:congested.allocations,withdraw:congested.withdraw}));
check(!!congested.withdraw[0]&&congested.withdraw.every(c=>c.value < -1e-6),
  'the existing congested fixture still prices an executable genuinely negative contribution');
const cold=JSON.stringify(serialize(f.g)),loaded=deserialize(JSON.parse(cold));
check(JSON.stringify(sharedCapacityPlan(loaded,loaded.lines.get(f.l.id)!))===JSON.stringify(congested),
  'cold loaded and warm auction allocations/negative withdrawals agree');
const chosen=congested.withdraw[0];if(chosen)(f.g.aiOf(chosen.owner) as any).manageSharedCapacity();
check(!!chosen&&!f.g.vehicles.get(chosen.train), 'ordinary native auction still executes its actual beneficial congestion cut');
check(!!f.g.vehicles.get(f.ts[0].id), 'the valuable lead is retained; there is no automatic owner-only cut');
const replay=deserialize(JSON.parse(JSON.stringify(serialize(f.g))));
let exact=true;
for(let tick=0;tick<640;tick++){f.g.stepTick();replay.stepTick();if(JSON.stringify(serialize(f.g))!==JSON.stringify(serialize(replay))){exact=false;break;}}
check(exact,'actual-fleet auction replays the complete native state for640 fixed ticks');
check(checkReservations(f.g).length===0&&checkReservations(replay).length===0,'negative withdrawal and replay keep reservations consistent');
details.synthetic={negativeCuts:congested.withdraw,replayExact:exact,reservationErrors:checkReservations(f.g)};
if(option('out'))writeFileSync(option('out')!,JSON.stringify(details,null,2)+'\n');
console.log(fails.length?`${fails.length} CHECKS FAILED`:'ALL CHECKS PASSED');
process.exitCode=fails.length?1:0;
