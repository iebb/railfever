// Bundle as section-save.mjs. Authentic release migration, exact metadata snapshots and live fixed-tick replay.
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { LEGACY_SECTION_SAVES } from './fixtures/rail-section-saves';
import { assert, flatGame, done, scenario, authored, state, rawRail } from './sectionlib';
import { serialize, deserialize } from '../src/game/save';
import { planSectionCount, commitRailSectionPlan } from '../src/game/rail-section-ops';
import { Train, makeSeg } from '../src/game/train';
import { loco } from './stationlib';
import { checkReservations, checkNaN } from './lib';
if (!process.argv[1]?.endsWith('section-save.mjs')) throw new Error('bundle as section-save.mjs');
const json = (g: Parameters<typeof serialize>[0]) => JSON.stringify(serialize(g));

for (const fixture of LEGACY_SECTION_SAVES) scenario(`authentic ${fixture.version} (${fixture.commit}): metadata-only, immutable, idempotent, live replay`, () => {
  const bytes=Buffer.from(fixture.gzip,'base64'); assert.equal(createHash('sha256').update(bytes).digest('hex'),fixture.sha256);
  const input=JSON.parse(gunzipSync(bytes).toString()), before=JSON.stringify(input); assert.equal(input.game,fixture.version); assert.equal(input.net.railSections,undefined);
  const g=deserialize(input); assert.equal(JSON.stringify(input),before);
  const saved=serialize(g), originalEdges=input.net.edges.map((e:any)=>e.id), originalNodes=input.net.nodes.map((n:any)=>n.id);
  assert.deepEqual(saved.net.edges.map((e:any)=>e.id),originalEdges); assert.deepEqual(saved.net.nodes.map((n:any)=>n.id),originalNodes);
  for(const key of ['nextNode','nextEdge','nextCrossing']) assert.equal(saved.net[key],input.net[key]);
  assert.deepEqual(saved.net.nodes,input.net.nodes); assert.deepEqual(saved.net.crossings,input.net.crossings);
  for(let i=0;i<input.net.edges.length;i++) {
    const a=input.net.edges[i],b=saved.net.edges[i];assert.deepEqual({...b,type:a.type},a,'only O wire canonicalization changes physical edge metadata');
  }
  assert.deepEqual(saved.vehicles,input.vehicles); assert.deepEqual(saved.companies,input.companies); assert.equal(saved.rng,input.rng);assert.equal(saved.tick,input.tick);
  if(fixture.version==='2.8') {assert.ok(input.mail?.rng);assert.ok(input.stations.some((s:any)=>s.mail?.waiting.length));assert.deepEqual(saved.mail,input.mail);}
  assert.ok([...g.railSections.sections.values()].some((s)=>s.count===2)); g.railSections.validate();
  assert.ok(g.vehicles.trains().some((t)=>t.state==='running' && t.segs.length));
  const snapshot=json(g), loaded=deserialize(JSON.parse(snapshot)); assert.equal(json(loaded),snapshot);
  assert.equal([...g.stations.map.values()][0].rail!.mode,'metro');
  for(let tick=0;tick<160;tick++) {g.stepTick();loaded.stepTick(); if(tick%20===0) assert.equal(json(loaded),json(g));}
  assert.equal(json(loaded),json(g));checkReservations(g);checkReservations(loaded);checkNaN(g);checkNaN(loaded);
});
scenario('new section saves preserve original edges, asymmetry, slot IDs, map order and allocator gaps', () => {
  const g=flatGame(160),s=authored(g,2,true);assert.equal(commitRailSectionPlan(g,planSectionCount(g,s.id,4,{side:'left'})).error,null);
  const q=s.slots[2].steps[0];g.world.net.splitEdge(q.edge,g.world.net.edges.get(q.edge)!.len*.36);g.railSections.nextSlot+=3;
  g.railSections.validate();const before=json(g),input=JSON.parse(before),inputBefore=JSON.stringify(input),loaded=deserialize(input);
  assert.equal(JSON.stringify(input),inputBefore);assert.equal(json(loaded),before);assert.deepEqual([...loaded.railSections.byEdge.keys()],[...g.railSections.byEdge.keys()]);
  assert.equal(commitRailSectionPlan(loaded,planSectionCount(loaded,s.id,3,{side:'left'})).error,null);
  assert.equal(commitRailSectionPlan(g,planSectionCount(g,s.id,3,{side:'left'})).error,null);assert.equal(json(loaded),json(g));
});
scenario('new live train retains head/body/reservations across split, count commit and save replay', () => {
  const g=flatGame(160),s=authored(g),e=g.world.net.edges.get(s.slots[0].steps[0].edge)!;
  const t=new Train(g,g.vehicles.nextId++,loco(),-1);t.segs=[makeSeg(g,e,1)];t.headPos=50;t.state='waiting';g.vehicles.map.set(t.id,t);g.vehicles.setRes(e.id,t.id);
  const split=g.world.net.splitEdge(e.id,45)!;assert.equal(g.railSections.membership(split.e1.id)!.section,s.id);assert.equal(commitRailSectionPlan(g,planSectionCount(g,s.id,2)).error,null);
  const loaded=deserialize(JSON.parse(json(g)));assert.equal(json(loaded),json(g));
  for(let i=0;i<80;i++){g.stepTick();loaded.stepTick();assert.equal(json(loaded),json(g));}
  checkReservations(g);checkReservations(loaded);checkNaN(g);
});
scenario('unknown payload schema is retained without adoption and editing reports compatibility', () => {
  const g=flatGame(160);rawRail(g);const d=serialize(g);d.net.railSections={schema:99,nextSection:300,sections:[{id:20,opaque:'future'}]};
  const loaded=deserialize(d);assert.deepEqual(serialize(loaded).net.railSections,d.net.railSections);
  const before=state(loaded),p=planSectionCount(loaded,20,2);assert.equal(p.error,'Unsupported rail section schema');assert.equal(state(loaded),before);
});
scenario('corrupt membership/allocators are rejected without touching the input or regenerating tracks', () => {
  const g=flatGame(160);authored(g,2);const d=serialize(g);d.net.railSections.sections[0].slots[1].steps[0].edge=999999;
  const before=JSON.stringify(d);assert.throws(()=>deserialize(d),/rail member/);assert.equal(JSON.stringify(d),before);
  const a=serialize(g);a.net.railSections.nextSlot=1;assert.throws(()=>deserialize(a),/rail slot/);
});
done();
