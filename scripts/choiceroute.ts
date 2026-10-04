// Stage 2: exhaustive tiny-state oracle, physical-route fixtures, policy/save purity and map-768 timings.
// Bundle as choiceroute.mjs. Optional --timing runs natural AI networks (seeds 7/23, 768, day 900).
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { routeGraph, outAndBack } from '../src/game/lines';
import { lineTable } from '../src/game/patterns';
import { PHYSICAL_POLICY, LEGACY_POLICY } from '../src/game/travel-policy';
import { TravelRouter, compileStrategies, strategyAllows, boardingOption, optionAlights, strategyFlows, componentSum, type TieContext } from '../src/game/travel-choice';
import { physicalServices, preparePhysicalServices, TravelInputsChanged, clearTravelTimes, estimatePathTime, pathConsist, type PhysicalServices, type RideOption, type BoardingPart, type Passage } from '../src/game/travel-times';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { hopEstimate } from '../src/game/opcosts';
import { bezLine } from '../src/game/geom';
import { stationEnds, nodeSnap } from '../src/game/routing';
import { build, railOpts, depotBehind, roadDepotNear, addBusStop, Train, RoadVehicle } from './lib';
import type { Station } from '../src/game/stations';
import { RNG } from '../src/game/rng';
import { TRACK_TYPES } from '../src/game/constants';

if (!process.argv[1]?.endsWith('choiceroute.mjs')) throw new Error('bundle this test as choiceroute.mjs');
let passed = 0;
const test = (label: string, fn: () => void) => { fn(); passed++; console.log(`PASS ${label}`); };
const M = (id: string) => MODEL_BY_ID.get(id)!;
const tie: TieContext = { tripId: 47, originBuildingId: 21, destinationBuildingId: 31 };
const access = (part: string, timeMs = 0) => ({ part, timeMs });
function option(a: string, b: string, line: number, rideMs: number, frequency = .01, extra: Partial<RideOption> = {}): RideOption {
  return { fromPart: a, toPart: b, lineId: line, patternId: 0, boardOccurrence: 0, alightOccurrence: 1,
    boardOccurrences: [0], alightOccurrences: [1], boardDirection: 1, alightDirection: 1,
    serviceKey: `fleet:${line}`, vehicleIds: [line], frequency, rideMs, intermediateDwellMs: 0, pathRevision: 'fixture', ...extra };
}
function services(options: RideOption[], passages: Passage[] = [], ids?: string[]): PhysicalServices {
  const nodes = ids ?? [...new Set([...options.flatMap((o) => [o.fromPart, o.toPart]), ...passages.flatMap((w) => [w.fromPart, w.toPart])])];
  const parts = new Map(nodes.map((id, i) => [id, { id, stationId: i, kind: 'rail', edge: i, dir: 0, stop: -1 } as BoardingPart]));
  return { policy: PHYSICAL_POLICY, revision: 'fixture', parts, options, passages };
}

/** Independent oracle: enumerate every nonempty service subset, then every simple expanded-state path.
 * No production strategy compiler, heap, row, predecessor, tie or time-component helper is used here. */
