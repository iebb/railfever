// Capacity pricing uses the native queue/fare response at each frequency, with directional full-cycle seats.
// Bundle as capacity-frequency.mjs and run with Node.
import { Game } from '../src/game/game';
import type { Town } from '../src/game/towns';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack } from '../src/game/lines';
import { stationEnds, nodeSnap, buildRailDepot } from '../src/game/routing';
import { planEdge, commitProposal } from '../src/game/construction';
import { finishDoubleTrack } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { patternHeadways, addPattern, setVehiclePattern } from '../src/game/patterns';
import { capacityRouteBetween } from '../src/game/rail-capacity-routes';
import { railPartMode } from '../src/game/stations';
import { estimateVehicleYear, YEAR_S } from '../src/game/opcosts';
import { serialize, deserialize } from '../src/game/save';
import { marginalSharedTrain, marginalSharedConsist, sharedCapacityPlan } from '../src/game/ai-capacity';
import { check, fails, checkReservations } from './lib';

if (!process.argv[1]?.endsWith('capacity-frequency.mjs')) throw new Error('bundle this test as capacity-frequency.mjs');
const near = (a: number, b: number) => Math.abs(a-b) < 1e-6 * Math.max(1, Math.abs(b));
const saved = (g: Game) => JSON.stringify(serialize(g));
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
function newTown(g: Game, name: string, x: number, z: number): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius: 60, buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false,
    passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  return t;
}
/**
 * A district of a town: a street grid every 8 units over [x0, x1] x [z - h/2, z + h/2] (rows along x; no street across
 * the railway's strip |dz| < 7 unless `cross`), apartment blocks on lots along the rows outside the strip, `pop` residents.
 * Lots near rail track or depots stay empty (the district grows around the railway).
 */
function district(g: Game, t: Town, x0: number, x1: number, z: number, h: number, pop: number, cross = false, strip = true) {
  const xs: number[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += 8) xs.push(x);
  const zs: number[] = [];
  for (let k = 0; k * 8 <= h + 1e-6; k++) zs.push(z - h / 2 + k * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) { if (!cross && zs[i - 1] < z && zs[i] > z) continue; road(g, rx, zs[i - 1], rx, zs[i]); }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x0 + 2; rx < x1; rx += 4) {
    if (strip && Math.abs(rz - z) < 7) continue;
    const near = g.world.net.edgesNear(rx - 2.5, rz + 1.1 - 2.5, rx + 2.5, rz + 1.1 + 2.5).some((e) => e.kind === 'rail')
      || g.depots.near(rx, rz + 1.1, 3).length > 0;
    if (near) continue;
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i + t.buildings.size, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  t.pop += pop;
  let x = 0, zz = 0, n = 0;
  for (const id of t.buildings) { const b = g.world.buildings.get(id)!; x += b.x; zz += b.z; n++; }
  if (n) { t.x = x / n; t.z = zz / n; }
  t.radius = Math.max(t.radius, (x1 - x0) * 0.6);
  g.demand.rebuild();
}


