// Shared structures and width edits; bundle as section-structures.mjs and run from the scratch directory.
import { assert, flatGame, rawRail, state, scenario, done } from './sectionlib';
import { structureSpan, civilBills, verticalCounts, legacyCivil, civilLocks, portalBoundaries, renderCivil, sharedCivilRights, sharedCivilAccess } from './section-structurelib';
import { planSectionCount, commitRailSectionPlan } from '../src/game/rail-section-ops';
import { formationAt, structureBounds, validateFormation } from '../src/game/rail-structures';
import { bezLine, closestOnPolyline } from '../src/game/geom';
import { LOCK, recomputeLocks } from '../src/game/terraform';
import { parallelGroup } from '../src/render/build-structures';
import type { ChunkCtx } from '../src/render/build-common';
import { Overlay } from '../src/render/overlay';
import { makeSeg, Train } from '../src/game/train';
import { loco } from './stationlib';
import { serialize, deserialize } from '../src/game/save';
if (!process.argv[1]?.endsWith('section-structures.mjs')) throw new Error('bundle as section-structures.mjs');

scenario('one civil quote/bill; two→four→two→four keeps paid capacity and ordinary material/wear bills',civilBills);
scenario('curved elevated and underground growth preserves heights, member lengths/IDs and exact save replay',verticalCounts);
scenario('metadata-only, idempotent legacy/Stage-2 adoption preserves live maintenance and graph allocators',legacyCivil);
scenario('paid wider foundations and bore roofs retain locks through reductions and lock repairs',civilLocks);
scenario('one pair of portal boundaries survives unequal member splits, growth and chunk rendering',portalBoundaries);
scenario('access payer keeps civil and rail ownership; owner-only reductions, revocation and AI restrictions',sharedCivilRights);
scenario('access fees allocate the shared civil bill once, with equal usage paying half',sharedCivilAccess);
scenario('flat bridge quote and upkeep snapshot charges civil expansion exactly once',()=>{
  const g=flatGame(160),money=g.economy.money,s=structureSpan(g,2),snapshot:{[key:string]:number}={build:money-g.economy.money};
  for(const [key,count] of [['grow',4],['remove',2],['refill',4]] as const){const p=planSectionCount(g,s.id,count,{side:'right'});assert.equal(p.ok,true,p.error);snapshot[key]=p.cost;assert.equal(commitRailSectionPlan(g,p).error,null);}
  snapshot.civilMaintenance=g.railSections.structures.get(s.structures[0])!.maintenance;
  assert.deepEqual(Object.fromEntries(Object.entries(snapshot).map(([k,v])=>[k,Math.round(v)])),{build:4334880,grow:2492160,remove:70400,refill:792000,civilMaintenance:121770});
});
scenario('ground widening cannot leave new members floating over water outside the old formation',()=>{
  const g=flatGame(160),e=rawRail(g);g.railSections.adoptUnassigned();const s=g.railSections.get(g.railSections.membership(e.id)!.section)!;
  for(let x=20;x<=116;x++)for(let z=65;z<=68;z++)g.world.setVertex(x,z,-1);
  const before=state(g),p=planSectionCount(g,s.id,4,{side:'right'});assert.equal(p.ok,false);assert.match(p.error!,/water|steep/i);assert.equal(state(g),before);
});

