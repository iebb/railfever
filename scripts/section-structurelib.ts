// Stage-4 fixtures and contract checks used by the structure and existing regression suites.
import { assert, flatGame, opts, state, physical, rawRail } from './sectionlib';
import { planRailSection, planSectionCount, commitRailSectionPlan } from '../src/game/rail-section-ops';
import { railUAtS, type TrackCount } from '../src/game/rail-section-types';
import { alignmentHeight } from '../src/game/rail-offsets';
import { trackBasePerUnit, trackMaintenance, loadOps, saveOps } from '../src/game/opcosts';
import { LOCK, brush, recomputeLocks } from '../src/game/terraform';
import { bezLine } from '../src/game/geom';
import { serialize, deserialize } from '../src/game/save';
import type { Game } from '../src/game/game';
import { Game as RailGame } from '../src/game/game';
import { WB } from '../src/render/build-mesh';
import { buildSectionStructures, sectionPortalKeepouts } from '../src/render/build-section-structures';
import type { ChunkCtx } from '../src/render/build-common';
import { OBJ_CHUNK } from '../src/game/world';

export function structureSpan(g: Game, count: TrackCount = 2, level: 'elevated' | 'underground' = 'elevated', curved = false) {
  const p = planRailSection(g, { kind:'free', x:24, y:3, z:64 }, { kind:'free', x:112, y:3, z:curved?112:64 },
    { ...opts(count), level, ...(curved ? { tangents: { start:{x:1,z:0},end:{x:0,z:1} } } : {}) });
  assert.equal(p.ok,true,p.error); const money=g.economy.money, r=commitRailSectionPlan(g,p); assert.equal(r.error,null,r.error);
  assert.equal(money-g.economy.money,p.cost); const section=g.railSections.get(r.section!)!;
  assert.equal(section.structures.length,1); return section;
}
export function renderCivil(g: Game) {
  const n=Math.ceil(g.world.size/OBJ_CHUNK), chunks:{ci:number;pos:number[];idx:number[]}[]=[];
  for(let cz=0;cz<n;cz++) for(let cx=0;cx<n;cx++) {
    const w=new WB(),ctx={game:g,ci:cz*n+cx,n,x0:cx*OBJ_CHUNK,z0:cz*OBJ_CHUNK,x1:(cx+1)*OBJ_CHUNK,z1:(cz+1)*OBJ_CHUNK,w,d:new WB()} as ChunkCtx;
    buildSectionStructures(ctx); if(!w.empty) chunks.push({ci:ctx.ci,pos:Array.from(w.pos.slice(0,w.vertexCount*3)),idx:Array.from(w.idx.a.slice(0,w.idx.length))});
  }
  return chunks;
}
export function civilBills() {
  for(const level of ['elevated','underground'] as const) {
    const g=flatGame(160),s=structureSpan(g,2,level),st=g.railSections.structures.get(s.structures[0])!,prior=st.maintenance;
    const edges=s.slots.flatMap((q)=>q.steps.map((q)=>g.world.net.edges.get(q.edge)!));
    const base=edges.reduce((n,e)=>n+e.len*trackBasePerUnit(e.type),0);
    assert.ok(Math.abs(g.maintenanceOf(0)-base-st.maintenance)<1e-7);
    assert.ok(st.maintenance<edges.reduce((n,e)=>n+trackMaintenance(e)-e.len*trackBasePerUnit(e.type),0));
    const p=planSectionCount(g,s.id,4,{side:'right'});assert.equal(p.ok,true,p.error);assert.equal(p.diff.structures.length,1);assert.ok(p.diff.structures[0].cost>0);
    const money=g.economy.money;assert.equal(commitRailSectionPlan(g,p).error,null);assert.equal(money-g.economy.money,p.cost);
    const wide=g.railSections.structures.get(st.id)!;assert.ok(wide.maintenance>prior);
    const reduction=planSectionCount(g,s.id,2,{side:'right'});assert.equal(reduction.ok,true,reduction.error);assert.equal(reduction.diff.structures[0].cost,0);
    assert.equal(commitRailSectionPlan(g,reduction).error,null);const kept=g.railSections.structures.get(st.id)!;
    assert.equal(kept.maintenance,wide.maintenance);assert.equal(kept.hi,wide.hi);
    const refill=planSectionCount(g,s.id,4,{side:'right'});assert.equal(refill.ok,true,refill.error);assert.equal(refill.diff.structures[0].cost,0);
    assert.equal(commitRailSectionPlan(g,refill).error,null);assert.equal(g.railSections.structures.get(st.id)!.civilCost,wide.civilCost);
    g.railSections.validate();
  }
}
export function verticalCounts() {
  for(const level of ['elevated','underground'] as const) {
    const g=flatGame(160),s=structureSpan(g,2,level,true),ids=s.slots.map((q)=>q.id),original=s.slots.flatMap((q)=>q.steps.map((q)=>g.world.net.edges.get(q.edge)!));
    const before=state(g),p=planSectionCount(g,s.id,4,{side:'both'});assert.equal(p.ok,true,p.error);assert.equal(state(g),before);
    assert.equal(commitRailSectionPlan(g,p).error,null);assert.ok(ids.every((id)=>s.slots.some((q)=>q.id===id)));
    for(const e of original)assert.equal(g.world.net.edges.get(e.id),e);
    const lengths=s.slots.map((q)=>q.steps.reduce((n,q)=>n+g.world.net.edges.get(q.edge)!.len,0));assert.ok(Math.max(...lengths)-Math.min(...lengths)>.1);
    for(const slot of s.slots)for(const q of slot.steps){const e=g.world.net.edges.get(q.edge)!;for(let i=0;i<e.prof.length;i++)assert.ok(Math.abs(e.prof[i]-alignmentHeight(s.alignment,railUAtS(q,Math.min(e.len,i))))<1e-5);}
    const save=JSON.stringify(serialize(g)),loaded=deserialize(JSON.parse(save));assert.equal(JSON.stringify(serialize(loaded)),save);
    for(let i=0;i<1600;i++){g.update(.05);loaded.update(.05);}assert.equal(JSON.stringify(serialize(loaded)),JSON.stringify(serialize(g)));
  }
}
export function legacyCivil() {
  const g=flatGame(160),a=rawRail(g),b=rawRail(g,bezLine(24,64.45,112,64.45));
  for(const e of [a,b]){e.prof.fill(4.5);e.sections=[{s0:0,s1:e.len,type:'bridge'}];g.world.net.touchEdge(e);}
  const before=physical(g),bill=g.maintenanceOf(0),individual=[a,b].map((e)=>g.edgeMaintenance(e)),ids=[g.world.net.nextNode,g.world.net.nextEdge,g.world.net.nextCrossing];
  g.railSections.adoptUnassigned();assert.equal(physical(g),before);assert.equal(g.maintenanceOf(0),bill);assert.deepEqual([a,b].map((e)=>g.edgeMaintenance(e)),individual);
  assert.deepEqual([g.world.net.nextNode,g.world.net.nextEdge,g.world.net.nextCrossing],ids);
  const saved=JSON.stringify(g.railSections.toJSON());g.railSections.adoptUnassigned();assert.equal(JSON.stringify(g.railSections.toJSON()),saved);
  const section=g.railSections.get(g.railSections.membership(a.id)!.section)!;assert.equal(section.count,2);assert.equal(section.structures.length,1);
  loadOps(g,{wear:[[b.id,123.5,0]],lastWear:{}});
  const cut=g.world.net.splitEdge(b.id,31)!;assert.ok(Math.abs(g.edgeMaintenance(cut.e1)+g.edgeMaintenance(cut.e2)-individual[1])<.1);g.railSections.validate();
  const wear=saveOps(g).wear;assert.equal(wear.some((q)=>q[0]===b.id),false);assert.ok(Math.abs(wear.reduce((n,q)=>n+q[1],0)-123.5)<1e-9);assert.ok(wear.every((q)=>[cut.e1.id,cut.e2.id].includes(q[0])));
  const old=serialize(g);delete (old.net.railSections as any).civilSchema;(old.net.railSections as any).structures=[];(old.net.railSections as any).sections.forEach((s:any)=>s.structures=[]);(old.net.railSections as any).nextStructure=1;
  const sourceBill=[...g.world.net.edges.values()].reduce((n,e)=>n+trackMaintenance(e),0);
  const migrated=deserialize(old);assert.ok(Math.abs(migrated.maintenanceOf(0)-sourceBill)<1e-5,`raw ${sourceBill}, migrated ${migrated.maintenanceOf(0)}`);
  const round=JSON.stringify(serialize(migrated));assert.equal(JSON.stringify(serialize(deserialize(JSON.parse(round)))),round);
}
export function civilLocks() {
  for(const level of ['elevated','underground'] as const) {
    const g=flatGame(160),s=structureSpan(g,4,level),initial=g.world.lock.slice();assert.ok(initial.some((v)=>v&LOCK.civil));
    const p=planSectionCount(g,s.id,1,{side:'right'});assert.equal(p.ok,true,p.error);assert.equal(commitRailSectionPlan(g,p).error,null);
    for(let i=0;i<initial.length;i++)assert.equal(g.world.lock[i]&LOCK.civil,initial[i]&LOCK.civil);
    const heights=g.world.h.slice();brush(g.world,64,64,3,'lower',2);for(let i=0;i<initial.length;i++)if(initial[i]&LOCK.civil)assert.equal(g.world.h[i],heights[i]);
    recomputeLocks(g.world,20,60,116,69);for(let i=0;i<initial.length;i++)assert.equal(g.world.lock[i]&LOCK.civil,initial[i]&LOCK.civil);
  }
}
export function portalBoundaries() {
  const g=flatGame(160,3,(x)=>3+Math.min(5,Math.max(0,x-44)*.3,Math.max(0,92-x)*.3));
  const a=rawRail(g),b=rawRail(g,bezLine(24,64.45,112,64.45));for(const e of[a,b]){e.sections=[{s0:24,s1:64,type:'tunnel'}];g.world.net.touchEdge(e);}g.railSections.adoptUnassigned();
  const s=g.railSections.get(g.railSections.membership(a.id)!.section)!,id=s.structures[0],st=g.railSections.structures.get(id)!;assert.deepEqual(st.portals,[true,true]);
  g.world.net.splitEdge(a.id,42);g.world.net.splitEdge(b.id,30);
  const p=planSectionCount(g,s.id,4,{side:'right'});assert.equal(p.ok,true,p.error);assert.equal(commitRailSectionPlan(g,p).error,null);
  assert.equal(s.structures[0],id);assert.deepEqual(g.railSections.structures.get(id)!.portals,[true,true]);
  const ctx={game:g,x0:0,z0:0,x1:160,z1:160} as ChunkCtx,keep:any[]=[];sectionPortalKeepouts(ctx,keep);assert.equal(keep.length,2);
  const before=state(g),geometry=renderCivil(g);assert.ok(geometry.length>1);assert.equal(state(g),before);
}

