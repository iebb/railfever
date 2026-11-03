// Consumed plain-track controls are retired only during authorized completed double-track signalling.
import { Game, PLAYER } from '../src/game/game';
import { type LineInfo } from '../src/game/ai';
import { connectStationThroat, planDoubleTrack, commitDoubleTrack, finishDoubleTrack } from '../src/game/trackops';
import { upgradeRoute, lineIsDouble } from '../src/game/dualtrack';
import { setSignal } from '../src/game/signals';
import { serialize, deserialize } from '../src/game/save';
import { findSnap } from '../src/game/construction';
import { Train } from '../src/game/train';
import { station, endNode, nodeSnap, railOpts, build, depotFor, loco, check as assertCheck, done, runTrains } from './stationlib';
import { checkReservations } from './lib';
let assertions=0;
const check=(...args:Parameters<typeof assertCheck>)=>{assertions++;assertCheck(...args);};
const save=(g:Game)=>JSON.stringify(serialize(g));
const signal=(g:Game,id:number)=>{const n=g.world.net.nodes.get(id);return n&&JSON.stringify([n.signal,n.signalKind,n.signalPass]);};
function fixture(){
 const g=Game.create({size:384,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1990,aiCompanies:2});g.aiEnabled=false;g.world.h.fill(3);g.world.heightsVersion++;
 for(const c of g.companies)c.economy.money=1e8;
 const A=station(g,30,192,Math.PI/2,12,2,1)!,B=station(g,348,192,Math.PI/2,12,2,1)!,C=station(g,266,114,Math.PI*.75,12,2,1)!;
 if(!A||!B||!C)throw Error('native stations');
 if(!build(g,nodeSnap(g,endNode(g,A,1,true),'rail'),nodeSnap(g,endNode(g,B,1,false),'rail'),railOpts(1),'main'))throw Error('native main');
 for(const s of[A,B])connectStationThroat(g,s.id,1);
 const l=g.lines.create('rail',1);l.stops=[A.id,B.id];l.incomeLast=1e6;const dep=depotFor(g,A,B,1),ai=g.aiOf(1)!;
 (ai as any).lines.set(l.id,{kind:'rail',towns:[],depot:dep,maxVehicles:4,opened:-720} satisfies LineInfo);
 if(!build(g,findSnap(g,'rail',160,191.51,.5),nodeSnap(g,endNode(g,C,1,false),'rail'),railOpts(1),'branch'))throw Error('native branch');
 connectStationThroat(g,C.id,1);if(!ai.upgradeLine(l.id))throw Error('native trunk upgrade');
 const branch=g.lines.create('rail',1);branch.stops=[A.id,C.id];branch.incomeLast=1e6;
 (ai as any).lines.set(branch.id,{kind:'rail',towns:[],depot:dep,maxVehicles:3,opened:g.day} satisfies LineInfo);
 return{g,A,B,C,l,branch,dep};
}
const base=fixture(),snapshot=save(base.g),signalled=new Map([...base.g.world.net.nodes.values()].filter(n=>n.signal&&n.edges.length===2).map(n=>[n.id,signal(base.g,n.id)]));
let consumed:number[]=[];
for(const kind of ['block','path'] as const){
 const g=deserialize(JSON.parse(snapshot)),cold=deserialize(JSON.parse(snapshot)),branch=g.lines.get(base.branch.id)!;
 if(kind==='path')for(const h of[g,cold])for(const id of consumed){const n=h.world.net.nodes.get(id)!,e=h.world.net.edges.get(n.edges[0])!,at=e.a===id?0:e.len;const forward=(e.a===id?h.world.net.signalFor(n,e.sa)>0:h.world.net.signalFor(n,-e.sb)>0);check(!setSignal(h,e.id,at,'oneway',forward,1,{signalKind:kind,pass:!!n.signalPass}),'native owner explicitly sets the path control before its lead changes');}
 check(g.aiOf(1)!.upgradeLine(branch.id)&&cold.aiOf(1)!.upgradeLine(branch.id),'native branch upgrade completes live and after load');
 const ids=[...signalled.keys()].filter(id=>(g.world.net.nodes.get(id)?.edges.length??0)>2);if(kind==='block')consumed=ids;
 check(ids.length>0,'the actual new branch consumes an existing degree-two control');
 check(ids.every(id=>!g.world.net.nodes.get(id)!.signal),`completed ${kind} control does not remain at a new turnout`);
 check(lineIsDouble(g,g.lines.get(base.l.id)!,1)&&lineIsDouble(g,branch,1),'both native routes and terminal approaches remain fully double');
 check(save(g)===save(cold),'native finishing and money are exactly cold/warm reproducible');
 const trains:Train[]=[];for(const l of[g.lines.get(base.l.id)!,branch])for(let i=0;i<2;i++){const t=g.vehicles.buyTrain(base.dep,loco(),l.id);if(!(t instanceof Train))throw Error(String(t));trains.push(t);}
 const h=deserialize(JSON.parse(save(g)));let exact=true,errors=0,physical=true;
 const center=(t:Train)=>{const p={x:0,y:0,z:0};t.pointBehind(t.length/2,p);return p;};
 for(let i=0;i<128;i++){
   const before=trains.map(t=>t.onMap?center(t):null);g.stepTick();h.stepTick();exact&&=save(g)===save(h);errors+=checkReservations(g).length;
   trains.forEach((t,j)=>{const p=before[j];if(p&&t.onMap){const q=center(t);physical&&=Math.hypot(q.x-p.x,q.y-p.y,q.z-p.z)<=t.maxSpeed*g.tickSeconds+.02;}});
 }
 check(trains.some(t=>t.onMap&&t.segs.some(s=>s.e>=0)),'the safety replay includes actual paid stock occupying native track');
 check(exact&&errors===0&&physical,'paid occupied native junction admission replays every tick with clean reservations and continuous bodies');
 if(kind==='block'){const r=runTrains(g,trains,720);console.log(`  native consumed block: arrivals ${trains.map(t=>r.arrivals.get(t.id)?.length??0).join('/')}, longest ${r.worst.days} days`);check(trains.every(t=>(r.arrivals.get(t.id)?.length??0)>=6)&&r.worst.days<30&&checkReservations(g).length===0,'all four paid services retain the original junction call and waiting guarantees');}
}
// Formation authorization refuses before it can touch existing manually controlled infrastructure.
for(const access of[false,true]){
 const g=deserialize(JSON.parse(snapshot));g.setAccessPolicy(1,'ask');if(access){g.setAccessPolicy(1,'auto-approve');g.requestAccess(2,1);g.blockCompany(1,2);}
 const before=save(g),res=finishDoubleTrack(g,[...g.world.net.edges.values()].filter(e=>e.kind==='rail').map(e=>e.id),2);
 check(!!res.error&&save(g)===before,`${access?'revoked':'absent'} native upgrade permission preserves every foreign signal, title, reservation and account`);
}
// Native splitting must preserve a still-valid degree-two manual signal at an unchanged endpoint.
{
 const g=deserialize(JSON.parse(snapshot)),n=[...g.world.net.nodes.values()].find(n=>n.signal&&n.edges.length===2&&n.edges.some(id=>g.world.net.edges.get(id)!.len>5))!;
 const e=g.world.net.edges.get(n.edges.find(id=>g.world.net.edges.get(id)!.len>5)!)!;
 check(!setSignal(g,e.id,e.a===n.id?0:e.len,'twoway',true,1,{signalKind:'path',pass:true}),'owner can set an actual manual degree-two control');
 const prior=signal(g,n.id),split=g.world.net.splitEdge(e.id,e.len/2);
 check(!!split&&g.world.net.nodes.get(n.id)!.edges.length===2&&signal(g,n.id)===prior,'plain native edge split preserves the valid endpoint manual control');
 const before=[...g.world.net.nodes.values()].filter(n=>n.signal).map(n=>[n.id,signal(g,n.id)]),money=g.company(1).economy.money;
 const route=upgradeRoute(g,base.A.id,base.C.id,1),plans=[-1,1].map(side=>planDoubleTrack(g,route,side as 1|-1,1)),plan=plans.find(p=>p.ok);if(!plan)throw Error('native additional lead quote');
 const res=commitDoubleTrack(g,plan,true,{},()=>false);
 check(!!res.error&&g.company(1).economy.money===money&&before.every(([id,s])=>signal(g,id as number)===s),'refused native formation restores funds and leaves every retained manual control unchanged');
}
// Access alone does not authorize an AI to alter a player's manually signalled formation.
{
 const g=Game.create({size:256,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1990,aiCompanies:2});g.aiEnabled=false;g.world.h.fill(3);g.world.heightsVersion++;g.economy.money=1e8;
 const A=station(g,30,128,Math.PI/2,12,2,PLAYER)!,B=station(g,225,128,Math.PI/2,12,2,PLAYER)!;
 const works=build(g,nodeSnap(g,endNode(g,A,1,true),'rail'),nodeSnap(g,endNode(g,B,1,false),'rail'),railOpts(PLAYER),'protected manual formation');if(!works)throw Error('native player formation');
 const e=[...g.world.net.edges.values()].filter(e=>e.station<0&&e.depot<0).sort((a,b)=>b.len-a.len)[0];
 check(!setSignal(g,e.id,e.len/2,'twoway',true,PLAYER,{signalKind:'block'}),'player buys a native manual block control');
 g.setAccessPolicy(PLAYER,'auto-approve');g.requestAccess(2,PLAYER);check(g.canUse(2,PLAYER),'AI has a native access agreement for the protected player formation');
 const before=save(g),route=upgradeRoute(g,A.id,B.id,PLAYER),plan=planDoubleTrack(g,route,1,2),finished=finishDoubleTrack(g,route,2);
 check(!plan.ok&&/player/i.test(plan.errors.join(' '))&&/player/i.test(finished.error??'')&&save(g)===before,'native planning and finishing preserve accessible player manual controls without upgrade authorization');
}
console.log(`${assertions} native junction signalling assertions`);
done();
