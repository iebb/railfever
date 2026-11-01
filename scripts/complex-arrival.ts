// Native paid arrivals may finish by walking to another public part of the same station.
// Bundle as complex-arrival.mjs. No manual cargo injection, serveStation call or vehicle placement.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { Train } from '../src/game/train';
import { RoadVehicle } from '../src/game/roadvehicle';
import { DAY_SECONDS } from '../src/game/constants';
import { WALK_LINE } from '../src/game/stations';
import { fareFor, stationFareContext, simNow, transferFareFactor } from '../src/game/fares';
import { addTramTracks } from '../src/game/build-ops';
import { pathPoints, tramDepotGen } from '../src/game/ai-tram';
import { runGen } from '../src/game/routing';
import { flatGame, station } from './stationlib';
import { build, free, roadOpts, connectStations, depotBehind, addBusStop, roadDepotNear, check, fails, checkReservations } from './lib';

const saved = (g: Game) => JSON.stringify(serialize(g));
type Kind = 'rail' | 'road' | 'tram';
function fixture(kind: Kind) {
  const g = flatGame(256, 4); g.aiEnabled = false;
  const town = (name: string, x: number, z: number) => {
    const t: any = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius: 24, buildings: new Set(), nextGrowthDay: 1e9,
      hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
    g.towns.list.push(t); return t;
  };
  const originTown = town('Arrival North', 130, 123), platformTown = originTown, finalTown = town('Arrival South', 130, 143);
  check(build(g, free(g, 45, 134), free(g, 220, 134), roadOpts(0, 'street')), `${kind}: paid native pedestrian street`);
  const A = station(g, 75, 128, Math.PI / 2, 10, 2), B = station(g, 135, 128, Math.PI / 2, 10, 2);
  if (!A || !B) throw Error('native stations unavailable');
  check(connectStations(g, A, B).ok, `${kind}: funded native rail corridor`);
  const near = (sid: number) => {
    const st = g.stations.get(sid)!, points: { x: number; z: number; d: number }[] = [];
    for (const e of g.world.net.edges.values()) if (e.kind === 'road' && e.depot < 0) for (const f of [.1, .25, .5, .75, .9]) {
      const p = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(e, e.len * f, p);
      const plan = g.stations.planBusStop(p.x, p.z, 0);
      if (plan.ok && plan.join?.id === sid) points.push({ ...p, d: Math.hypot(p.x - st.x, p.z - st.z) });
    }
    points.sort((a, b) => a.d - b.d); return points[0];
  };
  for (const sid of [A.id, B.id]) {
    const p = near(sid);
    check(p && addBusStop(g, p.x, p.z, 0) === sid, `${kind}: native surface curb joins its railway part`);
  }
  const visitor=g.addAICompany({startMoney:10_000_000,accessPolicy:'auto-reject'});
  const C=addBusStop(g,131,134,visitor.id),D=addBusStop(g,200,134,visitor.id);
  check(C>0&&D>0&&C!==B.id&&!g.stations.link(B.id,C),`${kind}: distinct foreign destination accepts a public walking passage`);
  const final=g.stations.get(C)!;
  check(B.townId===platformTown.id&&final.townId===finalTown.id&&B.townId!==final.townId,
    `${kind}: native complex crosses the town boundary, so delivery must credit the final town`);
  function lots(t: any, xs: number[]) {
    for (const x of xs) {
      const b = g.world.addBuilding({ townId: t.id, x, z: 135.5, angle: Math.PI, w: 1, d: 1, type: 4, floors: 8, pop: 300, seed: x, y: 4, built: 0 });
      t.buildings.add(b.id); t.pop += b.pop;
    }
  }
  lots(originTown,[55,60,65,70,75,80,85]);lots(finalTown,[110,115,120,125,130]);lots(platformTown,[140,145,150,155,190,195,200,205,210]);
  g.demand.rebuild();
  const bg=g.lines.create('road',visitor.id);bg.stops=[C,D];
  const bgDepot=roadDepotNear(g,200,134,visitor.id),bgBus=g.vehicles.buyRoad(bgDepot,MODEL_BY_ID.get('bus_c')!,bg.id);
  check(bgBus instanceof RoadVehicle,`${kind}: destination has a paid native onward service`);
  const line=g.lines.create(kind,0);line.stops=[A.id,B.id];
  let depot:number;
  if(kind==='rail')depot=depotBehind(g,A,B);
  else if(kind==='road')depot=roadDepotNear(g,75,134,0);
  else{
    const edges=[...g.world.net.edges.values()].filter(e=>e.kind==='road'&&e.depot<0&&g.canUse(0,e.owner)).map(e=>e.id);
    const works=addTramTracks(g,edges,0);check(!works.error&&works.changed>0&&works.cost>0,'tram: native tracks paid');
    depot=runGen(tramDepotGen(g,pathPoints(g,edges),[A.id,B.id],0));
  }
  const v=kind==='rail'?g.vehicles.buyTrain(depot,['diesel_a','coach_steel'].map(id=>MODEL_BY_ID.get(id)!),line.id)
    :g.vehicles.buyRoad(depot,MODEL_BY_ID.get(kind==='road'?'bus_c':'tram_b')!,line.id);
  if(!(v instanceof Train||v instanceof RoadVehicle))throw Error(`${kind}: native stock purchase failed: ${v}`);
  g.flushNetworkChanges();g.lines.flushCatchment();
  check(g.lines.stationServed(C)&&g.lines.nextHop(A.id,C)?.line===line.id&&!g.lines.nextHop(B.id,C)
    &&g.lines.nextHop(B.id,D)?.line===WALK_LINE,`${kind}: actual graph has paid approach, omitted final pure walk and active ordinary onward transfer`);
  check(!g.canUse(0,visitor.id),`${kind}: public passenger passage does not require operating the foreign facility`);
  return { g, A: A.id, B: B.id, C, D, vehicle: v.id };
}

