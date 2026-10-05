// Current derived walking membership: pure before publication and exact after native save/replay.
import {flatGame, station, check, done} from './stationlib';
import {Game} from '../src/game/game';
import {serialize, deserialize} from '../src/game/save';
import {bezLine} from '../src/game/geom';
import {DAYS_PER_MONTH} from '../src/game/constants';
import {MODEL_BY_ID} from '../src/game/vehicle-types';
import {roadDepotNear, checkReservations} from './lib';
import {writeFileSync} from 'node:fs';

const road=(g:Game,x0:number,z0:number,x1:number,z1:number)=>{
  const n=g.world.net,a=n.addNode('road',x0,3,z0,0,0,-1),b=n.addNode('road',x1,3,z1,0,0,-1);
  return n.addEdge('road',a.id,b.id,bezLine(x0,z0,x1,z1),new Float32Array(Math.ceil(Math.hypot(x1-x0,z1-z0))+1).fill(3),[],'street',-1);
};
const house=(g:Game,x:number,z:number,pop=30)=>g.world.addBuilding({townId:-1,x,z,angle:0,w:.8,d:.8,type:0,floors:2,pop,seed:1,y:3,built:0});
function bus(g:Game,x:number,z:number){const id=g.stations.nextId,err=g.stations.commitBusStop(x,z,0);if(err)throw new Error(err);return g.stations.get(id)!;}
function publish(g:Game){g.stations.refreshAccess(true);g.lines.markDemandSharesDirty();g.lines.flushCatchment();}
function protectedState(g:Game){const s=g.stations as any;return JSON.stringify({save:serialize(g),catchInputs:s.catchInputs,pendingPop:[...s.pendingPop],catchVersion:s.catchVersion,catchMaxB:s.catchMaxB,
  populations:g.stations.all().map(s=>[s.id,s.catchPop]),demandShares:[...g.demand.shares],dirty:g.lines.catchmentDirty,roadsDirty:g.lines.catchmentRoadsDirty,res:[...(g.vehicles as any).res]});}
function membership(g:Game){return{stations:g.stations.all().map(s=>[s.id,g.stations.buildingShares(s)]),buildings:[...g.world.buildings.keys()].sort((a,b)=>a-b).map(id=>[id,g.stations.stationsForBuilding(id)])};}
function reference(g:Game){const r=g.stations.debugFullCatchment();return{stations:g.stations.all().map(s=>{const q=r.stations.get(s.id)!;return[s.id,{ids:q.ids,w:q.w}];}),buildings:[...g.world.buildings.keys()].sort((a,b)=>a-b).map(id=>[id,r.buildings.get(id)??{st:[],w:[]}])};}
function pureReference(g:Game,label:string){const before=protectedState(g),actual=JSON.stringify(membership(g));check(actual===JSON.stringify(reference(g)),label+': current membership equals the native full reference and order');check(protectedState(g)===before,label+': reading preserves full save, published population/demand, flags, horizon/version, pending work and reservations');return actual;}
function replay(g:Game,loaded:Game,label:string){
  const start=g.tick,oldPop=JSON.stringify(g.stations.all().map(s=>s.catchPop));let exact=true,pure=true,members=true,firstPopulationTick:number|undefined;
  for(let i=0;i<640;i++){
    const a=protectedState(g),b=protectedState(loaded);
    members&&=JSON.stringify(membership(g))===JSON.stringify(membership(loaded));pure&&=protectedState(g)===a&&protectedState(loaded)===b;
    g.stepTick();loaded.stepTick();exact&&=JSON.stringify(serialize(g))===JSON.stringify(serialize(loaded));
    if(firstPopulationTick===undefined&&JSON.stringify(g.stations.all().map(s=>s.catchPop))!==oldPop)firstPopulationTick=g.tick;
  }
  check(exact&&g.tick===start+640&&loaded.tick===g.tick,label+': all 640 complete native saved states and RNG match');
  check(pure&&members,label+': warm/cold memberships agree and every pre-update read remains pure');
  check(!checkReservations(g).length&&!checkReservations(loaded).length,label+': native reservations remain valid');
  return{start,end:g.tick,firstPopulationTick,exact,pure,members};
}

