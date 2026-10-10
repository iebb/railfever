// Native entrance-search memo: default queries stay cold; AI results/candidate order, full urban
// quotes and rejection reasons match cold planning. Real geometry edits invalidate it, returned
// demolition arrays are independent, cache sizes are bounded, and saved work resumes exactly.
// Bundle as entrancecache.mjs and run with Node.
import {flatGame,station,check,done} from './stationlib';
import {Game} from '../src/game/game';
import {AIController} from '../src/game/ai';
import {serialize,deserialize} from '../src/game/save';
import {bezLine,arcTable} from '../src/game/geom';
import {planRelevel,commitRelevel} from '../src/game/trackops';
const g=flatGame(192,3),ss:any=g.stations,n=g.world.net;
const fp={x:96,z:96,angle:Math.PI/2,w:2,d:12};
function road(z:number){const a=n.addNode('road',50,3,z,0,0,-1),b=n.addNode('road',142,3,z,0,0,-1);return n.addEdge('road',a.id,b.id,bezLine(50,z,142,z),new Float32Array(93).fill(3),[],'street',-1);}
const r=road(91),S=station(g,96,96,Math.PI/2,12,2,0,{level:'underground',mode:'lightrail',style:'none'})!;
check(!!S&&S.rail!.entrances.length>=2,'native underground station and street fixture');
function stats(){return {...ss.entranceMemoStats()};}
function base(){return[n.version,g.world.heightsVersion,g.world.lotVersions.version,ss.walkVersion,ss.map.size,g.networkVersion,g.depots.map.size];}
function query(x:number,z:number,angle=0,road=-1,level='underground',f=fp){return ss.memoEntranceFree(level,x,z,angle,f,road);}
function planParity(label:string){const before=JSON.stringify(serialize(g));const args=[86,96,Math.PI/2,7,2,0] as const,opts={level:'underground',mode:'lightrail',style:'none'} as const;const memo=ss.planRail(...args,{...opts,aiSurvey:true}),cold=ss.planRail(...args,opts);check(JSON.stringify(memo)===JSON.stringify(cold),label+' full native plan parity');check(JSON.stringify(serialize(g))===before,label+' full plan serialized purity');return memo;}
function parity(label:string,x:number,z:number,angle=0,road=-1,level='underground',f=fp){const before=JSON.stringify(serialize(g));const cached=query(x,z,angle,road,level,f),cold=ss.entranceFree(level,x,z,angle,f,road);check(JSON.stringify(cached)===JSON.stringify(cold),label+' cached/native parity');check(JSON.stringify(serialize(g))===before,label+' is serialized-pure');return cached;}
let pl:any;
for(let x=76;x<=116;x+=2)for(const z of [89.9,92.1]){const p=g.stations.planEntrance(S.id,x,z,0);if(p.ok&&!pl)pl=p;}
check(!!pl,'native extra entrance plan exists');planParity('initial');planParity('warm initial');
if(pl){
 const e=pl.entrance,near=n.nearestEdge(e.x,e.z,3,'road')!;
 const args=[e.x,e.z,e.angle,near.edge.id] as const;
 check(parity('before entrance',...args)!==null,'planned entrance candidate is initially free');
 query(...args);const hit=stats();check(hit.hits>0,'identical native read uses memo');
 const b=base(),rev=hit.revision;check(!g.stations.commitEntrance(S.id,pl,0),'native entrance committed');
 check(parity('after native commitEntrance',...args)===null,'new native entrance invalidates previously free candidate');
 check(stats().revision>rev,'commitEntrance increments derived revision');planParity('after native entrance add');
 console.log('COMMIT_ENTRANCE_EPOCH',JSON.stringify({before:b,after:base()}));
 const b2=base(),rev2=stats().revision;
 check(!g.stations.removeEntrance(S.id,S.rail!.entrances.length-1,0),'native entrance removed');
 check(parity('after native removeEntrance',...args)!==null,'native removal invalidates previously blocked candidate');
 check(stats().revision>rev2,'removeEntrance increments derived revision');planParity('after native entrance remove');
 console.log('REMOVE_ENTRANCE_EPOCH',JSON.stringify({before:b2,after:base()}));
}
{
 const up=g.stations.planUpgrade(S.id,{style:'classic'});
 check(up.ok&&up.restyleOnly,'native restyle-only plan exists');
 if(up.ok&&up.restyleOnly){
  const q=up.plan!.building,b=base();query(q.x,q.z,q.angle);const rev=stats().revision;check(!g.stations.commitUpgrade(up),'native restyle-only commit');
  parity('after restyle-only building edit',q.x,q.z,q.angle);
  check(stats().revision>rev,'restyle-only increments derived geometry revision');planParity('after restyle-only');
  console.log('RESTYLE_EPOCH',JSON.stringify({before:b,after:base()}));
 }
}
{
 const up=g.stations.planUpgrade(S.id,{style:'brick'});check(up.ok&&up.restyleOnly,'native building removal restyle exists');
 if(up.ok&&up.restyleOnly){const q=S.rail!.building;parity('before building removal',q.x,q.z,q.angle);const b=base(),rev=stats().revision;check(!g.stations.commitUpgrade(up),'native building removal commit');parity('after building removal',q.x,q.z,q.angle);check(stats().revision>rev,'building removal increments derived revision');planParity('after second native restyle');console.log('RESTYLE_REMOVE_EPOCH',JSON.stringify({before:b,after:base()}));}
}
{
 const re=planRelevel(g,[...S.rail!.edges],'elevated',0);
 check(re.ok,'native level change exists');
 if(re.ok){const rev=stats().revision;query(20,20);check(!commitRelevel(g,re),'native level change committed');parity('after native relevel',20,20);check(stats().revision>rev,'native relevel increments derived geometry revision');planParity('after native level change');}
}
{
 const house=g.world.addBuilding({townId:-1,x:20,z:20,angle:0,w:.8,d:.8,type:0,floors:1,pop:20,seed:1,y:3,built:0});
 const a=query(20,20);check(a?.includes(house.id),'native demolition list contains the small house');
 if(a)a.push(999999);
 const b=query(20,20);check(!b?.includes(999999),'caller cannot modify cached demolition array');
 parity('copied demolition array',20,20);
}
{
 const overlap={x:30,z:30,angle:0,w:3,d:3},clear={x:50,z:50,angle:0,w:3,d:3};
 check(query(30,30,0,-1,'elevated',clear)!==null,'elevated native candidate can be clear');
 check(query(30,30,0,-1,'elevated',overlap)===null,'each elevated deck-overlap check precedes memo reuse');
}
{
 query(40,40);const before=stats();
 g.stations.planRail(120,120,0,12,2,0,{level:'underground',mode:'lightrail'});
 check(JSON.stringify(stats())===JSON.stringify(before),'ordinary native planning does not produce or consume AI memo');
 const shadow:any=Object.create(ss);shadow.map=new Map(ss.map);
 shadow.memoEntranceFree('underground',40,40,0,fp,-1);
 check(JSON.stringify(stats())===JSON.stringify(before),'Object.create preview has a separate WeakMap cache');
 check(shadow.entranceMemoStats()?.misses===1,'preview instance starts cold despite inherited methods');
 const prior=ss.map;ss.map=new Map(prior);query(40,40);check(stats().misses>before.misses,'same-version station map identity replacement invalidates');ss.map=prior;
}
{
 const h=flatGame(192,3),cold:any=h.stations;
 cold.planRail(96,96,Math.PI/2,12,2,0,{level:'underground',mode:'lightrail'});
 check(cold.entranceMemoStats()===null,'a fresh default native plan does not prime AI memo');
 const curve={x0:80,z0:91,x1:85,z1:93,x2:91,z2:93,x3:96,z3:91},length=arcTable(curve).len;
 const shape={x:88,z:92,y:1,angle:Math.PI/2,length,alignment:{tracks:[{offset:0,length,
   pieces:[{curve,length,profile:new Array(Math.ceil(length)+1).fill(1)}],knots:[{u:0,s:0},{u:length,s:length}]}]}};
 const before=JSON.stringify(serialize(h));cold.curvedEntranceSites('underground',shape,2,2);
 check(cold.entranceMemoStats()===null,'curved native entrance planning does not prime AI memo');
 check(JSON.stringify(serialize(h))===before,'curved native entrance planning stays serialized-pure');
}
console.log('FINAL_CACHE',JSON.stringify(stats()));