function oracle(input: PhysicalServices, origins: { part: string; timeMs: number }[], destinations: { part: string; timeMs: number }[], context = tie) {
  const pairs = new Map<string, RideOption[]>();
  for (const o of input.options) {
    const key = JSON.stringify([o.fromPart, o.toPart]), arr = pairs.get(key) ?? [];
    const event = (x: RideOption) => JSON.stringify([x.lineId, x.patternId, x.serviceKey, x.boardOccurrence, x.fromPart, x.boardDirection]);
    const prev = arr.findIndex((x) => event(x) === event(o));
    if (prev < 0) arr.push(o); else if (o.rideMs < arr[prev].rideMs) arr[prev] = o;
    pairs.set(key, arr);
  }
  const ok = (o: RideOption) => JSON.stringify([o.lineId, o.patternId, o.serviceKey, o.boardOccurrence, o.alightOccurrence, o.fromPart, o.toPart, o.boardDirection, o.alightDirection]);
  const edges: { a: string; b: string; key: string; wait: number; ride: number; dwell: number }[] = [];
  for (const arr of pairs.values()) {
    assert(arr.length < 20, 'tiny oracle only');
    let selected: RideOption[] = [], expected = Infinity;
    for (let bits = 1; bits < 2 ** arr.length; bits++) {
      const subset = arr.filter((_, i) => bits & 2 ** i);
      const frequency = subset.reduce((n, o) => n + o.frequency, 0);
      const e = (500 + subset.reduce((n, o) => n + o.frequency * o.rideMs, 0)) / frequency;
      if (e < expected - 1e-7 || (Math.abs(e - expected) < 1e-7 && subset.length < selected.length)) { selected = subset; expected = e; }
    }
    const frequency = selected.reduce((n, o) => n + o.frequency, 0), o = selected[0];
    const total=Math.round(expected),dwell=Math.min(total,Math.round(selected.reduce((n,o)=>n+o.frequency*o.intermediateDwellMs,0)/frequency)),wait=Math.min(total-dwell,Math.round(500/frequency));
    edges.push({ a: o.fromPart, b: o.toPart, key: JSON.stringify([o.fromPart, o.toPart, selected.map(ok).sort()]),wait,ride:total-wait-dwell,dwell });
  }
  let best: { cost: number; key: string; components: number[]; rank: number } | undefined;
  const rank = (key: string) => {
    const s = JSON.stringify([context.tripId, context.originBuildingId, context.destinationBuildingId, key]);
    let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619); return h >>> 0;
  };
  for (const origin of origins) {
    function walk(part: string, state: number, cost: number, keys: unknown[], comp: number[], visited: Set<string>) {
      if (best && cost > best.cost) return;
      if (state === 1) for (const dest of destinations) if (part === dest.part) {
        const total = cost + dest.timeMs, key = JSON.stringify([origin.part, dest.part, keys]), r = rank(key);
        if (!best || total < best.cost || (total === best.cost && (r < best.rank || (r === best.rank && key < best.key)))) best = { cost: total, key, components: [...comp.slice(0, 6), dest.timeMs], rank: r };
      }
      for (const e of edges) if (e.a === part && !visited.has(`${e.b}/1`)) {
        const change = state === 1 ? 45000 : 0, next = [...comp]; next[1] += e.wait; next[2] += e.ride; next[3] += e.dwell; next[4] += change;
        walk(e.b, 1, cost + e.wait + e.ride + e.dwell + change, [...keys, ['r', e.key, change]], next, new Set([...visited, `${e.b}/1`]));
      }
      if (state !== 0) for (const p of input.passages) if (p.fromPart === part && !visited.has(`${p.toPart}/2`)) {
        const next = [...comp]; next[5] += p.walkMs;
        walk(p.toPart, 2, cost + p.walkMs, [...keys, ['w', p.fromPart, p.toPart, p.walkMs]], next, new Set([...visited, `${p.toPart}/2`]));
      }
    }
    walk(origin.part, 0, origin.timeMs, [], [origin.timeMs, 0, 0, 0, 0, 0, 0], new Set([`${origin.part}/0`]));
  }
  return best;
}
function compare(input: PhysicalServices, a = access('S'), b = access('D'), context = tie) {
  const expected = oracle(input, [a], [b], context), router = new TravelRouter(input);
  const actual = router.queryTransit([a], [b], context);
  assert.equal(actual?.costMs, expected?.cost);
  assert.equal(actual?.key, expected?.key);
  if (actual) { assert.deepEqual(Object.values(actual.components), expected!.components); assert.equal(componentSum(actual.components), actual.costMs); }
  return { router, actual };
}

