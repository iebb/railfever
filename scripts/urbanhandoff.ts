// Selection passes a numerical city layout, never stale native plans/prices. Construction rechecks
// sites, entrances, links, yard, ownership, fleet and returns; saved handoff/stages replay every tick.
// chooseProject's older unsaved evaluator is deliberately outside this replay contract.
// Bundle as urbanhandoff.mjs and run with Node.
import {Game} from '../src/game/game';
import {serialize,deserialize} from '../src/game/save';
import {railPartMode} from '../src/game/stations';
import {TRACK_TYPES} from '../src/game/constants';
import {check,done} from './stationlib';
const g=Game.create({size:640,seed:21,towns:14,hilliness:'flat',water:'low',startYear:1990,
  aiConfigs:[{startMoney:60_000_000,focus:{rail:.2,road:0,tram:3}}]});g.aiAcquisitions=false;
const a:any=g.ais[0];
let sawChooser=false;
while(g.day<650&&!a.project?.urbanLayout){g.stepTick();sawChooser||=a.state.phase==='evaluating projects';}
check(sawChooser&&!!a.project?.urbanLayout,'ordinary native chooser selects a city-layout handoff');
if(!a.project?.urbanLayout){done();process.exit(1);}
const hint=a.project.urbanLayout,selected=JSON.stringify(serialize(g)),at=g.day;
console.log(`  native ${a.project.kind} handoff ${g.towns.list[a.project.towns[0]].name} day${at}: ${hint.targets.length} stops`);
check(a.project.kind==='lightrail'&&a.project.towns[0]===1,'native selected cohort is Dorminster light rail');
check(!('quote' in hint)&&!('plans' in hint)&&hint.interchanges.every((id:unknown)=>typeof id==='number'),'handoff stores layout/IDs, without old price or station plans');
check(!a.urbanTask&&!a.urbanSurvey&&a.project.stations.length===0,'selected handoff is saved before construction work');
let twin=deserialize(JSON.parse(selected));
check(JSON.stringify(serialize(twin))===selected,'selected handoff immediate full roundtrip');
function replay(label:string){let exact=true;for(let i=0;i<640;i++){g.stepTick();twin.stepTick();if(JSON.stringify(serialize(g))!==JSON.stringify(serialize(twin)))exact=false;}check(exact,label+' full state is exact at every one of640 ticks');}
replay('selected handoff');
while(g.day<at+120&&!(a.project?.stations.length>0))g.stepTick();
check(!!a.urbanTask?.fromHandoff&&a.project?.stations.length>0,'handoff reaches actual native station construction');
const during=JSON.stringify(serialize(g));twin=deserialize(JSON.parse(during));
check(JSON.stringify(serialize(twin))===during,'native partial construction immediate full roundtrip');
replay('partial construction');
while(g.day<at+160&&!a.stats.urban)g.stepTick();
const line=g.lines.all().find(l=>l.kind==='rail'&&l.owner===a.companyId&&l.stops.every(id=>{const s=g.stations.get(id);return s?.townId===1&&s.rail&&railPartMode(s.rail)==='lightrail';}));
check(!!line&&line.vehicles.length>0&&a.stats.urban===1,'native handoff completes and buys its funded fleet');
while(g.day<at+180&&line&&!line.vehicles.some(id=>g.vehicles.map.get(id)?.opLastSt>=0))g.stepTick();
check(!!line&&line.vehicles.some(id=>(g.vehicles.map.get(id)?.opLastSt??-1)>=0),'native dispatch makes actual station calls');
console.log(`  opens/runs day${g.day}; ${line?.vehicles.length??0} actual trains; money${Math.round(a.eco.money)} loan${a.eco.loan}`);