// Exact site outcomes, including every failed offset that the AI discards. Invalid AI
// previews may omit the unused construction bill after the first native failure.
{
  const h=Game.create({size:640,seed:21,towns:14,hilliness:'flat',water:'low',startYear:1990,
    aiConfigs:[{startMoney:60_000_000,focus:{rail:2,road:.3,tram:1.5}}]});
  h.aiEnabled=false;h.aiAcquisitions=false;
  const before=JSON.stringify(serialize(h)),sites:any=h.stations,plan=sites.planRail.bind(sites);
  const ai:any=h.ais[0],quotes:any[]=[];let surveyValid=0,surveyRejected=0,unusedFailedBills=0,unitCalls=0,maxCalls=0;
  for(const cached of [false,true]){
    sites.planRail=(...args:any[])=>{
      unitCalls++;args[6]={...(args[6]??{}),aiSurvey:cached};const chosen=plan(...args);
      if(cached){
        const cold=plan(...args.slice(0,6),{...args[6],aiSurvey:false});
        check(cold.ok===chosen.ok&&cold.error===chosen.error,'every surveyed candidate retains native eligibility/first reason');
        if(chosen.ok){surveyValid++;check(JSON.stringify(cold)===JSON.stringify(chosen),'every surveyed valid proposal retains exact geometry/access/cost');}
        else{surveyRejected++;if(cold.cost!==chosen.cost)unusedFailedBills++;}
      }
      return chosen;
    };
    const layouts=[];
    for(const town of h.towns.list.filter(t=>t.pop>=AIController.urbanPop))for(const mode of ['lightrail','metro']){
      const job=ai.urbanStep(town,mode);let result;do{unitCalls=0;result=job.next();maxCalls=Math.max(maxCalls,unitCalls);}while(!result.done);layouts.push(result.value);
    }
    quotes.push(JSON.stringify(layouts));
    check(JSON.stringify(serialize(h))===before,(cached?'warm':'cold')+' full urban quotes are serialized-pure');
  }
  sites.planRail=plan;
  check(quotes[0]===quotes[1],'all original/full urban quote JSON remains byte-identical');
  check(surveyValid>0&&surveyRejected>0,'complete urban surveys compare both eligible and discarded native candidates');
  check(maxCalls<=5,'each fixed urban work unit makes at most five native site attempts');
  console.log('SURVEY_CANDIDATE_PARITY',JSON.stringify({surveyValid,surveyRejected,unusedFailedBills,maxCalls}));
  let nativeFailed=0,nativeValid=0;
  for(const t of h.towns.list.filter(t=>t.pop>=AIController.urbanPop))for(const level of ['ground','elevated','underground'] as const)
    for(const angle of [0,Math.PI/2])for(const d of [0,1.5,-1.5,3,-3]){
      const args=[t.x+Math.sin(angle)*d,t.z+Math.cos(angle)*d,angle,7,2,ai.companyId] as const;
      const opts={level,mode:'lightrail',depth:2.2,height:1.5} as const;
      const cold=plan(...args,opts),memo=plan(...args,{...opts,aiSurvey:true});
      check(cold.ok===memo.ok&&cold.error===memo.error,'native eligibility and first rejection reason at '+t.id+'/'+level+'/'+angle+'/'+d);
      if(cold.ok){nativeValid++;check(JSON.stringify(cold)===JSON.stringify(memo),'funded valid station geometry/cost/access unchanged');}else nativeFailed++;
    }
  console.log('NATIVE_ELIGIBILITY',JSON.stringify({nativeValid,nativeFailed}));
  check(nativeValid>0&&nativeFailed>0,'candidate parity includes valid and rejected native sites');
}

