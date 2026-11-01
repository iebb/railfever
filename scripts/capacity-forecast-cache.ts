// Frequency quotes survive movement only; the full auction still refreshes at each fixed tick.
import assert from 'node:assert/strict';
import type { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { Train } from '../src/game/train';
import { sharedCapacityPlan, marginalTrainInvestment, observedCapacityAgreement } from '../src/game/ai-capacity';
import { capacityTopologyKey } from '../src/game/rail-capacity-routes';
import { setPatterns } from '../src/game/patterns';
import { flat, newTown, district, cityLine, M, runDays } from './linegrow-fixtures';
import { checkReservations } from './lib';

let checks=0;
function check(ok:unknown,label:string):asserts ok { assert(ok,label);checks++; }
const saved=(g:Game)=>JSON.stringify(serialize(g));
const cold=(g:Game)=>deserialize(JSON.parse(saved(g)));
// Mirrors the audited semantic inputs, independent of any cache hit or retained quote.
const epoch=(g:Game)=>`${g.day}:${capacityTopologyKey(g)}:${g.lines.version}:${g.demand.version}:`
  +`${g.stations.catchVersion}:${g.world.lotVersions.version}:${g.world.net.roadVersions.version}:${g.world.heightsVersion}:${g.stations.walkVersion}:`
  +g.companies.map(c=>g.accessMultiplier(c.id)).join(',');
let {g,me}=flat(2);
let town=newTown(g,'Timetable',150,200);
district(g,town,48,264,200,32,7000);
let {line,sts,depot}=cityLine(g,me,[80,150,220],200,'west','tail',2);
// Real street-front entrances beside the native forecourts, rather than merely nearby lots.
for(const st of sts){
  const fc=g.stations.forecourt(st)!,near=g.world.net.nearestEdge(fc.x,fc.z,3,'road')!;
  const point={x:0,y:0,z:0};g.world.net.pointAt(near.edge,near.s,point);
  for(const dx of [-.8,0,.8])for(const dz of [1.1,1.9,2.7]){
    const b=g.world.addBuilding({townId:town.id,x:point.x+dx,z:point.z+dz,angle:0,w:.6,d:.6,type:4,floors:8,pop:120,seed:10000+town.buildings.size,y:4,built:0});
    town.buildings.add(b.id);town.pop+=b.pop;
  }
}
g.demand.rebuild();
g.flushNetworkChanges();g.lines.flushCatchment();runDays(g,180);
check(sts.every(s=>s.catchPop>0)&&line.vehicles.some(id=>g.vehicles.get(id)!.delivered>0),'native paid trains serve actual street-connected residents');
const lineId=line.id,cars=[M('lrv_b')];
// Save immediately before an actual native arrival, then exercise that same tick with warm/cold caches.
let reached=false;
for(const v of g.vehicles.map.values()){
  const serve=v.serveStation.bind(v);v.serveStation=(st,perPax)=>{reached=true;return serve(st,perPax);};
}
const deadline=g.day+180;
while(!reached&&g.day<deadline){
  const data=saved(g);g.stepTick();
  if(reached){g=deserialize(JSON.parse(data));line=g.lines.get(lineId)!;sts=sts.map(s=>g.stations.get(s.id)!);town=g.towns.list[town.id];}
}
check(reached,'normal drivers reach a saved pre-arrival tick');
function quote(w:Game){const l=w.lines.get(lineId)!;return {plan:sharedCapacityPlan(w,l),investment:marginalTrainInvestment(w,l,me,cars),observed:observedCapacityAgreement(w,l)};}
let calls=0,auctionReads=0;
const native=g.demand.forecastLine.bind(g.demand);
g.demand.forecastLine=(...args)=>{calls++;return native(...args);};
const company=g.company.bind(g);
g.company=id=>{auctionReads++;return company(id);};
// Settle the saved monthly observation once. Thereafter quotes must be saved-state pure.
quote(g);quote(g);
const before=saved(g),first=JSON.stringify(quote(g)),warmCalls=calls;
for(let i=0;i<8;i++)check(JSON.stringify(quote(g))===first,'warm auction and investment decisions are exact');
check(calls===warmCalls&&saved(g)===before,'warm decisions use derived forecasts without changing the full save');
let arrivals=0,unchanged=0,arrivalHits=0,replay=true;
for(const v of g.vehicles.map.values()){
  const serve=v.serveStation.bind(v);
  v.serveStation=(st,perPax)=>{arrivals++;return serve(st,perPax);};
}
const twin=cold(g);
for(let i=0;i<240;i++){
  const was=epoch(g),n=calls,a=arrivals;
  g.stepTick();twin.stepTick();
  // Daily observations and catchment publication are genuine invalidations; movement alone is not.
  const unchangedEpoch=epoch(g)===was,reads=auctionReads,value=JSON.stringify(quote(g));
  check(value===JSON.stringify(quote(twin)),'warm and cold auctions make identical native fixed-tick decisions');
  replay&&=saved(g)===saved(twin);
  if(unchangedEpoch){unchanged++;check(calls===n,'moving, loading and unloading stock do not rerun the same scheduled forecasts');
    check(auctionReads>reads,'the full auction still rereads current operating inputs on every fixed tick');
    if(arrivals>a){arrivalHits++;const fork=cold(g),data=saved(fork);check(JSON.stringify(quote(fork))===value&&saved(fork)===data,'actual arrival agrees with a fresh cold quote and leaves its complete save unchanged');}}
}
check(unchanged>200&&arrivalHits>0&&arrivals>0,'real arrivals exercise unchanged-epoch reuse, rather than a parked fixture');
check(replay&&!checkReservations(g).length,'native movement, passenger counters and capacity decisions replay exactly with legal reservations');

function invalidates(label:string,mutate:()=>void){
  quote(g);const was=epoch(g),n=calls;mutate();
  const value=JSON.stringify(quote(g));
  check(epoch(g)!==was&&calls>n,label+' invalidates the frequency quote');
  const data=saved(g),fork=cold(g);check(JSON.stringify(quote(fork))===value&&saved(fork)===data,label+' retains exact cold decisions and saved state');
}
invalidates('native stock bought on another line',()=>{
  const other=g.lines.create('rail',me);other.stops=[sts[0].id,sts[2].id];
  const v=g.vehicles.buyTrain(depot,cars,other.id);check(v instanceof Train,'another timetable receives real paid stock');
});
invalidates('native pattern edit',()=>check(setPatterns(g,lineId,[{id:0,name:'Local',kind:'local',stops:line.stops.map(()=>true),ids:[...line.stops]}])===null,'native pattern update succeeds'));
invalidates('native permission change',()=>{g.setAccessPolicy(2,'auto-reject');check(!g.canUse(me,2),'other network permission actually changes');});
invalidates('direct UI policy refresh',()=>{
  const version=g.networkVersion;g.ais[1].config={...g.ais[1].config,accessPolicy:'open'};g.refreshAccess();
  check(g.networkVersion===version&&g.canUse(me,2),'effective access changes even without a topology notification');
});
invalidates('native access price change',()=>{g.setAccessMultiplier(2,g.accessMultiplier(2)+.25);});
invalidates('native lot demolition',()=>{const id=[...town.buildings][0];g.towns.demolishBuilding(id);check(!g.world.buildings.has(id),'native building and town population removed');});
invalidates('native terrain edit',()=>{const w=g.world;w.setVertex(30,30,w.heightAt(30,30)+.1);});
invalidates('native day boundary',()=>{const day=g.day;while(g.day===day)g.stepTick();});

// Distinct exact headways are bounded by the existing 256-entry policy, not a world-lifetime cache.
const observation={...line.capacity!},baseline=JSON.stringify(quote(g));
for(let i=1;i<=140;i++){line.capacity!.delay=i*.017;quote(g);}
line.capacity=observation;
const beforeEvicted=calls,recomputed=JSON.stringify(quote(g));
check(calls>beforeEvicted&&recomputed===baseline,'more than 256 exact frequency entries evict old results and recompute the identical decision');
const afterEvicted=calls;quote(g);check(calls===afterEvicted,'recomputed bounded-cache entry is reused');
console.log(`\n${checks} assertions; ${unchanged} unchanged ticks, ${arrivalHits} real-arrival hits, ${calls} native forecasts`);
console.log('ALL CHECKS PASSED');
