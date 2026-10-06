// Exact cached station projection: original coarse scan/refinement oracle, mutation guards and native quotations.
// Bundle as station-projection.mjs. --native-only [--native-json /tmp/report.json] isolates the small native timing fixture.
import { readFileSync, writeFileSync } from 'node:fs';
import { stationLocal, stationPose, type StationGeometry, type RailGeometryPiece, type RailGeometryTrack } from '../src/game/station-geometry';
import { arcTable, bezOffset, bezLine, bezDeriv, type Bez } from '../src/game/geom';
import { planStationOnTrack } from '../src/game/trackops';
import { serialize } from '../src/game/save';
import { flatGame, check, fails } from './stationlib';

/** The unmodified stationLocal algorithm; all projections must remain bit-identical to it. */
function original(r: StationGeometry, x: number, z: number) {
  if (!r.alignment) {
    const fx = Math.sin(r.angle), fz = Math.cos(r.angle);
    return { along: (x-r.x)*fx+(z-r.z)*fz, off: (x-r.x)*fz-(z-r.z)*fx };
  }
  let best = Infinity, along = 0;
  const n = Math.max(1, Math.ceil(r.length / .25));
  for (let i=0; i<=n; i++) {
    const a = -r.length/2+r.length*i/n, p=stationPose(r,0,a), d=(x-p.x)**2+(z-p.z)**2;
    if(d<best){best=d;along=a;}
  }
  let lo=Math.max(-r.length/2,along-r.length/n),hi=Math.min(r.length/2,along+r.length/n);
  const dist=(a:number)=>{const p=stationPose(r,0,a);return (x-p.x)**2+(z-p.z)**2;};
  for(let i=0;i<16;i++){const a=(2*lo+hi)/3,b=(lo+2*hi)/3;if(dist(a)<dist(b))hi=b;else lo=a;}
  along=(lo+hi)/2;
  const p=stationPose(r,0,along),tangent=(x-p.x)*p.fx+(z-p.z)*p.fz;
  if(along<-r.length/2+.001&&tangent<0||along>r.length/2-.001&&tangent>0)along+=tangent;
  return {along,off:(x-p.x)*p.fz-(z-p.z)*p.fx};
}
const curve: Bez={x0:70,z0:70,x1:70,z1:100,x2:100,z2:130,x3:130,z3:130};
const piece=(curve:Bez):RailGeometryPiece=>({curve,length:arcTable(curve).len,profile:Array(400).fill(3)});
const track=(offset:number):RailGeometryTrack=>{const p=piece(bezOffset(curve,offset));return{offset,pieces:[p],length:p.length,knots:[{u:0,s:0},{u:20,s:p.length}]};};
const shape=():StationGeometry=>({x:95,z:103,y:3,angle:.4,length:20,alignment:{tracks:[track(-1.5),track(1.5)]}});
let comparisons=0;
function exact(r:StationGeometry,x:number,z:number,label:string){
  const expected=original(r,x,z),actual=stationLocal(r,x,z); comparisons++;
  check(Object.is(expected.along,actual.along)&&Object.is(expected.off,actual.off),`${label}: exact coarse tie/refinement/tail projection`);
}
if(!process.argv.includes('--native-only')){
  for(const r of [shape(),{x:90,z:105,y:3,angle:1.1,length:20},{x:90,z:105,y:3,angle:1.1,length:20,alignment:{tracks:[]}}]){
    for(let i=0;i<60;i++){const x=65+(i%10)*8.1,z=70+Math.floor(i/10)*13.2;exact(r,x,z,'cold/warm grid');exact(r,x,z,'warm grid');}
  }
  const r=shape(),center=stationPose(r,0,0);
  exact(r,center.x,center.z,'coarse sampled point');
  for(const end of [-1,1]){const p=stationPose(r,0,end*(r.length/2+8));exact(r,p.x,p.z,'beyond terminus');}
  const t=r.alignment!.tracks[0];
  const edits:(()=>void)[]=[
    ()=>{r.length=23.125;},()=>{t.length+=1;},()=>{t.offset=-.1;},()=>{r.alignment!.tracks[1].offset=.01;},
    ()=>{r.alignment!.tracks.reverse();},()=>{r.alignment!.tracks[0].knots[1].s-=2;},
    ()=>{r.alignment!.tracks[0].knots.splice(1,0,{u:12,s:35});},
    ()=>{r.alignment!.tracks[0].pieces[0].curve.x1+=7;},()=>{r.alignment!.tracks[0].pieces[0].length+=3;},
    ()=>{r.alignment!.tracks[0].pieces[0]=structuredClone(r.alignment!.tracks[0].pieces[0]);},
    ()=>{const selected=r.alignment!.tracks[0];selected.pieces.push(piece(bezLine(130,130,150,145)));selected.length+=selected.pieces[1].length;},
    ()=>{r.alignment=structuredClone(r.alignment);},()=>{r.alignment!.tracks=[];r.x=61;r.z=73;r.angle=-0;},
    ()=>{r.y=9;r.angle=0;r.length=0;},()=>{r.alignment=undefined;},
  ];
  for(const edit of edits){edit();for(let i=0;i<8;i++)exact(r,65+i*7.1,85+i*2.7,'mutated XY inputs');}
  // Tie order stays the original first track; aliased and reconstructed ghost objects remain independent.
  const controls=shape(),controlCurve=controls.alignment!.tracks[0].pieces[0].curve;
  exact(controls,100,110,'controls warmup');
  for(const key of ['x0','z0','x1','z1','x2','z2','x3','z3'] as const){controlCurve[key]+=.5;exact(controls,101,109,`mutable ${key}`);}
  const multi=shape(),mt=multi.alignment!.tracks[0];mt.pieces.push(piece(bezLine(130,130,160,145)));mt.length=mt.pieces.reduce((n,p)=>n+p.length,0);mt.knots=[{u:0,s:0},{u:20,s:mt.length}];
  for(const query of [0,6,12,19]){const pos=stationPose(multi,0,query-10);exact(multi,pos.x+2,pos.z-1,'multiple physical pieces');}
  mt.pieces.reverse();exact(multi,120,130,'piece ordering mutation');mt.knots[0].u=-2;mt.knots[0].s=1;exact(multi,120,130,'first knot mutation');
  const tiePiece=piece(bezLine(0,0,0,0)),flat:StationGeometry={x:0,y:3,z:0,angle:0,length:20,alignment:{tracks:[{offset:0,length:0,pieces:[tiePiece],knots:[]}]}};
  exact(flat,0,0,'all coarse samples tie');exact(flat,7,9,'warm all-sample tie');
  const tied=shape();tied.alignment!.tracks=[track(1.5),track(-1.5)];
  exact(tied,100,110,'positive-offset first tie'); tied.alignment.tracks.reverse();exact(tied,100,110,'reversed equal-offset tie');
  const ghost={...tied},clone=structuredClone(tied); exact(ghost,100,110,'shared-track ghost');exact(clone,100,110,'fresh-piece ghost');
  clone.alignment!.tracks[0].pieces[0].curve.z2-=12;exact(clone,100,110,'independent ghost mutation');exact(tied,100,110,'original unaffected by ghost');
  // Profiles cannot affect XY/tangents; observe pose work without changing any profile values.
  const counted=shape(),selected=counted.alignment!.tracks[0].pieces[0],profile=selected.profile;let reads=0;
  Object.defineProperty(selected,'profile',{get(){reads++;return profile;},configurable:true});
  stationLocal(counted,100,110);const coldReads=reads;reads=0;stationLocal(counted,101,111);const warmReads=reads;
  check(warmReads<coldReads*.5,'warm projection removes repeated coarse stationPose work');
  selected.profile[3]=14;exact(counted,102,112,'height-only edit');
  const timed=shape(),originalTimes:number[]=[],cachedTimes:number[]=[];
  for(let warm=0;warm<8;warm++){original(timed,100,110);stationLocal(timed,100,110);}
  for(let run=0;run<4;run++)for(const mode of run%2?[1,0]:[0,1]){
    const start=performance.now();
    for(let i=0;i<120;i++){const x=85+(i%12)*2,z=95+Math.floor(i/12)*2;mode?stationLocal(timed,x,z):original(timed,x,z);}
    (mode?cachedTimes:originalTimes).push(performance.now()-start);
  }
  console.log(`local120-query median before ${[...originalTimes].sort((a,b)=>a-b)[2].toFixed(3)} ms, after ${[...cachedTimes].sort((a,b)=>a-b)[2].toFixed(3)} ms`);
  console.log(`${comparisons} bit-identical local projections; pose/profile reads cold ${coldReads}, warm ${warmReads}`);
}