test('slower walked arrival keeps cheaper continuation; physical change once', () => {
  const s = services([option('S','B',1,99500,1), option('S','A',2,94500,1), option('B','D',3,9500,1)], [{ fromPart:'A',toPart:'B',walkMs:10000 }]);
  const { actual } = compare(s);
  assert.equal(actual!.costMs,115000); assert.equal(actual!.components.changeMs,0); assert.equal(actual!.components.walkMs,10000);
});
test('through occurrence is one ride; matching line IDs alone never create it', () => {
  const legs = [option('S','B',1,20000,1/60),option('B','D',1,20000,1/60,{boardOccurrence:1,boardOccurrences:[1],alightOccurrence:2})];
  assert.equal(compare(services(legs)).actual!.costMs,145000);
  const through = option('S','D',1,45000,1/60,{alightOccurrence:2,intermediateDwellMs:5000});
  const { actual } = compare(services([...legs,through])); assert.equal(actual!.costMs,75000); assert.equal(actual!.steps.length,1); assert.equal(actual!.components.dwellMs,5000);
});
test('unequal-frequency pool, unattractive service, event deduplication and shared eligibility', () => {
  const fast=option('S','D',1,10000), frequent=option('S','D',2,15000,.02), slow=option('S','D',3,80000);
  const { actual,router }=compare(services([slow,fast,frequent,fast]));
  assert.equal(actual!.costMs,30000); const s=router.strategies[0]; assert.equal(s.options.length,2); assert.equal(s.waitMs,16667);
  strategyFlows(s).forEach((x,i)=>assert(Math.abs(x.share-[1/3,2/3][i])<1e-12));
  for(const [id,allowed] of [[1,true],[2,true],[3,false]] as const) assert.equal(strategyAllows(s,{part:'S',lineId:id,patternId:0,occurrence:0,direction:1,vehicleId:id}),allowed);
  for(const e of [{part:'other'},{occurrence:1},{direction:-1},{vehicleId:999}]) assert.equal(strategyAllows(s,{part:'S',lineId:1,patternId:0,occurrence:0,direction:1,vehicleId:1,...e}),false);
  assert.equal(compileStrategies([fast,{...frequent,fromPart:'other'}]).length,2);
  const short=compileStrategies([option('S','D',1,10000,.01,{boardOccurrences:[0,3],alightOccurrences:[1,4]})])[0];
  const boarded=boardingOption(short,{part:'S',lineId:1,patternId:0,occurrence:3,direction:1,vehicleId:1})!;assert(boarded);
  assert(optionAlights(boarded,{part:'D',lineId:1,patternId:0,occurrence:4,direction:1,vehicleId:1}));
  assert.equal(optionAlights(boarded,{part:'D',lineId:1,patternId:0,occurrence:3,direction:1,vehicleId:1}),false);
});
test('disconnected platforms do not connect; a declared passage supplies the change', () => {
  const opts=[option('S','B:track1',1,10000,1),option('B:track2','D',2,10000,1)];
  assert.equal(compare(services(opts)).actual,undefined);
  const actual=compare(services(opts,[{fromPart:'B:track1',toPart:'B:track2',walkMs:45000}])).actual!;
  assert.equal(actual.components.changeMs,0); assert.equal(actual.components.walkMs,45000);
});
test('walk-only, initial and final links cannot bypass first-board or egress eligibility', () => {
  assert.equal(compare(services([],[{fromPart:'S',toPart:'D',walkMs:1000}])).actual,undefined);
  assert.equal(compare(services([option('A','D',1,1000)],[{fromPart:'S',toPart:'A',walkMs:1000}])).actual,undefined);
  assert.equal(compare(services([option('S','A',1,1000)],[{fromPart:'A',toPart:'D',walkMs:1000}])).actual,undefined);
});
test('arbitrary passage chains, access/egress and component sums', () => {
  const walks=Array.from({length:6},(_,i)=>({fromPart:`w${i}`,toPart:`w${i+1}`,walkMs:1000}));
  const r=compare(services([option('S','w0',1,1000,1),option('w6','D',2,1000,1)],walks),access('S',1234),access('D',2345)).actual!;
  assert.equal(r.components.walkMs,6000); assert.equal(r.costMs,12579); assert.equal(r.components.changeMs,0);
});
test('exact stable ties use trip identity, independent of graph and cache order', () => {
  const opts=[option('S','A',1,1000,1),option('A','D',2,1000,1),option('S','B',3,1000,1),option('B','D',4,1000,1)];
  const keys=new Set<string>();
  for(let tripId=0;tripId<32;tripId++) {
    const ctx={...tie,tripId}, a=compare(services(opts),access('S'),access('D'),ctx).actual!;
    keys.add(a.key); assert.equal(compare(services([...opts].reverse(),[],['D','B','A','S']),access('S'),access('D'),ctx).actual!.key,a.key);
  }
  assert.equal(keys.size,2);
});
test('one half-headway, zero subjective penalty, Hop projection and row eviction', () => {
  const s=services([option('S','D',1,10000)]),router=new TravelRouter(s,0);
  const j=router.queryTransit([access('S')],[access('D')],tie)!;
  assert.equal(j.costMs,60000); assert.equal(j.components.waitMs,50000); assert.equal(j.components.changeMs,0);
  assert.deepEqual(router.projectHop(j),{line:1,alight:1,cost:60}); assert.equal(router.cachedRows,0);
  assert.equal(router.queryTransit([access('S')],[access('D')],tie)!.key,j.key);
  assert.equal(router.queryTransit([access('S')],[access('D')],tie,'rideArrival')!.costMs,105000);
  assert.equal(router.queryTransit([access('S')],[access('D')],tie,'walkArrival')!.costMs,60000);
  const done=router.queryTransit([access('D')],[access('D',1234)],tie,'rideArrival')!;
  assert.equal(done.costMs,1234);assert.equal(done.steps.length,0);assert.equal(router.projectHop(done),undefined);
});
test('tiny random graphs match exhaustive state paths and all service subsets', () => {
  const rng=new RNG(2307);
  for(let k=0;k<100;k++) {
    const opts:RideOption[]=[],walks:Passage[]=[];
    for(let a=0;a<5;a++)for(let b=0;b<5;b++)if(a!==b&&rng.next()<.25) {
      for(let q=0,n=1+rng.int(3);q<n;q++)opts.push(option(String(a),String(b),opts.length+1,1000*(1+rng.int(10)),(1+rng.int(4))/100));
    }
    for(let i=0;i<3;i++) {const a=rng.int(5),b=rng.int(5);if(a!==b)walks.push({fromPart:String(a),toPart:String(b),walkMs:1000*(1+rng.int(5))});}
    compare(services(opts,walks,['0','1','2','3','4']),access('0'),access('4'),{...tie,tripId:k});
  }
});