function scenario(kind:Kind){
  const f=fixture(kind),{g,A,B,C,D,vehicle}=f;
  let checkpoint:string|undefined;
  const deadline = g.day + 360;
  while (!checkpoint && g.day < deadline) {
    const v=g.vehicles.get(vehicle)!;
    if(v.state==='running'&&[...v.cargo.values()].some(c=>c.alight===B&&c.dest===C))checkpoint=saved(g);
    else g.stepTick();
  }
  check(checkpoint,`${kind}: native generated passengers board and approach their linked final facility`);
  if(!checkpoint)return;
  const twin=deserialize(JSON.parse(checkpoint)),unlinked=deserialize(JSON.parse(checkpoint));
  unlinked.stations.unlink(B,C);unlinked.flushNetworkChanges();unlinked.lines.flushCatchment();
  const beforeReads=saved(g);
  for(let n=0;n<4;n++){g.lines.nextHop(B,C);g.stations.isSameStationComplex(B,C);}
  check(saved(g)===beforeReads,`${kind}: route and complex membership reads remain fully saved-state pure`);
  let arrivals=0,onward=0,unlinkedArrivals=0, firstArrivalTick:number|undefined;
  const observe=(world:Game,linked:boolean)=>{
    const v=world.vehicles.get(vehicle)!,native=v.serveStation.bind(v);
    v.serveStation=(st,perPax)=>{
      const groups=[...v.cargo.values()].filter(c=>c.alight===st.id);
      const final=groups.filter(c=>c.dest===C),count=final.reduce((n,c)=>n+c.count,0);
      const direct=groups.filter(c=>c.dest===st.id).reduce((n,c)=>n+c.count,0);
      const transfers=groups.filter(c=>c.dest===D).reduce((n,c)=>n+c.count,0);
      const destination=world.stations.get(C)!,destTown=world.towns.list[destination.townId],stopTown=world.towns.list[st.townId];
      const before={arrived:destination.arrivedMonth,transported:destTown.passTransMonth,platform:stopTown.passTransMonth,
        delivered:v.delivered,income:v.incomeYear,load:v.load,waiting:world.stations.get(C)!.waitingTotal};
      const mode=kind==='rail'?'rail':kind==='tram'?'tram':'bus';
      const now=simNow(world);
      const expected=groups.reduce((n,c)=>{
        const from=world.stations.get(c.from)!;const ctx=stationFareContext(world,from,st,mode);
        const fare=fareFor(Math.hypot(from.x-st.x,from.z-st.z),now-(c.t0??c.day*DAY_SECONDS),c.count,
          mode==='rail'&&(c.rail??0)>0?{...ctx,railBefore:c.rail}:ctx);
        return n+fare*transferFareFactor(c.transfers??0,c.count);
      },0);
      const dwell=native(st,perPax); // Called only by the native driver as it actually reaches the stop.
      if(st.id===B&&count>0){
        if(linked){
          if(world===g){arrivals+=count;firstArrivalTick??=world.tick;}
          check(destination.arrivedMonth-before.arrived===count&&destTown.passTransMonth-before.transported===count,
            `${kind}: actual paid arrival credits every passenger to the exact final facility/town`);
          check(v.delivered-before.delivered===direct+count&&stopTown.passTransMonth-before.platform===direct,
            `${kind}: completed passengers are counted once, not delivered to the neighboring platform town`);
          check(Math.abs(v.incomeYear-before.income-expected)<1e-7,
            `${kind}: final internal walk preserves exact native fare and prior change/history factors`);
          const unloaded=groups.reduce((n,c)=>n+c.count,0),boarded=v.load-before.load+unloaded;
          check(dwell===2+(unloaded+boarded)*perPax,`${kind}: unloading/boarding counts and native dwell are preserved`);
        }else{unlinkedArrivals+=count;check(destination.arrivedMonth===before.arrived&&destTown.passTransMonth===before.transported,
          `${kind}: merely nearby unlinked destinations are never delivered by the fallback`);}
      }
      if (st.id === B && linked && transfers) {
        if (world === g) onward += transfers;
        check(world.stations.get(C)!.waitingTotal - before.waiting === transfers,
          `${kind}: active ordinary onward passengers still wait for their actual next service`);
      }
      return dwell;
    };
  };
  observe(g,true);observe(twin,true);observe(unlinked,false);
  let exact=true;
  const until=g.day+180;
  while(g.day<until){
    g.stepTick();twin.stepTick();unlinked.stepTick();
    // Compare every tick across the saved approach, native delivery and subsequent dwell/departure.
    // Continue both native worlds through the ordinary-transfer observation, then compare the entire final save.
    if ((firstArrivalTick === undefined || g.tick <= firstArrivalTick + 160) && saved(g) !== saved(twin)) { exact = false; break; }
  }
  exact &&= saved(g)===saved(twin);
  check(arrivals>0&&unlinkedArrivals>0&&exact,`${kind}: mid-approach save/cold reload continues exactly through actual native delivery and unlinked control`);
  check(onward>0,`${kind}: generated passengers also exercise the unchanged active onward transfer`);
  check(!checkReservations(g).length&&!checkReservations(twin).length,`${kind}: arrivals retain legal physical reservations`);
  // Walk-only journeys have no paid vehicle leg and are deliberately absent from the origin router.
  const income=g.lines.get(g.vehicles.get(vehicle)!.lineId!)!.incomeYear;
  check(!g.lines.nextHop(B,C)&&!g.demand.weights(g.stations.get(B)!).dest.includes(C)&&g.stations.isSameStationComplex(B,C)&&income>0,
    `${kind}: public final walking passage cannot generate a zero-ride fare`);
  console.log(`${kind}: ${arrivals} final-complex passengers completed; ${onward} active onward transfers; exact native replay`);
}
for(const kind of ['rail','road','tram']as const)scenario(kind);
console.log(fails.length?`${fails.length} FAILURES`:'ALL CHECKS PASSED');process.exitCode=fails.length?1:0;