function fixture(pop = 13500, trainCount = 6, model = 'lrv_b', operators = 1, xs = [158,183,208,233,258,293,328]) {
  const g = Game.create({size:Math.max(512,Math.ceil((xs.at(-1)!+40)/256)*256),seed:5,towns:0,hilliness:'flat',water:'low',startYear:2000,
    aiConfigs:Array.from({length:operators},()=>({startMoney:150_000_000,accessPolicy:'open' as const}))});
  g.world.h.fill(4); g.world.heightsVersion++; g.aiEnabled=false; g.aiAcquisitions=false;
  g.vehicles.ambientEnabled=false; for(const ai of g.ais) ai.state.cooldown=1e9;
  const town=newTown(g,'Frequency City',240,256); district(g,town,xs[0]-8,xs.at(-1)!+14,256,32,pop);
  const sites=xs.map((x,i)=>{
    const owner=operators>1&&i===xs.length-1?2:1;
    const id=g.stations.nextId,p=g.stations.planRail(x,256,Math.PI/2,7,2,owner,{trackType:'lightrail',level:'ground',style:'none'});
    const err=p.ok?g.stations.commitRail(p,owner):p.error; if(err)throw new Error(err); return g.stations.get(id)!;
  });
  const start=g.world.net.nextEdge;
  for(let i=0;i+1<sites.length;i++){
    const a=stationEnds(g,sites[i])[0].front,b=stationEnds(g,sites[i+1])[0].back;
    const p=planEdge(g,nodeSnap(g,a,'rail'),nodeSnap(g,b,'rail'),{kind:'rail',type:'lightrail',tracks:2,heightOffset:0,crossing:'level',owner:1});
    const err=p.ok?commitProposal(g,p):p.errors.join(','); if(err)throw new Error(err);
  }
  const doubled=[...g.world.net.edges.values()].filter(e=>e.id>=start&&e.kind==='rail'&&e.station<0).map(e=>e.id);
  const depots=Array.from({length:operators},(_,i)=>buildRailDepot(g,i?sites.at(-1)!:sites[0],i+1,{x:i?-1:1,z:0}));
  if(depots.some(x=>x<0))throw new Error('frequency depot');
  finishDoubleTrack(g,doubled,1);
  const l=g.lines.create('rail',1);l.stops=outAndBack(sites.map(s=>s.id));
  for(let i=2;i<=operators;i++)g.lines.invite(l.id,i);
  g.lines.rebuild();autoSignalLine(g,l.id,1);
  const cars=[MODEL_BY_ID.get(model)!];
  function buy(owner=1){const t=g.vehicles.buyTrain(depots[owner-1],cars,l.id);if(!(t instanceof Train))throw new Error(String(t));return t;}
  for(let i=0;i<trainCount;i++)buy(1+i%operators);
  g.stations.refreshAccess(true);g.lines.flushCatchment();g.demand.rebuild();
  return {g,l,sites,cars,buy,depots};
}
function quote(f:ReturnType<typeof fixture>,n:number){
  const cycle=patternHeadways(f.g,f.l)[0].cycle,kmh=f.cars[0].speed*.6;
  const q=f.g.demand.forecastLine(f.sites,railPartMode(f.sites[0].rail!),kmh,cycle/n,f.l.owner,f.l.id);
  return {...q,cycle,peak:Math.max(...q.legLoads),seats:f.cars.reduce((s,c)=>s+c.capacity,0)*YEAR_S/cycle*.65*n};
}
function stockCost(f:ReturnType<typeof fixture>){
  let distance=0;
  for(let i=0;i<f.l.stops.length;i++)for(const id of capacityRouteBetween(f.g,f.l.stops[i],f.l.stops[(i+1)%f.l.stops.length],1)??[]){
    const e=f.g.world.net.edges.get(id)!;if(e.station<0)distance+=e.len;
  }
  const y=estimateVehicleYear(f.cars,distance/f.l.stops.length,f.g.year,.5);
  return y.total+distance/2*y.trackWearPerUnit+f.cars.reduce((s,c)=>s+c.cost,0)*.03;
}

const f=fixture(),six=quote(f,6),seven=quote(f,7),eight=quote(f,8);
const first=marginalSharedTrain(f.g,f.l,1,f.cars),cost=stockCost(f);
console.log(JSON.stringify({case:'native queues',six,seven,eight,first,cost}));
check(six.peak<six.seats&&seven.peak<seven.seats&&eight.peak<eight.seats,'six/seven/eight trains have genuine spare directional seats');
check(seven.boardings>six.boardings*1.1&&eight.revenue>seven.revenue,'more calls recover abandoned native queues and actual fares');
check(first>0&&near(first,seven.revenue-six.revenue-cost),'six to seven prices native recovered fares once, after running/wear/capital costs');
f.buy();const second=marginalSharedTrain(f.g,f.l,1,f.cars);
check(second>0&&near(second,eight.revenue-seven.revenue-cost),'seven to eight remains profitable against the same saved monthly reference');
const plan=sharedCapacityPlan(f.g,f.l);console.log(JSON.stringify({second,limit:plan.limit,physical:plan.physical}));
check(plan.limit<=plan.physical,'positive marginal bids still stop at the physical resource limit');

const bound=fixture(60000,1,'lrv_a'),q=quote(bound,1),bp=sharedCapacityPlan(bound.g,bound.l);
console.log(JSON.stringify({case:'seat bound',boards:q.boardings,peak:q.peak,seats:q.seats,quote:q.revenue,receipts:bp.revenue}));
check(q.peak>q.seats&&q.boardings>q.peak,'long riders occupy several legs while boardings and directional peak remain distinct');
check(near(bp.revenue,q.revenue*q.seats/q.peak),'native receipts obey full-cycle directional seats rather than multiplying seats by stops');