function flat(size=256) {
  const g=Game.create({size,seed:7,towns:0,hilliness:'flat',water:'low',startYear:2000});
  g.world.h.fill(4);g.world.heightsVersion++;g.economy.money=1e9;g.travelPolicy=PHYSICAL_POLICY;return g;
}
function station(g:Game,x:number,z:number,tracks=1) {
  const id=g.stations.nextId,p=g.stations.planRail(x,z,Math.PI/2,18,tracks,0,{trackType:'standard'});
  assert(p.ok,p.error);assert.equal(g.stations.commitRail(p,0),null);return g.stations.get(id)!;
}
function join(g:Game,a:Station,b:Station,trackA=0,trackB=0) {
  const ea=stationEnds(g,a)[trackA],eb=stationEnds(g,b)[trackB];
  assert(build(g,nodeSnap(g,ea.front,'rail'),nodeSnap(g,eb.back,'rail'),railOpts(),'fixture track'));
}
test('path integration: short hops, local limits, grades and hopEstimate comparison',()=>{
  const c=pathConsist([M('diesel_b'),M('coach_ic'),M('coach_ic')]);
  const profile=(xs:{lengthM:number;limitKmh:number;grade:number}[])=>({revision:'test',intervals:xs,lengthM:xs.reduce((a,x)=>a+x.lengthM,0)});
  const level=estimatePathTime(c,profile([{lengthM:1000,limitKmh:120,grade:0}]))!;
  const chord=hopEstimate(c,1000,c.seats*.5,120).t;
  console.log(`  straight 1000m: physical ${level.seconds.toFixed(3)}s, hopEstimate ${chord.toFixed(3)}s`);
  assert(level.seconds>chord*.5&&level.seconds<chord*1.5);
  assert(estimatePathTime(c,profile([{lengthM:.1,limitKmh:120,grade:0}]))!.seconds>0);
  const local=estimatePathTime(c,profile([{lengthM:900,limitKmh:120,grade:0},{lengthM:100,limitKmh:25,grade:0}]))!;
  const allSlow=estimatePathTime(c,profile([{lengthM:1000,limitKmh:25,grade:0}]))!;
  assert(local.seconds<allSlow.seconds*.8);assert(local.seconds>level.seconds);
  assert.equal(estimatePathTime(c,profile([{lengthM:100,limitKmh:120,grade:1}])),null);
  assert(estimatePathTime(c,profile([{lengthM:1000,limitKmh:120,grade:.02}]))!.seconds>level.seconds);
});
test('real rail geometry/speed edits invalidate with unchanged stops/fleet; static queries ignore reservations',()=>{
  const g=flat(),A=station(g,40,80),B=station(g,210,80);join(g,A,B);
  const dep=depotBehind(g,A,B,0),l=g.lines.create('rail',0);l.stops=[A.id,B.id];
  const t=g.vehicles.buyTrain(dep,[M('diesel_b'),M('coach_ic'),M('coach_ic')],l.id);assert(t instanceof Train);
  const saved=JSON.stringify(serialize(g)),rng=g.rng.state,s=physicalServices(g);assert(s.options.length>0);
  assert.equal(JSON.stringify(serialize(g)),saved);assert.equal(g.rng.state,rng);assert.equal(physicalServices(g),s);
  const reservations=g.vehicles.getRes;g.vehicles.getRes=()=>{throw new Error('profile read live reservations');};clearTravelTimes(g);
  assert.deepEqual(physicalServices(g).options,s.options);g.vehicles.getRes=reservations;
  const main=[...g.world.net.edges.values()].find(e=>e.kind==='rail'&&e.station<0&&e.depot<0&&e.len>100)!;
  clearTravelTimes(g);const preparation=preparePhysicalServices(g);let work=preparation.next(),units=0;
  while(!work.done){units++;work=preparation.next();}assert(units>20);assert.deepEqual(work.value.options,s.options);assert.equal(JSON.stringify(serialize(g)),saved);
  clearTravelTimes(g);const stale=preparePhysicalServices(g);assert.equal(stale.next().done,false);g.world.net.touchEdge(main);
  assert.throws(()=>stale.next(),TravelInputsChanged);assert(physicalServices(g).options.length);
  const first=s.options.find(o=>s.parts.get(o.fromPart)!.stationId===A.id)!;
  const oldSpeed=TRACK_TYPES.electric.speed;TRACK_TYPES.electric.speed=40;main.type='electric';g.world.net.touchEdge(main);
  const slow=physicalServices(g),second=slow.options.find(o=>slow.parts.get(o.fromPart)!.stationId===A.id)!;
  assert.notEqual(slow,s);assert(second.rideMs>first.rideMs);assert(second.frequency<first.frequency);
  TRACK_TYPES.electric.speed=oldSpeed;main.type='standard';g.world.net.touchEdge(main);const levelAgain=physicalServices(g);
  for(let i=0;i<main.prof.length;i++)main.prof[i]=4+.02*Math.min(i,main.prof.length-1-i);g.world.net.touchEdge(main);
  const grade=physicalServices(g);assert.notEqual(grade,levelAgain);assert.notEqual(grade.options[0].rideMs,levelAgain.options[0].rideMs);
  const before=JSON.stringify(serialize(g));const router=g.lines.shadowRouting()!;
  const from=router.services.options[0].fromPart,to=router.services.options[0].toPart;
  assert(g.lines.queryTransit([access(from)],[access(to)],tie));assert.equal(JSON.stringify(serialize(g)),before);
  // Restore the level profile, then measure an actual uncongested half-seat runtime hop.
  TRACK_TYPES.electric.speed=oldSpeed;main.type='standard';main.prof.fill(4);g.world.net.touchEdge(main);g.onNetworkChanged();
  t.load=t.capacity*.5;let departure=-1,origin=-1,measured=false;
  for(let i=0;i<12000&&!measured;i++) {
    const prev=t.state,at=t.atStation;g.stepTick();
    if(prev==='loading'&&t.state==='running'){departure=g.tick*g.tickSeconds;origin=at;}
    if(departure>=0&&prev==='running'&&t.state==='loading'&&t.atStation!==origin) {
      const view=physicalServices(g),o=view.options.find(o=>view.parts.get(o.fromPart)!.stationId===origin&&view.parts.get(o.toPart)!.stationId===t.atStation)!;
      const runtime=g.tick*g.tickSeconds-departure;console.log(`  rail runtime ${runtime.toFixed(3)}s, profile ${(o.rideMs/1000).toFixed(3)}s`);
      assert(Math.abs(runtime-o.rideMs/1000)<runtime*.12+1);measured=true;
    }
  }
  assert(measured);
});
test('one through pattern cannot bridge disconnected tracks of the same station',()=>{
  const g=flat(),A=station(g,40,140),B=station(g,125,140,2),C=station(g,210,140);
  join(g,A,B,0,0);join(g,B,C,1,0);
  const dep=depotBehind(g,A,B,0),l=g.lines.create('rail',0);l.stops=outAndBack([A.id,B.id,C.id]);
  assert(g.vehicles.buyTrain(dep,[M('diesel_b'),M('coach_ic')],l.id) instanceof Train);
  const s=physicalServices(g);assert.equal(s.options.length,0,'a closed physical pattern must be feasible');
});
test('actual road lanes/connectors, shortcuts and speed edits invalidate physical services',()=>{
  const g=flat(),net=g.world.net;
  const road=(x0:number,z0:number,x1:number,z1:number)=>{
    const a=net.nearestNode(x0,z0,.01,'road')??net.addNode('road',x0,4,z0),b=net.nearestNode(x1,z1,.01,'road')??net.addNode('road',x1,4,z1);
    return net.addEdge('road',a.id,b.id,bezLine(x0,z0,x1,z1),new Float32Array(Math.ceil(Math.hypot(x1-x0,z1-z0))+1).fill(4),[],'road',-1);
  };
  road(25,200,90,200);const middle=road(90,200,170,200);road(170,200,230,200);
  const A=addBusStop(g,50,200,0),B=addBusStop(g,205,200,0),dep=roadDepotNear(g,50,200,0);
  const l=g.lines.create('road',0);l.stops=[A,B];assert(g.vehicles.buyRoad(dep,M('bus_c'),l.id) instanceof RoadVehicle);
  const s=physicalServices(g);assert(s.options.length);const first=s.options[0];
  middle.type='street';net.touchEdge(middle);const slow=physicalServices(g);assert(slow.options[0].rideMs>first.rideMs);
  for(let i=0;i<middle.prof.length;i++)middle.prof[i]=4+.02*Math.min(i,middle.prof.length-1-i);net.touchEdge(middle);const grade=physicalServices(g);assert.notEqual(grade.options[0].rideMs,slow.options[0].rideMs);
  road(90,200,90,235);road(90,235,170,235);road(170,235,170,200);const shortcut=physicalServices(g);assert.notEqual(shortcut,grade);
  assert.equal(l.stops[0],A);assert.equal(l.vehicles.length,1);
  const bus=g.vehicles.get(l.vehicles[0]) as RoadVehicle;bus.load=bus.capacity*.5;
  let departure=-1,origin=-1,direction=0,measured=false;
  for(let i=0;i<18000&&!measured;i++) {
    const prev=bus.state,at=bus.targetStation()?.id??-1,dir=bus.seg?.dir??0;g.stepTick();
    if(prev==='loading'&&bus.state==='running'){departure=g.tick*g.tickSeconds;origin=at;direction=dir;}
    if(departure>=0&&prev==='running'&&bus.state==='loading'&&bus.targetStation()?.id!==origin) {
      const view=physicalServices(g),o=view.options.find(o=>view.parts.get(o.fromPart)!.stationId===origin&&view.parts.get(o.toPart)!.stationId===bus.targetStation()?.id&&o.boardDirection===direction);
      if(!o)continue;const runtime=g.tick*g.tickSeconds-departure;console.log(`  road runtime ${runtime.toFixed(3)}s, profile ${(o.rideMs/1000).toFixed(3)}s`);
      assert(Math.abs(runtime-o.rideMs/1000)<runtime*.12+1);measured=true;
    }
  }
  assert(measured);
});
test('saved flag, missing/unknown defaults, legacy/mail keys and shadow save/RNG purity',()=>{
  const g=flat(),net=g.world.net;
  const a=net.addNode('road',20,4,40),b=net.addNode('road',230,4,40);
  net.addEdge('road',a.id,b.id,bezLine(a.x,a.z,b.x,b.z),new Float32Array(211).fill(4),[],'road',-1);
  const A=addBusStop(g,50,40,0),B=addBusStop(g,200,40,0),dep=roadDepotNear(g,50,40,0),l=g.lines.create('road',0);l.stops=[A,B];
  assert(g.vehicles.buyRoad(dep,M('postbus_b'),l.id) instanceof RoadVehicle);
  g.travelPolicy=LEGACY_POLICY;assert.equal(g.lines.shadowRouting(),undefined);assert.equal(serialize(g).travelPolicy,undefined);
  assert.equal(routeGraph(g).policy,LEGACY_POLICY);assert.equal(routeGraph(g,'mail').policy,LEGACY_POLICY);
  assert.equal(lineTable(g,l).policy,LEGACY_POLICY);assert.equal(lineTable(g,l,'mail'),lineTable(g,l));
  const legacy=JSON.stringify([...g.lines.routing]),mail=JSON.stringify([...g.lines.mailRouting]);
  g.travelPolicy=PHYSICAL_POLICY;const json=JSON.stringify(serialize(g)),router=g.lines.shadowRouting()!;assert(router.strategies.length);
  assert.notEqual(router.policy,g.lines.mailRoutingPolicy);assert.equal(g.lines.routingByPolicy.get(LEGACY_POLICY)!.mail,g.lines.mailRouting);
  for(let i=0;i<10;i++)router.queryTransit([access(router.strategies[0].fromPart)],[access(router.strategies[0].toPart)],{...tie,tripId:i});
  assert.equal(JSON.stringify(serialize(g)),json);assert.equal(JSON.stringify([...g.lines.routing]),legacy);assert.equal(JSON.stringify([...g.lines.mailRouting]),mail);
  const loaded=deserialize(JSON.parse(json));assert.equal(loaded.travelPolicy,PHYSICAL_POLICY);assert.equal(JSON.stringify(serialize(loaded)),json);
  const missing=JSON.parse(json);delete missing.travelPolicy;assert.equal(deserialize(missing).travelPolicy,LEGACY_POLICY);
  missing.travelPolicy='future';assert.equal(deserialize(missing).travelPolicy,LEGACY_POLICY);
  for(let i=0;i<400;i++){g.stepTick();loaded.stepTick();}assert.equal(JSON.stringify(serialize(loaded)),JSON.stringify(serialize(g)));
});

