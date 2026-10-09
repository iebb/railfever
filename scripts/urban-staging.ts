// A smaller paid opening retains a previously selected local heading and reprices all current works.
import { Game } from '../src/game/game';
import { Train } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { bezLine } from '../src/game/geom';
import { check, fails, checkReservations } from './lib';
import { flatGame, station } from './stationlib';
import { readFileSync, writeFileSync } from 'node:fs';
const arg=(name:string)=>process.argv.find(s=>s.startsWith('--'+name+'='))?.split('=').slice(1).join('=');
const saved=(g:Game)=>JSON.stringify(serialize(g));
const snapshot=arg('snapshot'),out=arg('out');
function fixture(config: { startMoney?: number; risk?: number } = {}, mode: 'metro' | 'lightrail' = 'lightrail'){
 const g=Game.create({size:384,seed:5,towns:0,hilliness:'flat',water:'low',startYear:1990,aiConfigs:[{startMoney:40_000_000,...config}]});g.world.h.fill(4);g.world.heightsVersion++;
 const t:any={id:0,name:'Stage Town',x:192,z:192,angle:0,pop:16000,radius:80,buildings:new Set(),nextGrowthDay:1e9,hasChurch:false,passGenMonth:0,passTransMonth:0,passGenLast:0,passTransLast:0,served:0};g.towns.list.push(t);
 const net=g.world.net,road=(x0:number,z0:number,x1:number,z1:number)=>{const a=net.nearestNode(x0,z0,.01,'road')??net.addNode('road',x0,4,z0,0,0,-1),b=net.nearestNode(x1,z1,.01,'road')??net.addNode('road',x1,4,z1,0,0,-1),len=Math.hypot(x1-x0,z1-z0);net.addEdge('road',a.id,b.id,bezLine(x0,z0,x1,z1),new Float32Array(Math.ceil(len)+1).fill(4),[],'street',-1);};
 for(let z=132;z<=252;z+=8)for(let x=148;x<236;x+=8)road(x,z,x+8,z);
 for(let x=148;x<=236;x+=8)for(let z=132;z<252;z+=8)if(!(z<192&&z+8>192))road(x,z,x,z+8);
 const lots:any[]=[];for(let z=132;z<252;z+=8)for(let x=150;x<236;x+=4)if(Math.abs(z-192)>7)lots.push({x,z:z+1.1});
 let remain=t.pop;lots.forEach((p,i)=>{const pop=Math.ceil(remain/(lots.length-i));remain-=pop;const b=g.world.addBuilding({townId:0,...p,angle:Math.PI,w:1.4,d:1.4,type:4,floors:8,pop,seed:i,y:4,built:0});t.buildings.add(b.id);});g.demand.rebuild();
 const ai=g.ais[0]as any;check(ai.startProject(mode,[0]),'native synthetic opening is scheduled');
 // A controlled saved-stage premise: a prior four-stop local survey selected the east-west heading.
 // Current building distribution has a different town axis; no prices or forecasts are carried forward.
 ai.project.urbanHeading={angle:Math.PI/2,stops:4};ai.job=ai.urbanJob(t,mode,3);
 return g;
}
if(!snapshot){
 console.log('Native pending walking-input refresh');
 const h=flatGame(128),net=h.world.net,a=net.addNode('road',20,3,60,0,0,-1),b=net.addNode('road',100,3,60,0,0,-1);
 net.addEdge('road',a.id,b.id,bezLine(20,60,100,60),new Float32Array(81).fill(3),[],'street',-1);
 const sid=h.stations.nextId;check(!h.stations.commitBusStop(60,60,0),'native road stop is paid');
 const house=(x:number,pop:number)=>h.world.addBuilding({townId:-1,x,z:58,angle:0,w:.8,d:.8,type:0,floors:2,pop,seed:1,y:3,built:0});
 const gone=house(58,10);house(64,20);h.stations.refreshAccess(true);h.lines.catchmentDirty=true;h.lines.flushCatchment();
 h.flushNetworkChanges();h.lines.flushCatchment();
 check(!(h as any).networkDirty&&!h.lines.catchmentDirty,'native construction is flushed before the independent lot edit');
 check(h.stations.get(sid)!.catchPop===30,'the original warm native catchment has both buildings');
 h.world.removeBuilding(gone.id);
 const flag=h.lines.catchmentDirty,encoded=saved(h);
 const pending=JSON.parse(encoded);
 check(!flag&&h.stations.catchmentInputsChanged()&&pending.catchmentDirty===flag&&pending.catchmentInputsDirty===true,
  'a native lot edit retains explicit refresh timing and saves owed population work separately');
 check(h.lines.catchmentDirty===flag&&saved(h)===encoded,'serializing pending dependencies does not mutate native flags, cash/books or RNG');
 const restored=deserialize(JSON.parse(encoded));check(saved(restored)===encoded,'pending walking dependencies round-trip exactly');
 h.lines.rebuild();restored.lines.rebuild();h.lines.flushCatchment();restored.lines.flushCatchment();
 console.log('native lot-removal replay',JSON.stringify({original:h.stations.get(sid)!.catchPop,loaded:restored.stations.get(sid)!.catchPop}));
 check(h.stations.get(sid)!.catchPop===20&&restored.stations.get(sid)!.catchPop===20&&saved(h)===saved(restored),
  'the next native refresh gives20 residents in both warm/load cases (original preimage20 versus30)');
 let same=true;for(let tick=0;tick<640;tick++){h.stepTick();restored.stepTick();if(saved(h)!==saved(restored)){same=false;break;}}
 check(same,'pending-input correction continues identically for640 native ticks');
 console.log('Current quote and heading guards');
 const poor=fixture({startMoney:0,risk:0}),pa=poor.ais[0]as any,T=poor.towns.list[0],plans=[166,192,218].map(x=>poor.stations.planRail(x,192,Math.PI/2,7,2,pa.companyId,{trackType:'electric',mode:'lightrail',level:'elevated',height:1.5}));
 const pure=saved(poor),unit=pa.urbanUnit('lightrail',7),quote=pa.urbanEconomics(plans,'lightrail','elevated',[unit],2);
 check(quote.total*1.05>pa.urbanAvailable()&&saved(poor)===pure,'current complete fleet/civil quote refuses native insufficient funds without spending or RNG changes');
 const layout=pa.urbanLayout(T,'lightrail',undefined,3,7),blocked=saved(poor);
 check(!pa.urbanSitePlan(T,{...layout,x:2,z:2},'lightrail',7,Math.PI/2,0,0,'ground')&&saved(poor)===blocked,
  'the retained heading cannot reuse a stale proposal outside actual current clearance');
 const partner=poor.addAICompany({startMoney:40_000_000,accessPolicy:'open'}).id,foreign=station(poor,70,70,Math.PI/2,7,2,partner)!;
 const hint={...layout,interchanges:[foreign.id]};check(!!pa.urbanHandoffLayout(hint,3),'native open partner is accessible before revocation');
 poor.setAccessPolicy(partner,'auto-reject');const revoked=saved(poor);
 check(!pa.urbanHandoffLayout(hint,3)&&saved(poor)===revoked,'current revoked rights reject an old interchange hint purely');
 for(const invalid of [{angle:NaN,stops:4},{angle:.321,stops:Infinity},{angle:.321,stops:3.5},{angle:.321,stops:1}]){
  const guard=fixture(),ga=guard.ais[0]as any;guard.aiEnabled=false;ga.project.urbanHeading=invalid;let n=0;
  while(!ga.urbanTask&&n++<4000){const t0=guard.tick%guard.ticksPerDay;ga.work(t0,t0+1);guard.stepTick();}
  check(!!ga.urbanTask&&ga.urbanTask.candidates.every((c:any)=>Number.isFinite(c.a)&&Math.abs(c.a-.321)>1e-8),
   'malformed heading/count does not append invalid saved geometry to ordinary current candidates');
 }
 const ordinary=fixture(),extra=fixture(),oa=ordinary.ais[0]as any,ea=extra.ais[0]as any;
 ordinary.aiEnabled=extra.aiEnabled=false;oa.project.urbanHeading.stops=3;ea.project.urbanHeading={angle:.321,stops:4};
 for(const h of [ordinary,extra]){const a=h.ais[0]as any;let n=0;while(!a.urbanTask&&n++<4000){const t0=h.tick%h.ticksPerDay;a.work(t0,t0+1);h.stepTick();}}
 const originalCandidates=oa.urbanTask.candidates,extendedCandidates=ea.urbanTask.candidates;
 check(JSON.stringify(extendedCandidates.slice(0,originalCandidates.length))===JSON.stringify(originalCandidates)
  &&extendedCandidates.length>originalCandidates.length&&extendedCandidates.slice(originalCandidates.length).every((c:any)=>Math.abs(c.a-.321)<1e-8),
  'missing retained candidates append after the exact original current-axis search and ordering');
 const metro=fixture({},'metro'),ma=metro.ais[0]as any;metro.aiEnabled=false;let mt=0;
 while(!ma.urbanTask&&mt++<4000){const t0=metro.tick%metro.ticksPerDay;ma.work(t0,t0+1);metro.stepTick();}
 check(!!ma.urbanTask&&ma.urbanTask.candidates.every((c:any)=>Math.abs(c.lat)<=10&&c.lv==='underground'),
  'retained metro headings keep the original0/±5/±10 lateral band and native underground alternatives');
}
let g=snapshot?deserialize(JSON.parse(readFileSync(snapshot,'utf8'))):fixture();
const owner=Number(arg('owner')??1);let ai=g.aiOf(owner)as any;
const town=ai.project?.towns[0],initialCash=ai.eco.money,initialLoan=ai.eco.loan,initialMaintenance=g.maintenanceOf(owner),oldLines=new Set([...g.lines.map.keys()]);
const currentHeading=!snapshot?ai.urbanLayout(g.towns.list[town],'lightrail',undefined,3,7).angle:undefined;
// Isolate this already scheduled native project; all world, passenger, vehicle and accounting ticks still run.
// Both original/fixed controls use the same fixture premise and ordinary 8-work-unit/day native job.
g.aiEnabled=false;
check(ai.project?.kind==='lightrail','the fixture starts with real local urban work');
const payments: { tick: number; category: string; amount: number }[] = [],nativeSpend=ai.eco.spend;
ai.eco.spend=function(amount:number,category:string,force=false){const result=nativeSpend.call(this,amount,category,force);if(result&&(category==='construction'||category==='vehicles'))payments.push({tick:g.tick,category,amount});return result;};
const phases=new Set<string>(),captures:any[]=[];let ticks=0,clone:Game|undefined,exact=true,firstQuote:any;
let firstMismatch: any;
function mismatch(where: string, a: string, b: string) {
 if(firstMismatch)return;
 const differences:any[]=[];
 const visit=(x:any,y:any,path='')=>{if(Object.is(x,y))return;if(x===null||y===null||typeof x!=='object'||typeof y!=='object'){differences.push({path,a:x,b:y});return;}if(Array.isArray(x)&&x.length!==y.length){differences.push({path,aLength:x.length,bLength:y.length});return;}for(const k of new Set([...Object.keys(x),...Object.keys(y)]))visit(x[k],y[k],path+'/'+k);};
 visit(JSON.parse(a),JSON.parse(b));firstMismatch={where,day:g.day,tick:g.tick,differences};console.log('first replay difference',JSON.stringify(firstMismatch));
 if(out){writeFileSync(out+'.original.json',a);writeFileSync(out+'.loaded.json',b);}
}
const step=(game:Game)=>{const a=game.aiOf(owner)as any,t0=game.tick%game.ticksPerDay;a.work(t0,t0+1);game.stepTick();};
while(ai.busy&&ticks++<1200*g.ticksPerDay){
 step(g);if(clone)step(clone);
 const phase=ai.urbanSurvey?'survey':ai.urbanTask?.stage;
 if(phase&&!phases.has(phase)){
  phases.add(phase);const data=saved(g);const loaded=deserialize(JSON.parse(data));
  check(saved(loaded)===data,phase+' saved cursor and numerical heading round-trip exactly');
  if(clone&&saved(clone)!==data){exact=false;mismatch('phase '+phase,data,saved(clone));}
  clone=loaded;captures.push({phase,day:g.day,heading:ai.project?.urbanHeading});
 }
 if(ai.urbanTask?.estimate&&!firstQuote)firstQuote=structuredClone(ai.urbanTask.estimate);
 if(clone&&g.tick%g.ticksPerDay===0&&saved(g)!==saved(clone)){exact=false;mismatch('daily continuation',saved(g),saved(clone));break;}
}
const newLine=[...g.lines.map.values()].find(l=>!oldLines.has(l.id)&&l.owner===owner&&l.kind==='rail'),info=newLine&&ai.lines.get(newLine.id),trains=newLine?.vehicles.map(id=>g.vehicles.get(id)).filter((v):v is Train=>v instanceof Train)??[];
const newMaintenance=g.maintenanceOf(owner)-initialMaintenance,newLoan=ai.eco.loan-initialLoan;
const paid=payments.reduce((sum,p)=>sum+p.amount,0);
console.log('native staged opening',JSON.stringify({snapshot:!!snapshot,ticks,day:g.day,busy:ai.busy,quote:firstQuote&&{total:firstQuote.total,net:firstQuote.net,fleet:firstQuote.fleet},line:newLine?.id,stops:newLine?.stops,trains:trains.map(t=>t.id),cash:ai.eco.money,loan:ai.eco.loan,notes:ai.log.slice(-5),phases:[...phases]}));
check(exact,'saved urban survey/approval/construction phases resume the same native job');
check(!ai.busy&&!!newLine&&trains.length>0,'the affordable repriced smaller stage completes with actually purchased stock');
check(!!firstQuote&&paid<=firstQuote.total*1.05&&trains.length===firstQuote.fleet,
 'actual native construction and purchased opening fleet fit the current approved complete quote');
