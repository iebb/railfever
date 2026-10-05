// Native facilities on existing rail: rights, retained ownership/civil assets, actual curved geometry,
// unequal lengths/fees, pure rejection, lifecycle and saved replay. Whole-consist service is checked with platforms.ts.
// npx esbuild scripts/station-on-track.ts --bundle --platform=node --format=esm --outfile=$S/station-on-track.mjs
import { writeFileSync } from 'node:fs';
import { flatGame, check, done } from './stationlib';
import { Economy } from '../src/game/economy';
import { bezLine, bezOffset, bezDeriv, type Bez } from '../src/game/geom';
import { planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { serialize, deserialize, captureSave } from '../src/game/save';
import { stationPose, stationLocal, stationPlatformLength } from '../src/game/station-geometry';
import { entranceUpkeep, STATION_UPKEEP_FACTOR, restoreStation } from '../src/game/stations';
import type { Game } from '../src/game/game';
import type { NEdge } from '../src/game/network';
const json = (g: Game) => JSON.stringify(serialize(g));
const curve: Bez = { x0: 70, z0: 70, x1: 70, z1: 100, x2: 100, z2: 130, x3: 130, z3: 130 };
function fixture(level: 'ground'|'elevated'|'underground'='ground', count=1) {
  const g=flatGame(256),net=g.world.net;
  g.companies.push({ id:1,name:'Inherited Rail',color:'#3d8be8',ai:false,economy:new Economy(),code:'I' });
  g.options.aiCompanies=0; g.aiEnabled=false; g.setAccessPolicy(1,'open');g.setAccessMultiplier(1,2);g.refreshAccess();
  const y=level==='ground'?3.1:level==='elevated'?5.5:0.8;
  const rail:NEdge[]=[];
  for(let i=0;i<count;i++) {
    const c=bezOffset(curve,i*.5),aD=bezDeriv(c,0),bD=bezDeriv(c,1);
    const a=net.addNode('rail',c.x0,y,c.z0,aD.x,aD.z,1),b=net.addNode('rail',c.x3,y,c.z3,bD.x,bD.z,1);
    a.signal=2;a.signalKind='block';a.signalPass=true;b.signal=1;
    const e=net.addEdge('rail',a.id,b.id,c,new Float32Array(300).fill(y),[],i%2?'standard':'electric',1);
    if(level!=='ground'){e.sections=[{s0:0,s1:e.len,type:level==='elevated'?'bridge':'tunnel'}];net.touchEdge(e);}
    rail.push(e);
  }
  // A real street beside the curved middle gives road contact and a meaningful walking origin.
  const a=net.addNode('road',70,3,115,0,0,-1),b=net.addNode('road',104,3,144,0,0,-1);
  net.addEdge('road',a.id,b.id,bezLine(a.x,a.z,b.x,b.z),new Float32Array(100).fill(3),[],'street',-1);
  return {g,rail};
}
const plan=(g:Game,e:NEdge,tracks=1,style='shelter')=>planStationOnTrack(g,e.id,e.len/2,{length:20,tracks,reuseTrack:true,style},0);
console.log('native retained curved stations');
for(const level of ['ground','elevated','underground'] as const){
  const {g,rail}=fixture(level,2),net=g.world.net,e=rail[0];
  const before=json(g),start=performance.now(),p=plan(g,e,2,level==='underground'?'classic':'modern');
  console.log(`  ${level}: planning ${(performance.now()-start).toFixed(1)} ms`);
  check(json(g)===before,`${level}: planning is exactly pure`);
  check(p.ok&&!!p.station?.alignment,`${level}: actual parallel curved rail accepts station (${p.error??'ok'})`);
  if(!p.ok||!p.station)continue;
  const lengths=p.station.alignment!.tracks.map(t=>t.length),total=lengths.reduce((a,b)=>a+b,0);
  check(Math.abs(lengths[0]-lengths[1])>.03,`${level}: true parallel arcs have unequal lengths`);
  check(Math.abs(stationPlatformLength({...p.station,trackOffsets:p.station.layout.trackOffsets})-total)<1e-8,`${level}: platform length uses actual arcs`);
  if(level==='ground') check(p.cost===Math.round(120000+1500*total+12000+(p.station.access?.cost??0)), 'ground modern quote charges actual new platform arcs and building/access, excludes inherited rail');
  const ownerAssets=g.companyAssets(1).track,ownerMaint=g.maintenanceOf(1),ownerMoney=g.company(1).economy.money,cash=g.economy.money;
  const signals=rail.flatMap(q=>[net.nodes.get(q.a)!,net.nodes.get(q.b)!]).map(n=>[n.id,n.signal,n.signalKind,n.signalPass]);
  const r=commitStationOnTrack(g,p);check(!r.error,`${level}: commit succeeds (${r.error??'ok'})`);
  const st=g.stations.get(r.station);if(!st?.rail)continue;
  const rr=st.rail, groups=g.stations.railTrackGroups(st,true), inherited=[...net.edges.values()].filter(q=>q.kind==='rail');
  check(st.owner===0&&inherited.every(q=>q.owner===1),`${level}: station belongs to payer, all inherited rail remains foreign`);
  check(g.company(1).economy.money===ownerMoney&&cash-g.economy.money===p.cost&&rr.cost===p.cost,`${level}: one facility payment, foreign owner cash untouched`);
  check(Math.abs(g.companyAssets(1).track-ownerAssets)<.5&&g.companyAssets(0).track===0,`${level}: inherited rail assets remain with original owner`);
  check(Math.abs(g.maintenanceOf(1)-ownerMaint)<.01,`${level}: rail maintenance remains billed to original owner`);
  check(Math.abs(g.stationMaintenance(st)-((20000+stationPlatformLength(rr)*500)*(STATION_UPKEEP_FACTOR[level]??1)+entranceUpkeep(rr)))<1e-8,`${level}: facility upkeep follows actual platform arcs`);
  check(signals.every(([id,s,k,pass])=>{const n=net.nodes.get(id as number)!;return n.signal===s&&n.signalKind===k&&n.signalPass===pass;}),`${level}: old boundary signals and pass semantics retained`);
  check(inherited.some(q=>q.type==='electric')&&inherited.some(q=>q.type==='standard'),`${level}: mixed existing wire profiles retained`);
  check(groups.length===2&&new Set(groups.map(q=>q.id)).size===2&&groups.every(q=>q.steps.length&&q.length>19),`${level}: stable ordered physical groups expose both full tracks`);
  // Platform positions hug the actual running curve, not the centre tangent.
  const end=stationPose(rr,rr.trackOffsets[0],rr.length/2),mid=stationPose(rr,rr.trackOffsets[0],0);
  const deviation=Math.abs((end.x-mid.x)*mid.fz-(end.z-mid.z)*mid.fx);
  check(deviation>.2,`${level}: substantial bend survives actual platform geometry`);
  const far=stationPose(rr,0,rr.length/2+5);check(stationLocal(rr,far.x,far.z).along>rr.length/2+4.9,`${level}: entrance coordinates distinguish beyond-end positions`);
  const saved=json(g),loaded=deserialize(JSON.parse(saved));
  if(json(loaded)!==saved){const a=saved,b=json(loaded);let i=0;while(a[i]===b[i]&&i<a.length)i++;console.log('first save diff',i,a.slice(i-100,i+250),b.slice(i-100,i+250));}
  check(json(loaded)===saved,`${level}: exact native save/load round trip`);
  for(let i=0;i<40;i++){g.stepTick();loaded.stepTick();}
  check(json(g)===json(loaded),`${level}: fixed-step replay remains exact`);
  const frozen=captureSave(g).state; const restored=restoreStation(frozen.stations.find((s:any)=>s.id===st.id));
  check(restored.rail!.groups!==rr.groups&&restored.rail!.alignment!.tracks[0].pieces[0].profile!==rr.alignment!.tracks[0].pieces[0].profile,`${level}: restored groups and geometry own their arrays`);
  const first=groups[0],edge=net.edges.get(first.steps[0].edge)!;
  net.splitEdge(edge.id,edge.len/2);const split=g.stations.railTrackGroups(st,true).find(q=>q.id===first.id)!;
  check(split.steps.length===first.steps.length+1&&split.back===first.back&&split.front===first.front,`${level}: interior split retains physical group identity and endpoint order`);
  const pass=g.stations.passTracks(st.id,1).find(q=>q.edges.includes(split.steps[0].edge));
  check(!!pass&&pass.edges.length===split.steps.length,`${level}: passing membership includes every curved fragment`);
  const snap=json(g);check(!g.stations.planUpgrade(st.id,{length:24}).ok&&!!g.stations.relocate(st.id,p.station)&&json(g)===snap,`${level}: unsupported rebuilding/moving cannot delete inherited rail`);
  const physical=new Map([...net.edges].filter(([,q])=>q.kind==='rail').map(([id,q])=>[id,JSON.stringify({...q,station:-1,version:0})]));
  check(!g.stations.removeStation(st.id),`${level}: facility removal succeeds`);
  check([...physical].every(([id,s])=>{const q=net.edges.get(id);return q&&JSON.stringify({...q,station:-1,version:0})===s&&q.station===-1;}),`${level}: removal restores ordinary rail, geometry/profile/owners/wires unchanged`);
  check(Math.abs(g.companyAssets(1).track-ownerAssets)<.5&&Math.abs(g.maintenanceOf(1)-ownerMaint)<.01,`${level}: removal leaves inherited assets and upkeep intact`);
  console.log(`  ${level}: arcs=${lengths.map(n=>n.toFixed(4)).join('/')} cost=${p.cost} facilityUpkeep=${loaded.stationMaintenance(loaded.stations.get(st.id)!)} bend=${deviation.toFixed(3)}`);
}
// Deleting a middle fragment must not advertise the disconnected pieces as one usable platform.
{
  const {g,rail}=fixture(),p=plan(g,rail[0]),r=commitStationOnTrack(g,p),st=g.stations.get(r.station)!,net=g.world.net;
  const q=g.stations.railTrackGroups(st)[0],e=net.edges.get(q.steps[0].edge)!;
  const first=net.splitEdge(e.id,e.len/3)!,second=net.splitEdge(first.e2.id,first.e2.len/2)!;
  const identity=g.stations.railTrackGroups(st)[0].id;
  net.removeEdge(second.e1.id);const before=json(g),groups=g.stations.railTrackGroups(st);
  check(groups.length===0&&g.stations.trackEnds(st).length===0&&json(g)===before,'broken platform groups reject disconnected summed length through pure read');
  check(st.rail!.groups![0].id===identity,'broken saved physical identity remains stable for a later geometry-preserving repair');
}
// Clearance must follow the bent outer platform, and facilities must refuse sharp unsupported turns.
{
  const {g,rail}=fixture(),p=plan(g,rail[0]);
  const pt=stationPose(p.station!,p.station!.layout.platforms[0].off,8.5),net=g.world.net;
  const a=net.addNode('road',pt.x-.3*pt.fz,pt.y,pt.z+.3*pt.fx,0,0,-1),b=net.addNode('road',pt.x+.3*pt.fz,pt.y,pt.z-.3*pt.fx,0,0,-1);
  net.addEdge('road',a.id,b.id,bezLine(a.x,a.z,b.x,b.z),new Float32Array(3).fill(pt.y),[],'street',-1);
  const before=json(g),blocked=plan(g,rail[0]);
  check(!blocked.ok&&json(g)===before,'road crossing actual bent platform envelope is refused without mutation');
}
{
  const {g}=fixture(),net=g.world.net;
  const c={x0:150,z0:70,x1:150,z1:110,x2:152,z2:50,x3:152,z3:90};
  const a=net.addNode('rail',150,3.1,70,0,1,1),b=net.addNode('rail',152,3.1,90,0,1,1);
  const e=net.addEdge('rail',a.id,b.id,c,new Float32Array(150).fill(3.1),[],'standard',1),before=json(g);
  const tight=planStationOnTrack(g,e.id,e.len*.35,{length:8,tracks:1,reuseTrack:true},0);
  check(!tight.ok&&json(g)===before,`tight or reversing curve refuses unsafe facility (${tight.error??'accepted'})`);
}
{
  const {g,rail}=fixture('ground',4),p=plan(g,rail[0],2,'concourse');
  check(p.ok&&p.station!.tracks===2&&p.station!.through===2,'four retained tracks preserve two middle through tracks and outside platforms');
  if(p.ok){const r=commitStationOnTrack(g,p),st=g.stations.get(r.station)!;check(g.stations.railTrackGroups(st,true).length===4&&g.stations.railTrackGroups(st).length===2,'concourse groups distinguish platform and through physical tracks');}
}
// Each denial path must reject before any spending, split, ownership or save-state mutation.
for(const reason of ['denied','revoked','busy','stale','funds','access-busy'] as const){
  const {g,rail}=fixture();const e=rail[0];
  if(reason==='denied')g.blockCompany(1,0);
  const p=plan(g,e);
  if(reason==='revoked')g.blockCompany(1,0);
  if(reason==='stale')g.world.net.touchEdge(e);
  if(reason==='funds')g.economy.money=0;
  const busy=g.vehicles.isEdgeBusy.bind(g.vehicles);
  if(reason==='busy')g.vehicles.isEdgeBusy=(id)=>id===e.id||busy(id);
  if(reason==='access-busy'){
    check(!!p.station?.access,'access-busy fixture has a real proposed street split');
    const id=p.station?.access?.tracks.flatMap(t=>[t.start,t.end]).find(q=>q.kind==='edge')?.edge;
    g.vehicles.isEdgeBusy=(q)=>q===id||busy(q);
  }
  const before=json(g),r=commitStationOnTrack(g,p);check(!!r.error&&json(g)===before,`${reason}: rejected station leaves full save exactly unchanged (${r.error??'accepted'})`);
}
// Shared rail usage still pays the rail owner, independently of payer-owned station facilities.
{
  const {g,rail}=fixture();const p=plan(g,rail[0]),r=commitStationOnTrack(g,p),st=g.stations.get(r.station)!;
  const e=g.world.net.edges.get(st.rail!.edges[0])!,c=g.economy.money,o=g.company(1).economy.money;
  g.recordTrackUse(0,e,e.len);g.billAccess();
  check(g.economy.money<c&&g.company(1).economy.money>o&&g.agreement(0,1)!.paidLastMonth>0,'foreign platform running-rail use pays original rail owner');
}
const dir=process.argv.find(a=>a.startsWith('--fixture='))?.slice(10);
if(dir){const{g,rail}=fixture('ground',2);const p=plan(g,rail[0],2,'modern');writeFileSync(dir+'-before.json',json(g));const r=commitStationOnTrack(g,p);writeFileSync(dir+'-built.json',json(g));console.log('browser fixture',dir,r,p.station?.x,p.station?.z);}
done();
