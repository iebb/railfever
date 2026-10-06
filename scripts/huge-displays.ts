// Synthetic display load only; scripts/viewport-poses.ts separately verifies native operations/replay.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Game } from '../src/game/game';
import { World } from '../src/game/world';
import { Train, type TSeg } from '../src/game/train';
import { RoadVehicle, type RSeg } from '../src/game/roadvehicle';
import { makeCurve } from '../src/game/network';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize } from '../src/game/save';
import { VehiclesView } from '../src/render/vehicles-view';
import type { Materials } from '../src/render/materials';
import { createHash } from 'node:crypto';
const g=new Game({size:2048,seed:17,towns:0,hilliness:'flat',water:'low',startYear:2000},new World(2048));g.world.h.fill(3);g.world.heightsVersion++;g.aiEnabled=false;
const vehicles=g.vehicles;
// Match Network.geo's native .25-unit spacing for a48-unit lane (193 points).
const curve=(x:number,z:number)=>{const points=new Float32Array(193*3);for(let i=0;i<=192;i++){points[i*3]=x+i*.25;points[i*3+1]=3;points[i*3+2]=z;}return makeCurve(points);};
const lane=(e:number,x:number,z:number):RSeg=>{const c=curve(x,z);return {kind:'lane',e,dir:1,node:0,from:0,fromDir:1,curve:c,len:c.len,limit:4,tunnels:[],crossings:[]};};
let edge=1;
for(let row=0;row<16;row++)for(let col=0;col<16;col++){
 const x=64+col*120,z=64+row*120,s=lane(edge++,x,z);
 for(let k=0;k<8;k++){
  const model=k===0?MODEL_BY_ID.get('bus_c')!:k===1?MODEL_BY_ID.get('tram_c')!:null,ambient=!model,id=ambient?vehicles.nextAmbientId++:vehicles.nextId++;
  const v=new RoadVehicle(g,id,model,-1,ambient,row*128+col*8+k+1);v.placeAt(s,6+k*5);v.state='running';v.speed=.4;
  if(ambient)vehicles.ambient.push(v);else vehicles.map.set(id,v);
 }
 if((row*16+col)%4===0){const t=new Train(g,vehicles.nextId++,[MODEL_BY_ID.get('diesel_b')!,...Array(4).fill(MODEL_BY_ID.get('coach_ic')!)],-1),c=curve(x,z+16);t.segs=[{e:edge++,dir:1,curve:c,len:c.len,res:[],limit:4,tunnels:[]}];t.headSeg=0;t.headPos=28;t.state='running';t.speed=.7;vehicles.map.set(t.id,t);}
}
const all=[...vehicles.map.values(),...vehicles.ambient];
// Prime a previous committed pose without running unrelated synthetic operation logic.
for(const v of all)(vehicles as any).rememberPose(v);g.tick=1;(g as any).accumulator=g.tickSeconds*.5;
const hash=()=>createHash('sha256').update(JSON.stringify(serialize(g))).digest('hex');const before=hash();
const mats={glass:new THREE.MeshStandardMaterial(),uniforms:{uNight:{value:.8}}} as unknown as Materials,view=new VehiclesView(mats);
const originalPoint=vehicles.renderPointBehind.bind(vehicles);let queries=0;(vehicles as any).renderPointBehind=(...args:any[])=>{queries++;return (originalPoint as any)(...args);};
const camera=new THREE.PerspectiveCamera(60,1.5,.05,8000);
function cameraAt(x:number,y:number,z:number,tx:number,ty:number,tz:number){camera.position.set(x,y,z);camera.lookAt(tx,ty,tz);camera.updateMatrixWorld();}
function sample(name:string,pos:number[],target:number[],tracked:number[]=[]){
 cameraAt(pos[0],pos[1],pos[2],target[0],target[1],target[2]);view.setTrackedVehicleIds(tracked);
 // A valid previous committed pose for every load object isolates worst-case interpolation cost.
 const interest=(vehicles as any).renderInterest;vehicles.setRenderInterest(null);g.tick--;for(const v of all)(vehicles as any).rememberPose(v);g.tick++;vehicles.setRenderInterest(interest);
 for(let i=0;i<8;i++)view.update(g,1/60,1,1200,camera);
 const times:number[]=[];queries=0;
 for(let i=0;i<80;i++){const start=performance.now();view.update(g,1/60,1,1200,camera);times.push(performance.now()-start);}
 vehicles.renderPoseCount=0;for(const v of all)(vehicles as any).rememberPose(v);
 times.sort((a,b)=>a-b);const stats={name,vehicles:all.length,queriesPerFrame:queries/80,instances:view.instances,interest:vehicles.renderInterestSize,poseCopies:vehicles.renderPoseCount,coarseSkipped:(view as any).coarseCulled??0,smoke:view.smoke.count,avgMs:times.reduce((a,b)=>a+b,0)/times.length,p95Ms:times[Math.floor(times.length*.95)]};console.log('CASE',JSON.stringify(stats));return stats;
}
console.log('FIXTURE',JSON.stringify({size:2048,vehicles:all.length,curvePoints:193,previousPoses:'valid primed',nativeOperationFixture:'scripts/viewport-poses.ts'}));
const near=sample('near',[92,24,120],[92,3,80]);assert.ok(near.instances>0);
const pickedTrain=vehicles.trains()[0],pickedPoint=new THREE.Vector3();
vehicles.renderWorldPos(pickedTrain,pickedPoint);pickedPoint.y+=.1;view.group.updateMatrixWorld(true);
const pickRay=new THREE.Raycaster(camera.position,pickedPoint.sub(camera.position).normalize());
assert.equal(view.pick(pickRay),pickedTrain.id,'visible company train remains pickable');
const far=sample('tiny huge map',[1024,2800,-800],[1024,3,1024]);
assert.equal(far.instances,0);assert.equal(far.poseCopies,0,'tiny whole-map vehicles retain no pose copies');
const off=sample('off viewport',[1024,80,-240],[1024,3,-800]);assert.equal(off.instances,0);assert.equal(off.poseCopies,0);
const train=vehicles.trains()[0];const tracked=sample('off viewport tracked',[1024,80,-240],[1024,3,-800],[train.id]);assert.equal(tracked.instances,0);assert.equal(tracked.poseCopies,1);
assert.equal(hash(),before,'near/far/offscreen/tracking only change derived presentation');
console.log('PASS huge-map display changes preserve full serialized simulation state');
// Test conservative tails/previous curves directly when the new coarse helper is present.
const method=(view as any).coarseReject;
if(method){
 const visible=curve(70,80),hidden=curve(800,80),t=train;
 t.segs=[{e:10000,dir:1,curve:visible,len:visible.len,res:[],limit:4,tunnels:[]}];t.headSeg=0;t.headPos=20;t.length;
 vehicles.setRenderInterest(null);g.tick=40;(vehicles as any).rememberPose(t);t.segs=[{e:10001,dir:1,curve:hidden,len:hidden.len,res:[],limit:4,tunnels:[]}];g.tick++;
 cameraAt(92,24,120,92,3,80);view.update(g,1/60,1,1200,camera);
 assert.equal((view as any).coarseReject(t,hidden,t.length,2.6,150),false,'previous visible head curve cannot be rejected');
 // A head just beyond the frustum keeps a visible trailing car, including reversed consists.
 const current=curve(115,80);const tailCurve=curve(67,80);t.segs=[{e:10002,dir:1,curve:tailCurve,len:tailCurve.len,res:[],limit:4,tunnels:[]},{e:10003,dir:1,curve:current,len:current.len,res:[],limit:4,tunnels:[]}];t.headSeg=1;t.headPos=3;g.tick+=2;t.reversed=true;
 cameraAt(92,12,96,92,3,80);view.update(g,1/60,1,1200,camera);
 const tail=method.call(view,t,current,t.length,2.6,0);assert.equal(tail,false,'expanded full consist retains a tail near the view boundary');
 // Very nearby sound retains interpolation even behind the camera.
 cameraAt(90,8,80,90,8,20);view.update(g,1/60,1,1200,camera);assert.equal(method.call(view,t,visible,t.length,2.6,150),false);
 console.log('PASS previous head union, whole-tail/reversal and nearby offscreen audio bounds');
 // Replacement arrays and native revision reset must discard cached bounds.
 const replace=curve(900,900);const first=(view as any).bounds(replace).clone();replace.pts=new Float32Array([80,3,80,100,3,80]);const second=(view as any).bounds(replace);assert.notEqual(first.min.x,second.min.x);
 const mutable=curve(900,900);(view as any).bounds(mutable);mutable.pts.set([80,3,80,100,3,80]);g.world.net.version++;view.update(g,1/60,1,1200,camera);assert.equal((view as any).bounds(mutable).min.x,80);
 console.log('PASS point-array replacement and network revision invalidate curve bounds');
 // Road drape has arbitrary terrain Y: early rejection may use XZ but not the edge profile's height.
 const bus=vehicles.roads()[0],road=lane(10003,70,80);bus.seg=road;bus.pos=20;g.world.h.fill(300);g.world.heightsVersion++;
 cameraAt(92,315,120,92,300,80);view.update(g,1/60,1,1200,camera);assert.equal(method.call(view,bus,road.curve,bus.length,bus.length,0,true),false,'draped road body at terrain height must survive profile bounds');
 console.log('PASS conservative road-height frustum interval');
}
view.dispose();mats.glass.dispose();
