// Bundle as section-count.mjs. Stage 2: complete retained-edge diffs, pure geometry and atomic commits.
import { assert, flatGame, done, scenario, rawRail, authored, state, opts } from './sectionlib';
import { planRailSection, planSectionCount, commitRailSectionPlan } from '../src/game/rail-section-ops';
import { railSAtU, railUAtS } from '../src/game/rail-section-types';
import { bezLine, bezPoint, arcTable, tAtS } from '../src/game/geom';
import { Train, makeSeg } from '../src/game/train';
import { loco, station } from './stationlib';
import { setSignal } from '../src/game/signals';
import { Game } from '../src/game/game';
import { profAt } from '../src/game/network';
import { alignmentHeight, offsetRailAlignment, alignmentOf } from '../src/game/rail-offsets';
import { checkReservations, checkNaN } from './lib';
if (!process.argv[1]?.endsWith('section-count.mjs')) throw new Error('bundle as section-count.mjs');

for (const count of [1,2,3,4] as const) for(const curved of [false,true]) scenario(`new ${curved?'curved':'straight'} ${count}-track operation; exact quote and actual lengths`, () => {
  const g = flatGame(160), before = g.economy.money, s = authored(g,count,curved);
  assert.equal(s.count,count); assert.ok(g.economy.money<before); assert.equal(g.networkVersion,1);
  for(const slot of s.slots) for(const q of slot.steps) {
    const e = g.world.net.edges.get(q.edge)!; assert.equal(e.len,arcTable(e.bez).len);
    for(let i=0;i<e.prof.length;i++) assert.ok(Math.abs(e.prof[i]-alignmentHeight(s.alignment,railUAtS(q,Math.min(e.len,i))))<1e-5);
  }
  if(curved && count>1) assert.ok(Math.abs(s.slots[0].steps.reduce((l,q)=>l+g.world.net.edges.get(q.edge)!.len,0)-s.slots.at(-1)!.steps.reduce((l,q)=>l+g.world.net.edges.get(q.edge)!.len,0))>.1);
  g.railSections.validate();
});
scenario('every direct count pair 1↔2↔3↔4 preserves each retained edge and slot identity', () => {
  for(const from of [1,2,3,4] as const) for(const to of [1,2,3,4] as const) {
    const g=flatGame(160),s=authored(g,from),original=new Map(s.slots.map((slot)=>[slot.id,slot.steps.map((q)=>q.edge)]));
    const p=planSectionCount(g,s.id,to);assert.equal(p.ok,true,p.error);assert.equal(commitRailSectionPlan(g,p).error,null);assert.equal(s.count,to);
    for(const slot of s.slots) if(original.has(slot.id)) assert.deepEqual(slot.steps.map((q)=>q.edge),original.get(slot.id));g.railSections.validate();
  }
});
scenario('1→2→3→4→3→2→1 keeps all survivors, alignment and manual signals', () => {
  const g = flatGame(160), s = authored(g), net = g.world.net, base = s.slots[0].id;
  assert.equal(setSignal(g,s.slots[0].steps[0].edge,35,'twoway',true,0,{signalKind:'block'}),null);
  const ids = s.slots[0].steps.map((q)=>q.edge), geometry = ids.map((id)=>JSON.stringify({...net.edges.get(id)!,prof:Array.from(net.edges.get(id)!.prof)}));
  const signal = [...net.nodes.values()].find((n)=>n.signal)!, original = JSON.stringify(signal), alignment = JSON.stringify(s.alignment);
  for(const count of [2,3,4,3,2,1] as const) {
    const p = planSectionCount(g,s.id,count,{side:'right'}); assert.equal(p.ok,true,p.error);
    const before = g.economy.money, result = commitRailSectionPlan(g,p); assert.equal(result.error,null); assert.equal(before-g.economy.money,p.cost);
    assert.equal(s.count,count); assert.equal(s.slots[0].id,base); assert.equal(JSON.stringify(s.alignment),alignment); assert.equal(JSON.stringify(signal),original);
    ids.forEach((id,i)=>assert.equal(JSON.stringify({...net.edges.get(id)!,prof:Array.from(net.edges.get(id)!.prof)}),geometry[i])); g.railSections.validate();
  }
});
scenario('left/both growth is asymmetric and retains stable lateral slot IDs', () => {
  const g = flatGame(160), s = authored(g), id = s.slots[0].id;
  assert.equal(commitRailSectionPlan(g,planSectionCount(g,s.id,3,{side:'both'})).error,null);
  assert.deepEqual(s.slots.map((s)=>Math.round(s.offset*100)),[-45,0,45]); assert.equal(s.slots[1].id,id);
  assert.equal(commitRailSectionPlan(g,planSectionCount(g,s.id,4,{side:'left'})).error,null);
  assert.deepEqual(s.slots.map((s)=>Math.round(s.offset*100)),[-90,-45,0,45]); assert.equal(s.slots[2].id,id);
  assert.equal(commitRailSectionPlan(g,planSectionCount(g,s.id,3)).error,null); assert.equal(s.slots.some((s)=>s.offset<-.46),false);
});
scenario('auto compares valid quotes and uses right on ties; blocked side falls back to left', () => {
  const g = flatGame(160), s = authored(g), right = planSectionCount(g,s.id,2,{side:'right'}), left = planSectionCount(g,s.id,2,{side:'left'}), auto = planSectionCount(g,s.id,2);
  assert.equal(auto.cost,Math.min(left.cost,right.cost)); if(left.cost===right.cost) assert.equal(auto.side,'right');
  rawRail(g,bezLine(24,64.45,112,64.45)); const fallback = planSectionCount(g,s.id,2); assert.equal(fallback.ok,true,fallback.error); assert.equal(fallback.side,'left');
});
scenario('curved profile/correspondence follows reference position rather than equal s or length ratio', () => {
  const g = flatGame(160), s = authored(g,1,true);
  // Varying reference grade, kept entirely within the ground formation's support range.
  const piece = s.alignment.pieces[0]; for(let i=0;i<piece.prof.length;i++) piece.prof[i]=Math.fround(3+.004*Math.min(i,s.alignment.length));
  const e = g.world.net.edges.get(s.slots[0].steps[0].edge)!; e.prof = Float32Array.from(piece.prof); g.world.net.touchEdge(e);
  const p = planSectionCount(g,s.id,4,{side:'both'}); assert.equal(p.ok,true,p.error); assert.equal(commitRailSectionPlan(g,p).error,null);
  for(const slot of s.slots) for(const q of slot.steps) { const e=g.world.net.edges.get(q.edge)!; for(let i=0;i<e.prof.length;i++) assert.ok(Math.abs(e.prof[i]-alignmentHeight(s.alignment,railUAtS(q,Math.min(e.len,i))))<1e-5); }
  g.railSections.validate();
});
scenario('unsafe inner radius, folds and per-member grade are refused purely', () => {
  const b={x0:32,z0:32,x1:33.8,z1:32,x2:35.2,z2:33.4,x3:35.2,z3:35.2}, a=alignmentOf(b,new Float32Array(7).fill(3));
  assert.throws(()=>offsetRailAlignment(a,.9,3,.07),/radius|Folded/);
  assert.throws(()=>offsetRailAlignment(a,10,3,.07),/radius|Folded|fit/);
  const c=alignmentOf(bezLine(24,24,34,24),Float32Array.from([3,3.08,3.16,3.24,3.32,3.4,3.48,3.56,3.64,3.72,3.8]));
  assert.throws(()=>offsetRailAlignment(c,0,3,.07),/grade/);
});
scenario('occupied retained rail permits growth; occupied/reserved removed rail refuses with identical state', () => {
  const g = flatGame(160), s = authored(g), edge = g.world.net.edges.get(s.slots[0].steps[0].edge)!;
  const t = new Train(g,g.vehicles.nextId++,loco(),-1); t.segs=[makeSeg(g,edge,1)]; t.headPos=45; t.state='running'; g.vehicles.map.set(t.id,t); g.vehicles.setRes(edge.id,t.id);
  assert.equal(g.vehicles.isEdgeBusy(edge.id),true);
  const p=planSectionCount(g,s.id,2,{side:'right'}), body=JSON.stringify(t.segs), head=t.headPos;
  assert.equal(p.ok,true,p.error); assert.equal(commitRailSectionPlan(g,p).error,null); assert.equal(t.headPos,head); assert.equal(JSON.stringify(t.segs),body);
  const added=g.world.net.edges.get(s.slots[1].steps[0].edge)!;
  g.vehicles.setRes(added.id,t.id); let before=state(g); const reserved=planSectionCount(g,s.id,1,{side:'right'}); assert.match(reserved.error!,/reserved/); assert.equal(commitRailSectionPlan(g,reserved).error,reserved.error); assert.equal(state(g),before);
  g.vehicles.releaseRes(added.id,t.id); t.segs=[makeSeg(g,added,1)]; t.headPos=45; before=state(g); const busy=planSectionCount(g,s.id,1,{side:'right'}); assert.match(busy.error!,/occupied/); assert.equal(state(g),before);
  // An approved exact graph split remaps head, body, reservations and section correspondence together.
  const pos={x:0,y:0,z:0}; t.worldPos(pos); const split=g.world.net.splitEdge(added.id,50)!; const next={x:0,y:0,z:0}; t.worldPos(next);
  assert.ok(Math.hypot(pos.x-next.x,pos.z-next.z,pos.y-next.y)<1e-3); assert.equal(t.occupiedEdges().every((id)=>id!==added.id),true);
  assert.equal(g.railSections.membership(split.e1.id)!.slot,s.slots[1].id); g.railSections.validate(); checkReservations(g); checkNaN(g);
});
scenario('manual siding, station/depot ends and directional 2→1 all refuse before mutation', () => {
  for(const role of ['siding','station','depot','direction'] as const) {
    const g=flatGame(160),s=authored(g,2),net=g.world.net,e=net.edges.get(s.slots[0].steps[0].edge)!;
    if(role==='direction') assert.equal(setSignal(g,e.id,40,'oneway',true,0),null);
    else {const n=net.nodes.get(e.b)!,end=net.addNode('rail',120,3,80),branch=net.addEdge('rail',n.id,end.id,bezLine(n.x,n.z,120,80),new Float32Array(20).fill(3),[],'standard',0);
      if(role==='station') branch.station=44; if(role==='depot') branch.depot=44; }
    const before=state(g),p=planSectionCount(g,s.id,role==='direction'?1:3,{side:'right'}); assert.equal(p.ok,false); assert.match(p.error!,/stage 3/); assert.equal(state(g),before);
  }
});
scenario('stale dependencies, poor payer, revoked rights and AI/player restriction are pure refusals', () => {
  const g=flatGame(160),s=authored(g),net=g.world.net,p=planSectionCount(g,s.id,2); net.nodes.get(s.ends[0].nodes[0])!.signalKind='block'; let before=state(g); assert.equal(commitRailSectionPlan(g,p).error,'Plan stale'); assert.equal(state(g),before);
  const poor=planSectionCount(g,s.id,2);g.economy.money=0;before=state(g);assert.equal(commitRailSectionPlan(g,poor).error,'Not enough money');assert.equal(state(g),before);
  const foreign=Game.create({size:160,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1990,aiCompanies:1});foreign.aiEnabled=false;foreign.world.h.fill(3);foreign.economy.money=4e8;
  const e=rawRail(foreign,undefined,{owner:1});foreign.railSections.adoptUnassigned();const fs=foreign.railSections.get(foreign.railSections.membership(e.id)!.section)!;
  const grow=planSectionCount(foreign,fs.id,2,{user:0});assert.equal(grow.ok,true,grow.error);foreign.setAccessPolicy(1,'auto-reject');foreign.endAccess(0,1);before=state(foreign);assert.ok(commitRailSectionPlan(foreign,grow).error);assert.equal(state(foreign),before);
  const deny=planSectionCount(g,s.id,2,{user:1});assert.equal(deny.ok,false);assert.match(deny.error!,/AI/);
});
scenario('access payer retains foreign infrastructure; reductions require its owner', () => {
  const g=Game.create({size:160,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1990,aiCompanies:1});g.aiEnabled=false;g.world.h.fill(3);g.economy.money=4e8;
  const e=rawRail(g,undefined,{owner:1,type:'metro'});g.railSections.adoptUnassigned();const s=g.railSections.get(g.railSections.membership(e.id)!.section)!;
  const p=planSectionCount(g,s.id,2,{user:0}),cash=g.economy.money,other=g.company(1).economy.money;assert.equal(commitRailSectionPlan(g,p).error,null);
  assert.equal(cash-g.economy.money,p.cost);assert.equal(g.company(1).economy.money,other);assert.equal(s.owner,1);for(const q of s.slots.flatMap((s)=>s.steps)) assert.equal(g.world.net.edges.get(q.edge)!.owner,1);
  const before=state(g),shrink=planSectionCount(g,s.id,1,{user:0});assert.equal(shrink.error,'Owner required');assert.equal(state(g),before);
});
scenario('injected mid-graph and final-charge failures restore all state and original object identity', () => {
  const g=flatGame(160),s=authored(g),net=g.world.net,original=net.addEdge;let calls=0;
  const p=planSectionCount(g,s.id,4);const before=state(g);net.addEdge=function(...args:any[]){const e=(original as any).apply(this,args);if(++calls===2)throw new Error('injected graph');return e;};
  const result=commitRailSectionPlan(g,p);net.addEdge=original;assert.match(result.error!,/injected/);assert.equal(state(g),before);assert.equal(g.railSections.get(s.id),s);
  const p2=planSectionCount(g,s.id,4),spend=g.economy.spend;const before2=state(g);g.economy.spend=function(...args:any[]){(spend as any).apply(this,args);throw new Error('injected spend');};
  assert.match(commitRailSectionPlan(g,p2).error!,/injected spend/);g.economy.spend=spend;assert.equal(state(g),before2);assert.equal(g.railSections.get(s.id),s);
});
scenario('rollback covers shrink removals, building/tree demolition, terrain changes and dirty/index order', () => {
  const g=flatGame(160),s=authored(g,4),net=g.world.net,remove=net.removeEdge;let calls=0;
  const p=planSectionCount(g,s.id,1,{side:'right'}),before=state(g);net.removeEdge=function(id:number){remove.call(this,id);if(++calls===2)throw new Error('injected remove');};
  assert.match(commitRailSectionPlan(g,p).error!,/injected remove/);net.removeEdge=remove;assert.equal(state(g),before);assert.equal(g.railSections.get(s.id),s);
  const fresh=flatGame(160),w=fresh.world;w.addTree({x:64,z:64,s:1,type:0,tint:0});w.addBuilding({townId:-1,x:64,z:64,y:3,angle:0,w:1,d:1,type:0,floors:1,pop:10,seed:7,built:0});
  const preview=planRailSection(fresh,{kind:'free',x:24,z:64,y:3},{kind:'free',x:112,z:64,y:3},opts(4));assert.equal(preview.ok,true,preview.error);assert.equal(preview.diff.demolish.length,1);assert.equal(preview.diff.trees.length,1);
  const snapshot=state(fresh),spend=fresh.economy.spend;fresh.economy.spend=function(...args:any[]){(spend as any).apply(this,args);throw new Error('injected civil');};
  assert.match(commitRailSectionPlan(fresh,preview).error!,/injected civil/);fresh.economy.spend=spend;assert.equal(state(fresh),snapshot);
  const cash=fresh.economy.money;assert.equal(commitRailSectionPlan(fresh,preview).error,null);assert.equal(cash-fresh.economy.money,preview.cost);assert.equal(w.buildings.size,0);assert.equal(w.countTreesNear(64,64,1),0);
});
scenario('new curved previews clean temporary nodes, including failed radius/alignment previews', () => {
  const g=flatGame(160),before=state(g);
  for(let i=0;i<5;i++) {
    const a={kind:'free' as const,x:24,z:64,y:3},b={kind:'free' as const,x:112,z:112,y:3};
    assert.equal(planRailSection(g,a,b,{...opts(4),tangents:{start:{x:1,z:0},end:{x:0,z:1}}}).ok,true);
    assert.equal(planRailSection(g,a,b,{...opts(4),tangents:{start:{x:0,z:0},end:{x:0,z:1}}}).ok,false);
    assert.equal(planRailSection(g,{kind:'free',x:32,z:32,y:3},{kind:'free',x:35.2,z:35.2,y:3},{...opts(4),tangents:{start:{x:1,z:0},end:{x:0,z:1}}}).ok,false);
  }
  assert.equal(state(g),before);
});
scenario('curved builds retain the requested end height on every mapped member', () => {
  const g=flatGame(160),before=state(g),p=planRailSection(g,{kind:'free',x:24,z:64,y:3},{kind:'free',x:112,z:112,y:3},
    {...opts(4),heightOffset:.2,tangents:{start:{x:1,z:0},end:{x:0,z:1}}});
  assert.equal(p.ok,true,p.error);assert.equal(state(g),before);assert.equal(commitRailSectionPlan(g,p).error,null);
  for(const slot of g.railSections.get(p.section ?? 1)!.slots) assert.ok(Math.abs(g.world.net.edges.get(slot.steps.at(-1)!.edge)!.prof.at(-1)!-3.2)<1e-6);
});
scenario('repeated successful/failed previews preserve serialized and unsaved state', () => {
  const g=flatGame(160),s=authored(g,2,true),before=state(g);
  for(let i=0;i<10;i++) {assert.equal(planSectionCount(g,s.id,4,{side:i%2?'left':'right'}).ok,true);planSectionCount(g,s.id,0 as any);planRailSection(g,{kind:'edge',edge:s.slots[0].steps[0].edge,s:20,x:20,z:20,y:3},{kind:'free',x:50,z:50,y:3},opts(4));}
  assert.equal(state(g),before);
});
done();