// Exercise each independent bound with real flat-world geometry and legal separated streets.
{
  const h=flatGame(512,3),net=h.world.net,sites:any=h.stations;
  for(let z=30;z<=430;z+=4){
    const a=net.addNode('road',30,3,z,0,0,-1),b=net.addNode('road',450,3,z,0,0,-1);
    net.addEdge('road',a.id,b.id,bezLine(30,z,450,z),new Float32Array(421).fill(3),[],'street',-1);
  }
  const before=JSON.stringify(serialize(h));
  for(let z=30;z<=430;z+=4){
    const args=[90,z,Math.PI/2,7,2,0] as const,opts={mode:'lightrail',level:'underground',depth:2.2} as const;
    const cold=sites.planRail(...args,opts),memo=sites.planRail(...args,{...opts,aiSurvey:true});
    check(JSON.stringify(cold)===JSON.stringify(memo),'road eviction retains native ordered candidates');
  }
  for(let i=0;i<540;i++)sites.entranceSites('underground',{x:90+i*.001,z:100,angle:Math.PI/2,w:2,d:7},2,[],undefined,undefined,true);
  const f={x:20,z:20,angle:0,w:0,d:0};
  for(let i=0;i<9000;i++)sites.memoEntranceFree('underground',20+i*.0001,20,0,f,-1);
  const b=sites.entranceMemoStats();
  check(b.roadCount<=32768&&b.siteSize<=512&&b.size<=8192,'road samples, site results and off-road reads stay bounded');
  const cold=sites.entranceFree('underground',20,20,0,f,-1),memo=sites.memoEntranceFree('underground',20,20,0,f,-1);
  check(sites.entranceMemoStats().misses>b.misses,'evicted first result is recomputed natively');
  check(JSON.stringify(cold)===JSON.stringify(memo),'eviction preserves native outcome');
  check(JSON.stringify(serialize(h))===before,'cache eviction does not alter save/funds/assets');
  console.log('BOUNDED_CACHE',JSON.stringify(sites.entranceMemoStats()));
}