const long=fixture(60000,1,'lrv_a',1,[52,152,252,352,452,552,652]),longQuote=quote(long,1);
const longPlan=sharedCapacityPlan(long.g,long.l);
console.log(JSON.stringify({case:'long native cycle',cycle:longQuote.cycle,quote:longQuote.revenue,peak:longQuote.peak,
  seats:longQuote.seats,receipts:longPlan.revenue}));
check(longQuote.cycle>1000,'long service has an actual cycle over 1000 seconds');
check(near(longPlan.revenue,longQuote.revenue*Math.min(1,longQuote.seats/longQuote.peak)),
  'native revenue uses the real departure interval even on cycles longer than 1000 seconds');

// Lost journeys and actual receipts remain the demand floor, including their implied extra riders.
const floor=fixture();floor.l.incomeLast=20_000_000;floor.sites[0].lostLast=300;
const fq=quote(floor,6),fp=sharedCapacityPlan(floor.g,floor.l),fd=floor.l.capacity!.demand!;
const boardingFloor=fd.boardings/fq.boardings;
console.log(JSON.stringify({case:'observed/lost floor',nativeBoardings:fq.boardings,savedBoardings:fd.boardings,
  budget:fd.revenue,peak:fq.peak*boardingFloor,seats:fq.seats,receipts:fp.revenue}));
check(fd.revenue>floor.l.incomeLast&&boardingFloor>1&&fq.peak*boardingFloor>fq.seats,
  'actual receipts and lost passengers establish a binding saved boarding floor');
check(near(fp.revenue,fd.revenue*fq.seats/(fq.peak*boardingFloor)),
  'saved excess boardings scale directional native occupation before protected receipts are credited');
const highFare=deserialize(JSON.parse(saved(bound.g))),hl=highFare.lines.get(bound.l.id)!;
hl.capacity!.demand!.revenue*=2;
check(near(sharedCapacityPlan(highFare,hl).revenue,bp.revenue*2),
  'a higher fare-only saved budget keeps the same passenger occupation instead of multiplying demand by money');
const consist=fixture(60000,2,'lrv_a',2),bt=consist.g.vehicles.get(consist.l.vehicles[0]) as Train;
const coachBid=marginalSharedConsist(consist.g,consist.l,bt,[...consist.cars,...consist.cars]);
check(Number.isFinite(coachBid)&&coachBid>0,
  'a seat-bound complete service values extra seats without buying another path');

// Mixed operators share the same whole-route native frequency; each keeps its existing traffic/access weight.
const shared=fixture(13500,6,'lrv_b',2),sq=quote(shared,6),sp=sharedCapacityPlan(shared.g,shared.l);
check(near(sp.revenue,sq.revenue),'two complete operators recover one native revenue pool without duplication');
check(sp.allocations.length===2&&near(sp.allocations.reduce((n,a)=>n+a.traffic,0),shared.l.capacity!.demand!.revenue),
  'operator traffic weights conserve the saved corridor budget');
const accessBefore=JSON.stringify(shared.g.access);
const shareBid=marginalSharedTrain(shared.g,shared.l,2,shared.cars);
const leadBid=marginalSharedTrain(shared.g,shared.l,1,shared.cars);
console.log(JSON.stringify({case:'weighted operators',leadBid,partnerBid:shareBid,allocations:sp.allocations}));
check(leadBid>0&&shareBid<leadBid&&JSON.stringify(shared.g.access)===accessBefore,'partner and lead bids retain distinct traffic weights, access fees and rights');

for(const kind of ['loop','declared-loop','short-turn','mixed'] as const){
  const partial=fixture(13500,2);const {g,l,cars}=partial;
  if(kind==='loop'||kind==='declared-loop'){if(kind==='loop')l.stops=partial.sites.map(s=>s.id);l.loop=true;g.lines.rebuild();}
  else {
    const p=addPattern(g,l.id,'local',l.stops.map((_,i)=>i<=3||i>=l.stops.length-3))!;
    const trains=l.vehicles.map(id=>g.vehicles.get(id) as Train);
    for(const t of kind==='mixed'?trains.slice(0,1):trains)setVehiclePattern(g,t.id,p.id);
  }
  marginalSharedTrain(g,l,1,cars,(g.vehicles.get(l.vehicles[0]) as Train).pattern);
  let calls=0;const original=g.demand.forecastLine.bind(g.demand);
  g.demand.forecastLine=(...args)=>{calls++;return original(...args);};
  const before=saved(g);const value=marginalSharedTrain(g,l,1,cars,(g.vehicles.get(l.vehicles[0]) as Train).pattern);
  check(Number.isFinite(value)&&calls===0&&saved(g)===before,`${kind}: partial/circular pattern keeps the existing model, without whole-route quotes`);
}