console.log('Native moved house before monthly publication');
const g=flatGame(128);g.day=15;road(g,20,60,110,60);const A=bus(g,30,60),B=bus(g,95,60),h=house(g,30,58);publish(g);
check(g.stations.stationsForBuilding(h.id).st.join()===String(A.id),'published native fixture starts at the first station');
const clean=g.stations.buildingShares(A);check(g.stations.buildingShares(A)===clean,'clean warm getter retains the existing arrays');
h.x=95;g.world.touchBuilding(h);
const before=JSON.stringify(serialize(g)),loaded=deserialize(JSON.parse(before));
check(JSON.stringify(serialize(loaded))===before,'pending native lot input saves and loads exactly');
check(!g.lines.catchmentDirty&&!loaded.lines.catchmentDirty&&A.catchPop===30&&B.catchPop===0,'native lot edit retains scheduled publication and the old populations');
const moved=pureReference(g,'moved warm house'),cold=pureReference(loaded,'moved loaded house');
check(moved===cold&&g.stations.stationsForBuilding(h.id).st.join()===String(B.id),'the same moved native house belongs to the second station before any manual flush');
const monthly=replay(g,loaded,'pending lot/monthly replay');
check(monthly.firstPopulationTick===DAYS_PER_MONTH*g.ticksPerDay+1&&A.catchPop===0&&B.catchPop===30,'population publication waits for the native monthly boundary and following tick');

console.log('Pending road edits keep their construction boundary');
// Keep the rail facility itself intact, as in the existing walkcatch pending-road fixture.
const roadGame=flatGame(128),RS=station(roadGame,60,60,Math.PI/2,8,1,0,{style:'modern'});
if(!RS)throw new Error('native pending-road rail fixture failed');
const f=roadGame.stations.forecourt(RS)!,approach=road(roadGame,f.x-24,f.z,f.x,f.z),rh=house(roadGame,f.x-6,f.z-2);
roadGame.flushNetworkChanges();publish(roadGame);
check(RS.catchPop>0&&RS.roadAccess,'native rail facility has published walking access before the edit');
roadGame.world.net.removeEdge(approach.id);roadGame.onNetworkChanged();
const pending=JSON.stringify(serialize(roadGame)),roadTwin=deserialize(JSON.parse(pending)),popBefore=RS.catchPop;
check(JSON.stringify(serialize(roadTwin))===pending,'unflushed road edit retains complete native save state');
const access=RS.roadAccess,roadBefore=protectedState(roadGame);pureReference(roadGame,'removed road before network flush');
check(roadGame.stations.stationsForBuilding(rh.id).st.length===0&&RS.roadAccess===access&&RS.catchPop===popBefore&&protectedState(roadGame)===roadBefore,'current road membership reads do not publish saved access or population');
const roadReplay=replay(roadGame,roadTwin,'pending road replay');
check(roadReplay.firstPopulationTick===roadReplay.start+1&&RS.catchPop===0,'the original native network boundary publishes the road change');

console.log('Saved zero horizon and current served-station weighting');
const zero=flatGame(128);road(zero,20,60,110,60);const Z=bus(zero,30,60),z=house(zero,30,58),zeroBefore=protectedState(zero);
check(zero.stations.catchMaxB===0,'a newly built unflushed fixture has the real zero building horizon');
pureReference(zero,'unpublished zero horizon');
check(!zero.stations.buildingShares(Z).ids.length&&!zero.stations.stationsForBuilding(z.id).st.length&&protectedState(zero)===zeroBefore,'getters never advance an unpublished zero horizon');
publish(zero);check(zero.stations.buildingShares(Z).ids.includes(z.id),'the native publication advances the horizon and exposes the building');

const served=flatGame(192),main=road(served,20,60,170,60),P=bus(served,52,60),Q=bus(served,72,60),R=bus(served,110,60),b=house(served,60,58);publish(served);
check(served.stations.stationsForBuilding(b.id).st.length===2,'native overlap initially shares between two unserved stops');
const depot=roadDepotNear(served,52,60,0,[main.id]),line=served.lines.create('road',0);line.stops=[P.id,R.id];served.lines.rebuild();
const vehicle=served.vehicles.buyRoad(depot,MODEL_BY_ID.get('bus_c')!,line.id);if(typeof vehicle==='string')throw new Error(vehicle);
pureReference(served,'native purchase before share publication');
check(served.stations.stationsForBuilding(b.id).st.join()===String(P.id),'a native bought service receives the existing served-station preference before publication');
served.vehicles.sell(vehicle.id);pureReference(served,'native sale before share publication');
check(served.stations.stationsForBuilding(b.id).st.includes(Q.id),'selling native stock restores the unserved overlap');
b.pop=0;served.world.touchBuilding(b);pureReference(served,'zero population native input');
check(!served.stations.stationsForBuilding(b.id).st.length,'zero-population buildings leave current membership without publishing population');
b.pop=30;b.x=66;served.world.touchBuilding(b);pureReference(served,'restored moved native input');
served.world.setVertex(66,59,-1);pureReference(served,'native terrain input');served.world.setVertex(66,59,3);pureReference(served,'restored native terrain');

const out=process.argv.find(a=>a.startsWith('--json='))?.slice(7);
if(out)writeFileSync(out,JSON.stringify({monthly,roadReplay,scope:'Native bounded fixtures; no AI/planner forcing, unchanged monthly/service publication, complete 640-state replay and pure current derived membership.'},null,2)+'\n');
done();