// Generated native controls: Marcliff light rail truthfully rejects its missing (flooded) yard; Dorminster
// metro funds, completes and calls at a station. No-cache and warm-cache worlds have the same
// work cadence, money, stock and population. Each saved twin checks all 640 serialized ticks.
for(const [name,mode,positive] of [['Marcliff','lightrail',false],['Dorminster','metro',true]] as const){
  const h=Game.create({size:640,seed:21,towns:14,hilliness:'flat',water:'low',startYear:1990,
    aiConfigs:[{startMoney:60_000_000,focus:{rail:2,road:.3,tram:1.5}}]});
  h.aiEnabled=false;h.aiAcquisitions=false;h.vehicles.ambientEnabled=false;
  // Initialize the generated world's ordinary demand/catchment horizon before either project starts.
  // Both controls then begin with the same saved native inputs, without changing any project checkpoint.
  h.stepTick();
  const ai:any=h.ais[0],town=h.towns.list.find(t=>t.name===name)!;
  check(!!town&&ai.startProject(mode,[town.id]),name+' native quotation starts');h.aiEnabled=true;
  const initial=JSON.stringify(serialize(h)),control=deserialize(JSON.parse(initial)),cold:any=control.stations;
  check(JSON.stringify(serialize(control))===initial,name+' no-cache native control starts exactly');
  const plan=cold.planRail.bind(cold);
  cold.planRail=(...args:any[])=>{args[6]={...(args[6]??{}),aiSurvey:false};return plan(...args);};
  const replays:{g:Game,label:string,left:number,comparisons:number}[]=[],seen=new Set<string>();
  const urban=()=>{const entry=[...ai.lines.entries()].find(([,info]:any)=>info.urban);return entry&&h.lines.get(entry[0]);};
  const operating=()=>{const line=urban();return ai.stats.urban>0&&!ai.urbanTask&&!!line&&line.vehicles.some((id:number)=>(h.vehicles.get(id) as any)?.opLastSt>=0);};
  const rejected=()=>ai.stats.failed>0&&!ai.urbanTask&&!ai.urbanSurvey;
  let ticks=0,controlExact=true,flooded=false;
  while((!(positive?operating():rejected())||replays.some(r=>r.left>0))&&ticks++<16000){
    h.stepTick();control.stepTick();
    const expected=JSON.stringify(serialize(h));
    controlExact&&=expected===JSON.stringify(serialize(control));
    for(const r of replays)if(r.left>0){
      r.g.stepTick();r.left--;r.comparisons++;
      check(expected===JSON.stringify(serialize(r.g)),r.label+' exact saved/cold tick '+r.comparisons);
    }
    // (2.11: a city line's depot stands on a siding beside the line, its site planned near a junction on the line: the
    // negative control floods that ground, all but the laid track's own formation, once the track is laid and before
    // the depot is built: the same missing-yard rejection.)
    if(!positive&&!flooded&&ai.urbanTask?.stage==='sideDepot'&&ai.urbanTask.plannedYard?.side){
      const flood=(game:Game)=>{const y=(game.ais[0] as any).urbanTask.plannedYard.side,net=game.world.net;
        for(let x=Math.floor(y.jx)-75;x<=Math.ceil(y.jx)+75;x++)for(let z=Math.floor(y.jz)-75;z<=Math.ceil(y.jz)+75;z++)
          if(Math.hypot(x-y.jx,z-y.jz)<=75&&!net.nearestEdge(x,z,1.6,'rail'))game.world.setVertex(x,z,-2);};
      flood(h);flood(control);for(const r of replays)if(r.left>0)flood(r.g);flooded=true;
    }
    const cursor=ai.urbanSurvey,stage=cursor&&cursor.trial>0?'survey':ai.urbanTask?.stage==='stations'&&ai.urbanTask.at>0?'construction':undefined;
    if(stage&&!seen.has(stage)){
      // (2.10: the urban survey now also prices trunks to neighbouring centres, and Marcliff's light rail finds a
      // buildable yard on one. The negative control floods its approved yard site once construction has begun, a native
      // terrain edit applied alike to every world at this tick: the same missing-yard rejection 2.9's site gave.)
      if(!positive&&stage==='construction'&&!ai.urbanTask.plannedYard.side){
        const flood=(game:Game)=>{const y=(game.ais[0] as any).urbanTask.plannedYard;
          for(let dx=-4;dx<=4;dx++)for(let dz=-4;dz<=4;dz++)game.world.setVertex(Math.round(y.x)+dx,Math.round(y.z)+dz,-2);};
        flood(h);flood(control);for(const r of replays)if(r.left>0)flood(r.g);
      }
      const data=JSON.stringify(serialize(h)),copy=deserialize(JSON.parse(data));
      check(JSON.stringify(serialize(copy))===data,name+'/'+stage+' immediate roundtrip');
      check(!(copy.stations as any).entranceMemoStats(),name+'/'+stage+' loaded instance starts cold');
      replays.push({g:copy,label:name+'/'+stage,left:640,comparisons:0});seen.add(stage);
      console.log('SAVED_CACHE_STAGE',JSON.stringify({name,stage,day:h.day,trial:cursor?.trial,site:cursor?.site,offset:cursor?.offset}));
    }
  }
  check(controlExact,name+' native no-cache and warm-cache controls remain exact at every tick');
  check(seen.size===2&&replays.every(r=>r.left===0&&r.comparisons===640),name+' survey/construction each compare all640 ticks');
  if(positive)check(operating(),name+' ordinary metro completes and makes real station calls within bounded native work');
  else check(rejected()&&ai.log.some((s:string)=>s.includes('no depot site'))&&ai.stats.urban===0&&h.stations.map.size===0&&h.depots.map.size===0&&h.vehicles.map.size===0,
    name+' native missing-yard rejection rolls back assets without an invented urban opening');
  console.log('NATIVE_CACHE_COMPLETION',JSON.stringify({name,day:h.day,ticks,urban:ai.stats.urban,failed:ai.stats.failed,
    comparisons:replays.map(r=>r.comparisons),notes:ai.log.slice(-4),vehicles:h.vehicles.all().map(v=>({state:v.state,onMap:v.onMap,called:(v as any).opLastSt}))}));
}
done();