// A saved monthly baseline and disposable price caches must agree even when callers use different orders.
const json=saved(shared.g),loaded=deserialize(JSON.parse(json)),ll=loaded.lines.get(shared.l.id)!;
check(saved(loaded)===json,'multioperator fixture loads exactly');
for(let i=0;i<640;i++){
  const before=saved(shared.g),coldBefore=saved(loaded);
  const a=marginalSharedTrain(shared.g,shared.l,2,shared.cars);
  const b=marginalSharedTrain(loaded,ll,2,shared.cars);
  const ap=sharedCapacityPlan(shared.g,shared.l),bp=sharedCapacityPlan(loaded,ll);
  if(!near(a,b)||JSON.stringify(ap)!==JSON.stringify(bp)||saved(shared.g)!==before||saved(loaded)!==coldBefore){
    check(false,`hot/cold price, agreement and serialized purity at replay tick ${i}`);break;
  }
  shared.g.stepTick();loaded.stepTick();
  if(saved(shared.g)!==saved(loaded)){check(false,`exact complete replay at tick ${i}`);break;}
}
check(shared.g.tick===640&&loaded.tick===640&&saved(shared.g)===saved(loaded),'all 640 fixed steps match complete saves with repeated economic pricing');
check(checkReservations(shared.g).length===0,'priced multioperator replay retains legal reservations');

// Eviction of more than the bounded native memo can hold cannot change a counterfactual price.
const eviction=fixture(),zero=marginalSharedTrain(eviction.g,eviction.l,1,eviction.cars),clean=saved(eviction.g);
for(let i=1;i<=140;i++){eviction.l.capacity!.delay=i*.1;marginalSharedTrain(eviction.g,eviction.l,1,eviction.cars);}
eviction.l.capacity!.delay=0;
check(near(marginalSharedTrain(eviction.g,eviction.l,1,eviction.cars),zero)&&saved(eviction.g)===clean,
  'native memo eviction preserves deterministic pricing and complete saved observations');

// Actual public edit hooks must invalidate both quotes and auctions in the same day.
const edited=fixture();marginalSharedTrain(edited.g,edited.l,1,edited.cars);sharedCapacityPlan(edited.g,edited.l);
let quoteCalls=0;const original=edited.g.demand.forecastLine.bind(edited.g.demand);
edited.g.demand.forecastLine=(...args)=>{quoteCalls++;return original(...args);};
function fresh(label:string,edit:()=>void){
  edit();const oldCalls=quoteCalls;const warm=sharedCapacityPlan(edited.g,edited.l);
  const snapshot=saved(edited.g),cold=deserialize(JSON.parse(snapshot)),cl=cold.lines.get(edited.l.id)!;
  const fresh=sharedCapacityPlan(cold,cl);
  check(quoteCalls>oldCalls&&JSON.stringify(warm)===JSON.stringify(fresh),`${label}: warm native auction matches a fresh saved price after same-day edit`);
  check(saved(edited.g)===snapshot&&saved(cold)===snapshot,`${label}: quote caches are disposable and reads leave complete saves unchanged`);
}
fresh('building',()=>district(edited.g,edited.g.towns.list[0],342,366,256,32,3000));
fresh('stock',()=>{edited.buy();});
fresh('route',()=>{edited.l.stops=outAndBack(edited.sites.slice(1).map(s=>s.id));edited.g.lines.rebuild();});
fresh('access',()=>{edited.g.setAccessPolicy(1,'ask');});
fresh('entrance',()=>{
  edited.sites[1].rail!.entrances.push({x:184,z:244.8,angle:Math.PI});
  edited.g.stations.refreshAccess(true);edited.g.lines.catchmentDirty=true;edited.g.lines.flushCatchment();
  edited.g.onNetworkChanged();
});

console.log(fails.length?`${fails.length} FAILURES`:'ALL CHECKS PASSED');process.exitCode=fails.length?1:0;