const g=flatGame(256),net=g.world.net,rails=[];
for(let i=0;i<2;i++){
 const c=bezOffset(curve,i*.5),aD=bezDeriv(c,0),bD=bezDeriv(c,1);
 const a=net.addNode('rail',c.x0,3.1,c.z0,aD.x,aD.z,0),b=net.addNode('rail',c.x3,3.1,c.z3,bD.x,bD.z,0);
 rails.push(net.addEdge('rail',a.id,b.id,c,new Float32Array(300).fill(3.1),[],'standard',0));
}
const a=net.addNode('road',70,3,115,0,0,-1),b=net.addNode('road',104,3,144,0,0,-1);
net.addEdge('road',a.id,b.id,bezLine(a.x,a.z,b.x,b.z),new Float32Array(100).fill(3),[],'street',-1);
const before=JSON.stringify(serialize(g)),times:number[]=[],plans:string[]=[];
for(let i=0;i<7;i++){
 const start=performance.now(),p=planStationOnTrack(g,rails[0].id,rails[0].len/2,{length:20,tracks:2,reuseTrack:true,style:'modern'},0);
 times.push(performance.now()-start);plans.push(JSON.stringify(p));check(p.ok&&!!p.station?.alignment,'native curved station quote remains feasible');
}
check(plans.every(p=>p===plans[0]),'repeated native planning has exactly identical outputs');
check(JSON.stringify(serialize(g))===before,'native projections/planning leave saved state exactly unchanged');
const report={plan:JSON.parse(plans[0]),saved:before,times,median:[...times].sort((a,b)=>a-b)[3]};
const file=process.argv.indexOf('--native-json');if(file>=0)writeFileSync(process.argv[file+1],JSON.stringify(report));
const compare=process.argv.indexOf('--compare');if(compare>=0){const old=JSON.parse(readFileSync(process.argv[compare+1],'utf8'));check(JSON.stringify(old.plan)===plans[0]&&old.saved===before,'native plan and canonical saved state are identical to unmodified source');console.log(`native median before ${old.median.toFixed(3)} ms, after ${report.median.toFixed(3)} ms`);}
else console.log(`native same-input plan median ${report.median.toFixed(3)} ms, warm/cold output identical`);
console.log(fails.length?`${fails.length} FAILURES`:'ALL CHECKS PASSED');process.exitCode=fails.length?1:0;