// Stale ownership/removed-interchange hints use the same ordinary full survey, before any spend.
{
 const h=deserialize(JSON.parse(selected)),b:any=h.ais[0],p=b.project;
 p.urbanLayout.interchanges=[Number.MAX_SAFE_INTEGER];h.stepTick();
 while(h.day<at+1&&!b.urbanSurvey)h.stepTick();
 check(!!b.urbanSurvey&&!b.urbanTask&&p.stations.length===0,'missing native interchange rejects stale hint and starts full saved survey');
 const hh={...hint,interchanges:[...g.stations.map.values()].find(s=>!!s.rail)?.id===undefined?[]:[...g.stations.map.values()].filter(s=>!!s.rail).slice(0,1).map(s=>s.id)};
 const st=hh.interchanges.length?g.stations.get(hh.interchanges[0]):undefined;
 if(st){const owner=st.owner;st.owner=15;try{check(a.urbanHandoffLayout(hh,5)===null,'foreign inaccessible interchange cannot validate a saved handoff');}finally{st.owner=owner;}}
}
// Changed streets/lots/network are read by new native site plans. Compare their full results with
// a fresh planner at the same edited world, retaining the numerical candidate and every native check.
{
 const h=deserialize(JSON.parse(selected)),b:any=h.ais[0],p=b.project;
 const oldPlan=h.stations.planRail.bind(h.stations),seen:any[]=[];
 (h.stations as any).planRail=(...args:any[])=>{
  const before=JSON.stringify(serialize(h)),fresh=oldPlan(...args as Parameters<typeof oldPlan>);
  const cold=[...args];cold[6]={...args[6],aiSurvey:false};
  const control=oldPlan(...cold as Parameters<typeof oldPlan>);
  // Early native rejections may omit unused billing work; every valid full quote must match.
  seen.push(fresh.ok===control.ok&&(fresh.ok?JSON.stringify(fresh)===JSON.stringify(control):fresh.error===control.error)
    &&JSON.stringify(serialize(h))===before);
  return fresh;
 };
 const n=h.world.net,x=hint.x,z=hint.z,na=n.addNode('road',x-12,h.world.heightAt(x-12,z),z,0,0,-1),nb=n.addNode('road',x+12,h.world.heightAt(x+12,z),z,0,0,-1);
 // This is a real native road edit across the quoted centre, not a stale cached plan.
 const {bezLine}=await import('../src/game/geom');n.addEdge('road',na.id,nb.id,bezLine(x-12,z,x+12,z),new Float32Array(25).fill(h.world.heightAt(x,z)),[],'street',-1);
 h.networkVersion++;
 const lot=[...h.world.buildings.values()].find(v=>Math.hypot(v.x-x,v.z-z)<20);
 if(lot){lot.floors++;h.world.lotVersions.bump([lot.x-1,lot.z-1,lot.x+1,lot.z+1]);}
 while(h.day<at+12&&!seen.length)h.stepTick();
 check(seen.length>0&&seen.every(Boolean),'edited street/lot/network valid quotes and rejected eligibility/reasons retain native cold purity/parity');
 check(!!b.urbanTask?.fromHandoff&&p.stations.length===0,'changed geometry is planned again before construction spends');
}
// A changed native rail price cannot commit yesterday's bill; losing/no-funds trials fallback once.
{
 const h=deserialize(JSON.parse(selected)),b:any=h.ais[0],before={stations:[...h.stations.map.values()].filter(s=>s.rail&&s.owner===b.companyId).length,edges:[...h.world.net.edges.values()].filter(e=>e.kind==='rail'&&e.owner===b.companyId).length,depots:[...h.depots.map.values()].filter(d=>d.kind==='rail'&&d.owner===b.companyId).length},nativeCost=TRACK_TYPES.standard.costPerUnit;
 TRACK_TYPES.standard.costPerUnit=nativeCost*100;
 let fallback=false;
 try{while(h.day<at+720&&b.project){h.stepTick();fallback||=!!b.urbanSurvey;}}
 finally{TRACK_TYPES.standard.costPerUnit=nativeCost;}
 check(fallback,'new native price rejects the handoff and retries ordinary survey');
 check([...h.world.net.edges.values()].filter(e=>e.kind==='rail'&&e.owner===b.companyId).length===before.edges&&[...h.depots.map.values()].filter(d=>d.kind==='rail'&&d.owner===b.companyId).length===before.depots&&[...h.stations.map.values()].filter(s=>s.rail&&s.owner===b.companyId).length===before.stations,'unaffordable changed-price proposal creates no rail assets');
}
{
 const h=deserialize(JSON.parse(selected)),b:any=h.ais[0];b.eco.money=0;b.eco.loan=b.eco.maxLoan;
 const own=()=>({stations:[...h.stations.map.values()].filter(s=>s.rail&&s.owner===b.companyId).length,edges:[...h.world.net.edges.values()].filter(e=>e.kind==='rail'&&e.owner===b.companyId).length,depots:[...h.depots.map.values()].filter(d=>d.kind==='rail'&&d.owner===b.companyId).length});
 const before=JSON.stringify(own()),loan=b.eco.loan;let fallback=false;
 while(h.day<at+720&&b.project){h.stepTick();fallback||=!!b.urbanSurvey;}
 check(fallback&&JSON.stringify(own())===before&&b.eco.loan<=loan,'lost funding rejects/reforecasts without rail construction assets or new borrowing');
}
// Replacing/removing a station during a suspended native railway job must abandon cleanly.
for(const change of ['part','identity','owner'] as const){
 const h=deserialize(JSON.parse(JSON.stringify(serialize(g)))),b:any=h.ais[0];b.cancelJob();
 const hub=[...h.stations.map.values()].find(s=>s.owner===b.companyId&&!!s.rail)!;
 check(!!hub&&b.startProject('rail',[hub.townId,2],hub.id),'native suspended hub fixture starts '+change);
 const job=b.job;let threw=false;
 try{
  check(!job.next().done,'native hub job yields before spending '+change);
  const funds=b.eco.money,loan=b.eco.loan,rail=hub.rail,owner=hub.owner;
  if(change==='part')hub.rail=null;
  if(change==='identity')h.stations.map.set(hub.id,{...hub});
  if(change==='owner')hub.owner=0;
  check(job.next().done,'changed suspended hub abandons ordinary job '+change);
  check(b.eco.money===funds&&b.eco.loan===loan,'changed suspended hub spends/borrows nothing '+change);
  check(!b.errorLogged&&b.log.some((s:string)=>s.includes('station or track access changed')),'changed suspended hub is a native rejection without AI exception '+change);
  hub.rail=rail;hub.owner=owner;h.stations.map.set(hub.id,hub);
 }catch(e){threw=true;console.log('  suspended hub exception',change,String(e));}
 check(!threw,'suspended hub never dereferences stale rail '+change);
}
// An actual native mainline hub is also rechecked after the chooser's own suspension.
{
 const h=Game.create({size:640,seed:21,towns:14,hilliness:'flat',water:'low',startYear:1990,
  aiConfigs:[{startMoney:60_000_000,focus:{rail:2,road:.3,tram:1.5}},{startMoney:60_000_000,focus:{rail:2,road:.3,tram:1.5}}]});h.aiAcquisitions=false;
 while(h.day<250)h.stepTick();
 const b:any=h.ais[0];b.cancelJob();const nativeHub=b.hubFor;let retained:any=null;
 b.hubFor=function(...args:any[]){const st=nativeHub.apply(this,args);if(st)retained=st;return st;};
 const chooser=b.chooseProject();let reached=false,threw=false;
 try{for(let i=0;i<4000;i++){const r=chooser.next();if(r.done)break;if(retained){reached=true;break;}}
  if(retained){const rail=retained.rail,funds=b.eco.money,loan=b.eco.loan;retained.rail=null;
   try{chooser.next();}finally{retained.rail=rail;}
   check(b.eco.money===funds&&b.eco.loan===loan,'resumed chooser invalid hub spends/borrows nothing');}
 }catch(e){threw=true;console.log('  suspended chooser exception',String(e));}
 finally{chooser.return(undefined);b.hubFor=nativeHub;}
 check(reached&&!threw,'resumed chooser skips a real native hub whose rail part changed');
}
done();
