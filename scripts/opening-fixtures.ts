import {flatGame,endNode,build} from './stationlib';
import {free,roadOpts} from './lib';
import {buildDepotOnLine} from '../src/game/routing';
import type {Town} from '../src/game/towns';

// Survey seams supply real native proposals for a controlled flat formation. The production planner still
// prices, ranks, routes, commits and accepts the service; its real opening approve/fund closures buy the works.
export function controlledOpeningWorld(){
 const g=flatGame(384);g.options.startYear=1980;g.aiEnabled=false;g.aiAcquisitions=false;
 const towns:Town[]=[];
 for(const x of [30,350]){
  const t:Town={id:towns.length,name:'Funding '+towns.length,x,z:192,angle:Math.PI/2,pop:0,radius:24,buildings:new Set(),nextGrowthDay:1e9,hasChurch:false,passGenMonth:0,passTransMonth:0,passGenLast:0,passTransLast:0,served:0};
  towns.push(t);g.towns.list.push(t);
  for(const z of [184,200]){
   if(!build(g,free(g,x-18,z),free(g,x+18,z),roadOpts(0,'street'),'funding town street'))throw Error('controlled street');
   for(let dx=-16;dx<=16;dx+=2){const b=g.world.addBuilding({townId:t.id,x:x+dx,z:z+(z<192?-1.8:1.8),angle:0,w:1.4,d:1.4,type:4,floors:8,pop:30,seed:dx+16,y:3,built:0});t.buildings.add(b.id);}
  }
  g.towns.recomputePop(t);
 }
 const owner=g.addAICompany({startMoney:5_000_000,risk:.6}).id,ai=g.aiOf(owner)!;g.demand.rebuild();
 // A narrow, already developed corridor keeps the long second track's native demolition bill
 // separate from the short, clear optional throat. The blocks remain clear of the single formation.
 const blockers:number[]=[];
 for(const z of [187.3,196.7])for(let x=152;x<=232;x+=4)blockers.push(g.world.addBuilding({townId:-1,x,z,angle:0,w:2.2,d:2.2,type:6,floors:38,pop:50,seed:x,y:3,built:0}).id);
 const survey=g.stations.planRail,depot=(ai as any).depotNearLine,surveyOwn=Object.getOwnPropertyDescriptor(g.stations,'planRail'),depotOwn=Object.getOwnPropertyDescriptor(ai,'depotNearLine');
 g.stations.planRail=function(x,z,angle,length,tracks,payer,opts){
  // This is only a controlled proposal generator. Once construction starts, the real planner
  // revalidates the unchanged coordinates, stock clearance, access, costs and physical commits.
  if(payer===owner&&!(ai as any).project?.built){const t=towns[x<192?0:1];return survey.call(this,t.x,t.z,t.id===0?Math.PI/2:-Math.PI/2,length,tracks,payer);}
  return survey.call(this,x,z,angle,length,tracks,payer,opts);
 };
 (ai as any).depotNearLine=function*(){
  const A=[...g.stations.map.values()].find(st=>st.owner===owner&&st.townId===0);
  if(!A)throw Error('controlled native source station');
  const n=g.world.net.nodes.get(endNode(g,A,0,true))!,hit=g.world.net.nearestEdge(n.x+3,n.z,1,'rail',e=>e.station<0&&e.depot<0);
  if(!hit)throw Error('controlled native depot approach');
  const id=buildDepotOnLine(g,hit.edge.id,hit.s,owner,{dir:-1,side:1});
  if(id<0)throw Error('controlled native depot proposal');
  yield;return id;
 };
 return{g,ai,owner,blockers,restore(){if(surveyOwn)Object.defineProperty(g.stations,'planRail',surveyOwn);else delete(g.stations as any).planRail;if(depotOwn)Object.defineProperty(ai,'depotNearLine',depotOwn);else delete(ai as any).depotNearLine;}};
}