if(process.argv.includes('--timing')) {
  const results=[];
  const stats=(xs:number[])=>{const s=[...xs].sort((a,b)=>a-b);return{median:s[Math.floor(s.length/2)],p99:s[Math.min(s.length-1,Math.floor(s.length*.99))],max:s.at(-1)};};
  for(const seed of [7,23]) {
    const g=Game.create({size:768,seed,towns:20,hilliness:'hilly',water:'medium',startYear:1980,aiCompanies:3});
    while(g.day<900)g.stepTick();g.travelPolicy=PHYSICAL_POLICY;
    const save=JSON.stringify(serialize(g));clearTravelTimes(g);let start=performance.now();
    const job=preparePhysicalServices(g),units:number[]=[];let done=false;
    while(!done){const at=performance.now();const next=job.next();units.push(performance.now()-at);done=!!next.done;}
    const preparationMs=performance.now()-start;start=performance.now();const router=g.lines.shadowRouting()!;
    const graphMs=performance.now()-start,profilesMs=preparationMs+graphMs,parts=[...router.services.parts.keys()];
    const queryAll=()=>{for(const p of parts){const dest=parts.filter(q=>q!==p).map(q=>access(q));router.queryTransit([access(p)],dest,tie);}};
    start=performance.now();queryAll();const coldRowsMs=performance.now()-start;
    const warm=[];for(let i=0;i<30;i++){start=performance.now();queryAll();warm.push(performance.now()-start);}
    const publication=[];for(let i=0;i<30;i++){start=performance.now();g.lines.shadowRouting();publication.push(performance.now()-start);}
    assert.equal(JSON.stringify(serialize(g)),save);
    const r={seed,size:768,day:900,node:process.version,stations:g.stations.map.size,parts:parts.length,options:router.services.options.length,strategies:router.strategies.length,preparationMs,graphMs,profilesMs,preparationUnits:units.length,preparationUnitMs:stats(units),coldRowsMs,coldTotalMs:profilesMs+coldRowsMs,warmAllSourcesMs:stats(warm),warmPublicationMs:stats(publication),cachedRows:router.cachedRows,cachedBytes:router.cachedBytes};
    results.push(r);console.log('TIMING '+JSON.stringify(r));
  }
  writeFileSync('choiceroute-timing.json',JSON.stringify(results,null,2)+'\n');
}
console.log(`ALL CHECKS PASSED (${passed} groups)`);