function foreignCivil() {
  const g=RailGame.create({size:160,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1990,aiCompanies:1});g.aiEnabled=false;g.world.h.fill(3);
  for(let i=0;i<g.world.trees.length;i++)if(g.world.trees[i])g.world.removeTreesNear(g.world.trees[i]!.x,g.world.trees[i]!.z,.1);
  for(const c of g.companies)c.economy.money=4e8;
  const p=planRailSection(g,{kind:'free',x:24,y:3,z:64},{kind:'free',x:112,y:3,z:64},{...opts(2),owner:1,level:'elevated'});
  assert.equal(p.ok,true,p.error);const result=commitRailSectionPlan(g,p);assert.equal(result.error,null);return{g,s:g.railSections.get(result.section!)!};
}
export function sharedCivilRights() {
  const {g,s}=foreignCivil();g.setAccessPolicy(1,'auto-approve');assert.equal(g.requestAccess(0,1),'granted');
  const p=planSectionCount(g,s.id,4,{user:0,side:'right'});assert.equal(p.ok,true,p.error);const owner=g.company(1).economy.money,payer=g.economy.money;
  assert.equal(commitRailSectionPlan(g,p).error,null);assert.equal(g.company(1).economy.money,owner);assert.equal(payer-g.economy.money,p.cost);
  assert.ok(s.slots.flatMap((q)=>q.steps).every((q)=>g.world.net.edges.get(q.edge)!.owner===1));assert.ok(s.structures.every((id)=>g.railSections.structures.get(id)!.owner===1));
  assert.match(planSectionCount(g,s.id,2,{user:0}).error!,/Owner/);
  const reduce=planSectionCount(g,s.id,2,{user:1,side:'right'});assert.equal(reduce.ok,true,reduce.error);assert.equal(commitRailSectionPlan(g,reduce).error,null);
  const preview=planSectionCount(g,s.id,3,{user:0,side:'left'});assert.equal(preview.ok,true,preview.error);g.setAccessPolicy(1,'auto-reject');g.endAccess(0,1);const before=state(g);assert.ok(commitRailSectionPlan(g,preview).error);assert.equal(state(g),before);
  const player=structureSpan(g,1,'underground');assert.match(planSectionCount(g,player.id,2,{user:1}).error!,/AI/);
}
export function sharedCivilAccess() {
  const {g,s}=foreignCivil();g.setAccessPolicy(1,'auto-approve');g.requestAccess(0,1);g.setAccessMultiplier(1,1);
  const edges=s.slots.flatMap((q)=>q.steps).map((q)=>g.world.net.edges.get(q.edge)!);
  const bill=edges.reduce((n,e)=>n+g.edgeMaintenance(e),0)/12;
  const payer=g.economy.money,owner=g.company(1).economy.money;
  for(const e of edges){g.recordTrackUse(0,e,10);g.recordTrackUse(1,e,10);}g.billAccess();
  assert.ok(Math.abs(payer-g.economy.money-bill/2)<1e-5);assert.ok(Math.abs(g.company(1).economy.money-owner-bill/2)<1e-5);
  const paid=g.agreement(0,1)!.paidTotal;assert.ok(Math.abs(paid-bill/2)<1e-5);
  g.billAccess();assert.equal(g.agreement(0,1)!.paidTotal,paid);
}