// The ordinary current-axis family is the axis and its 30/60-degree turns (urbanJob's angles); the retained east-west
// heading (the family's 90-degree turn) is only appended. (User rule, 2.10: with the halved walking reach a 30-degree
// diagonal of the axis catches more of this grid than the axis itself, so the family, not its exact axis, is selected.)
const family=[0,Math.PI/6,-Math.PI/6,Math.PI/3,-Math.PI/3].map(d=>currentHeading!+d);
if(!snapshot)check(!!newLine&&[...new Set(newLine.stops)].every(id=>family.some(a=>Math.abs(g.stations.get(id)!.rail!.angle-a)<1e-8)),
 'a stronger ordinary current-axis family retains its native opening selection');
if(newLine&&trains.length){
 const visits=new Set<number>(),target=g.day+3*360;let noRoute=0;
 while(g.day<target){g.stepTick();for(const t of trains){if(t.state==='loading')visits.add(t.atStation);if(t.onMap&&t.state==='noroute')noRoute++;}}
 const net=newLine.incomeLast-newLine.costLast-newMaintenance-Math.max(0,newLoan)*ai.eco.interestRate;
 console.log('native staged accounts',JSON.stringify({visits:[...visits],delivered:trains.reduce((s,t)=>s+t.delivered,0),income:newLine.incomeLast,cost:newLine.costLast,newMaintenance,newLoan,interest:Math.max(0,newLoan)*ai.eco.interestRate,net,noRoute}));
 check(newLine.stops.every(id=>visits.has(id))&&trains.some(t=>t.delivered>0)&&noRoute===0,'actual stock serves all staged calls/returns and carries paid passengers');
 check(net>0,'actual mature receipts pay operations, incremental infrastructure and borrowing interest');
 const replay=deserialize(JSON.parse(saved(g)));let identical=true;
 for(let tick=0;tick<640;tick++){g.stepTick();replay.stepTick();if(saved(g)!==saved(replay)||checkReservations(g).length||checkReservations(replay).length){identical=false;break;}}
 check(identical,'640 full saved-state/RNG native operation ticks retain lawful reservations');
}
const result={snapshot:!!snapshot,owner,town,initialCash,initialLoan,firstQuote,phases:captures,firstMismatch,payments,paid,exact,ticks,day:g.day,line:newLine?.id,info,finalCash:ai.eco.money,finalLoan:ai.eco.loan,failures:fails};
if(out)writeFileSync(out,JSON.stringify(result,null,2)+'\n');
console.log(fails.length?`${fails.length} CHECKS FAILED`:'ALL CHECKS PASSED');process.exitCode=fails.length?1:0;