scenario('blocked piers refuse widening before graph, economy, allocator, terrain or dirty changes',()=>{
  const g=flatGame(160),s=structureSpan(g,2),st=g.railSections.structures.get(s.structures[0])!;
  // The building clears the deck; its ground footprint occupies all possible widened support sites.
  g.world.addBuilding({townId:-1,x:68,z:64.45,angle:0,w:88,d:.3,type:0,floors:1,pop:0,seed:1,y:3,built:1990});
  const before=state(g),p=planSectionCount(g,s.id,4,{side:'right'});assert.equal(p.ok,false);assert.match(p.error!,/Pier/);assert.equal(state(g),before);assert.equal(st.hi,.225+.27);
});
scenario('expanded decks check terrain across their full width, without shifting retained heights',()=>{
  const g=flatGame(160),s=structureSpan(g,2);
  for(let x=20;x<=116;x++)for(let z=65;z<=68;z++)g.world.setVertex(x,z,5);
  const before=state(g),p=planSectionCount(g,s.id,4,{side:'right'});assert.equal(p.ok,false);assert.match(p.error!,/Deck terrain/);assert.equal(state(g),before);
});
scenario('piers clear empty retained civil capacity below, including removed outside tracks',()=>{
  const g=flatGame(160),lower=structureSpan(g,4),reduce=planSectionCount(g,lower.id,1,{side:'right'});
  assert.equal(reduce.ok,true,reduce.error);assert.equal(commitRailSectionPlan(g,reduce).error,null);
  const edge=rawRail(g,bezLine(24,65.25,112,65.25),{y:6.5});edge.sections=[{s0:0,s1:edge.len,type:'bridge'}];g.railSections.adoptUnassigned();
  const upper=g.railSections.get(g.railSections.membership(edge.id)!.section)!;assert.ok(g.railSections.structures.get(upper.structures[0])!.supports.length>0);
  const before=state(g),p=planSectionCount(g,upper.id,2,{side:'left'});assert.equal(p.ok,false);assert.match(p.error!,/Pier/);assert.equal(state(g),before);
});
scenario('crossing underneath remains grade-separated; shared supports shift clear of the road',()=>{
  const g=flatGame(160),s=structureSpan(g,2),net=g.world.net,a=net.addNode('road',64,3,50),b=net.addNode('road',64,3,80);
  const road=net.addEdge('road',a.id,b.id,bezLine(64,50,64,80),new Float32Array(31).fill(3),[],'road',-1);
  const p=planSectionCount(g,s.id,4,{side:'both'});assert.equal(p.ok,true,p.error);assert.equal(commitRailSectionPlan(g,p).error,null);assert.equal(net.edges.get(road.id),road);assert.equal(net.crossings.size,0);
  const st=g.railSections.structures.get(s.structures[0])!,geo=net.geo(road);
  for(const support of st.supports){const q=formationAt(s.alignment,support.u,support.offset),near=closestOnPolyline(q.x,q.z,geo.pts,3,geo.n);assert.ok(near.d>net.halfWidth(road)+.26);}
});
scenario('full expanded bore width checks cover and water; unsafe edits and stale cover refuse purely',()=>{
  const g=flatGame(160),s=structureSpan(g,2,'underground'),valid=planSectionCount(g,s.id,4,{side:'right'});assert.equal(valid.ok,true,valid.error);
  for(let x=20;x<=116;x++)for(let z=65;z<=68;z++)g.world.setVertex(x,z,-1);
  const before=state(g);assert.equal(commitRailSectionPlan(g,valid).error,'Plan stale');const bad=planSectionCount(g,s.id,4,{side:'right'});assert.equal(bad.ok,false);assert.equal(state(g),before);
  assert.throws(()=>validateFormation(g,s.alignment,[{u0:0,u1:s.alignment.length,type:'tunnel'}],-.6,1.6,new Set(s.slots.flatMap((s)=>s.steps.map((q)=>q.edge)))),/water|cover/i);
});
scenario('stacked underground formations use saved absolute profiles; nearby bores cannot overlap',()=>{
  const g=flatGame(160),net=g.world.net,top=structureSpan(g,2,'underground');
  const bottom=rawRail(g,bezLine(32,40,32,124),{y:-1.5});bottom.sections=[{s0:0,s1:bottom.len,type:'tunnel'}];net.touchEdge(bottom);g.railSections.adoptUnassigned();
  const lower=g.railSections.get(g.railSections.membership(bottom.id)!.section)!;
  const up=planSectionCount(g,top.id,4,{side:'right'}),down=planSectionCount(g,lower.id,3,{side:'both'});assert.equal(up.ok,true,up.error);assert.equal(down.ok,true,down.error);
  assert.equal(commitRailSectionPlan(g,up).error,null);const replanned=planSectionCount(g,lower.id,3,{side:'both'});assert.equal(replanned.ok,true,replanned.error);assert.equal(commitRailSectionPlan(g,replanned).error,null);
  for(const slot of lower.slots)for(const q of slot.steps)assert.ok([...net.edges.get(q.edge)!.prof].every((y)=>y===-1.5));
  assert.equal(net.crossings.size,0);assert.equal(g.railSections.structures.size,2);
  // A third bore at an unsafe vertical spacing is a physical obstacle, never a same-height group.
  const close=rawRail(g,bezLine(60,40,60,124),{y:.2});close.sections=[{s0:0,s1:close.len,type:'tunnel'}];net.touchEdge(close);
  const before=state(g),p=planSectionCount(g,top.id,4,{side:'left'}); // a real extra member, outside retained width
  assert.equal(p.cost,0); // unchanged count is a no-op, even if unrelated construction already exists
  const obstruction=planSectionCount(g,lower.id,4,{side:'right'});assert.equal(obstruction.ok,true,obstruction.error);assert.equal(state(g),before);
  const fail=planSectionCount(g,top.id,3,{side:'right'});assert.equal(fail.ok,true,fail.error);assert.equal(commitRailSectionPlan(g,fail).error,null);
  const regrow=planSectionCount(g,top.id,4,{side:'right'});assert.equal(regrow.ok,false);assert.match(regrow.error!,/height|clearance|cross|steep|close/i);
});
scenario('different spans/heights never form one civil group; station viaducts remain station-owned',()=>{
  const g=flatGame(160),a=rawRail(g,undefined,{y:4.5}),b=rawRail(g,bezLine(24,64.45,112,64.45),{y:4.5}),high=rawRail(g,bezLine(24,65,112,65),{y:6});
  a.sections=[{s0:0,s1:a.len,type:'bridge'}];b.sections=[{s0:12,s1:b.len-12,type:'bridge'}];high.sections=[{s0:0,s1:high.len,type:'bridge'}];
  const station=rawRail(g,bezLine(24,70,112,70),{y:4.5});station.station=42;station.sections=[{s0:0,s1:station.len,type:'bridge'}];g.railSections.adoptUnassigned();
  const section=g.railSections.get(g.railSections.membership(a.id)!.section)!;assert.equal(section.count,2);assert.equal(section.structures.length,2);assert.equal(g.railSections.structures.size,3);assert.equal(g.railSections.membership(station.id),undefined);
  assert.match(planSectionCount(g,section.id,3).error!,/spans differ/);assert.notEqual(g.railSections.structureAt(a.id,40)!.id,g.railSections.structureAt(b.id,40)!.id);
  const ctx={game:g} as ChunkCtx;assert.equal(parallelGroup(ctx,a,40,(e,s)=>g.world.net.sectionAt(e,s)==='bridge').length,0);
});
scenario('legacy render fallback never joins saved groups, foreign rail or station viaducts',()=>{
  const g=flatGame(160),a=rawRail(g,undefined,{y:4.5});a.sections=[{s0:0,s1:a.len,type:'bridge'}];g.railSections.adoptUnassigned();
  const b=rawRail(g,bezLine(24,64.45,112,64.45),{y:4.5});b.sections=[{s0:0,s1:b.len,type:'bridge'}];const ctx={game:g} as ChunkCtx;
  assert.equal(parallelGroup(ctx,b,40).length,0);
  const c=rawRail(g,bezLine(24,64.9,112,64.9),{y:4.5});c.sections=[{s0:0,s1:c.len,type:'bridge'}];assert.equal(parallelGroup(ctx,b,40).length,1);
  c.owner=1;assert.equal(parallelGroup(ctx,b,40).length,0);c.owner=0;c.station=42;assert.equal(parallelGroup(ctx,b,40).length,0);
});
scenario('render leader survives split/removal; all affected chunks dirty; previews and offline meshes are pure',()=>{
  const g=flatGame(160),s=structureSpan(g,4),id=s.structures[0],initial=renderCivil(g),e=g.world.net.edges.get(s.slots[0].steps[0].edge)!;
  const before=state(g),overlay=new Overlay(g),p=planSectionCount(g,s.id,2,{side:'right'});assert.equal(p.ok,true,p.error);overlay.setRailSectionPlan(p);renderCivil(g);assert.equal(state(g),before);overlay.dispose();
  g.world.dirtyObj.clear();g.world.net.splitEdge(e.id,38);assert.deepEqual(renderCivil(g),initial);assert.equal(s.structures[0],id);
  for(const c of initial)assert.ok(g.world.dirtyObj.has(c.ci));
  const shrink=planSectionCount(g,s.id,2,{side:'left'});assert.equal(shrink.ok,true,shrink.error);assert.equal(commitRailSectionPlan(g,shrink).error,null);assert.deepEqual(renderCivil(g),initial);assert.equal(s.structures[0],id);
  g.world.dirtyObj.clear();g.world.net.touchEdge(g.world.net.edges.get(s.slots[0].steps[0].edge)!);for(const c of initial)assert.ok(g.world.dirtyObj.has(c.ci));
  const bounds=structureBounds(s,g.railSections.structures.get(id)!);assert.ok(bounds[2]-bounds[0]>80);
});
scenario('one structure never reserves adjacent tracks as one resource; occupied retained rails permit widening',()=>{
  const g=flatGame(160),s=structureSpan(g,2),net=g.world.net,trains=s.slots.map((slot,i)=>{
    const e=net.edges.get(slot.steps[0].edge)!,t=new Train(g,g.vehicles.nextId++,loco(),-1);t.segs=[makeSeg(g,e,i? -1:1)];t.headPos=40;t.state='running';g.vehicles.map.set(t.id,t);g.vehicles.setRes(e.id,t.id);return t;});
  assert.ok(trains[0].segs[0].res.every((res)=>!trains[1].segs[0].res.includes(res)));
  const states=trains.map((t)=>JSON.stringify([t.headPos,t.segs])),p=planSectionCount(g,s.id,4,{side:'both'});assert.equal(p.ok,true,p.error);assert.equal(commitRailSectionPlan(g,p).error,null);
  assert.deepEqual(trains.map((t)=>JSON.stringify([t.headPos,t.segs])),states);
});
scenario('exceptional failure restores civil identities, ledgers, locks, dirty chunks and graph/economy state',()=>{
  const g=flatGame(160),s=structureSpan(g,2,'underground'),st=g.railSections.structures.get(s.structures[0])!,p=planSectionCount(g,s.id,4,{side:'right'}),before=state(g),spend=g.economy.spend;
  g.economy.spend=()=>{throw new Error('injected bill');};const result=commitRailSectionPlan(g,p);g.economy.spend=spend;assert.match(result.error!,/injected bill/);assert.equal(state(g),before);assert.equal(g.railSections.structures.get(st.id),st);
});
scenario('removing the final member removes its civil metadata and upkeep; malformed civil saves reject',()=>{
  const g=flatGame(160),s=structureSpan(g,1,'underground');for(const slot of s.slots.slice())for(const q of slot.steps.slice())g.world.net.removeEdge(q.edge);g.onNetworkChanged();recomputeLocks(g.world,20,60,116,69);
  assert.equal(g.railSections.structures.size,0);assert.equal(g.maintenanceOf(0),0);assert.equal(g.world.lock.some((v)=>v&LOCK.civil),false);g.railSections.validate();
  const other=flatGame(160);structureSpan(other);const saved=serialize(other);(saved.net.railSections as any).structures[0].maintenance=-1;assert.throws(()=>deserialize(saved),/rail structure/);
});

done();
