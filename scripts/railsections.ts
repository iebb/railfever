// Bundle as railsections.mjs. Stage 1: conservative identity, fragment continuity and mutation boundaries.
import { assert, flatGame, check, done, scenario, rawRail, authored, state, physical } from './sectionlib';
import { bezLine } from '../src/game/geom';
import { electrify, bulldoze } from '../src/game/build-ops';
import { station } from './stationlib';
import { setSignal } from '../src/game/signals';
import { railSAtU, railUAtS } from '../src/game/rail-section-types';
import { planSectionCount } from '../src/game/rail-section-ops';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
if (!process.argv[1]?.endsWith('railsections.mjs')) throw new Error('bundle as railsections.mjs');

for (const count of [1, 2, 3, 4] as const) scenario(`${count} authored/adopted slots; no physical migration`, () => {
  const g = flatGame(160), s = authored(g, count);
  assert.equal(s.count, count); assert.equal(s.origin, 'authored'); g.railSections.validate();
  const clone = flatGame(160);
  for (let i = 0; i < count; i++) rawRail(clone, bezLine(24, 64 + i * .45, 112, 64 + i * .45), { reverse: i % 2 === 1 });
  const before = physical(clone), ids = [clone.world.net.nextNode, clone.world.net.nextEdge, clone.world.net.nextCrossing];
  clone.railSections.adoptUnassigned(); assert.equal(physical(clone), before);
  assert.deepEqual([clone.world.net.nextNode, clone.world.net.nextEdge, clone.world.net.nextCrossing], ids);
  assert.equal(clone.railSections.sections.size, 1); assert.equal([...clone.railSections.sections.values()][0].count, count);
  clone.railSections.validate(); const json = JSON.stringify(clone.railSections.toJSON()); clone.railSections.adoptUnassigned(); assert.equal(JSON.stringify(clone.railSections.toJSON()), json);
});
scenario('unequal signal splits and reversed fragments retain one span and stable slots', () => {
  const g = flatGame(160), a = rawRail(g), b = rawRail(g, bezLine(24,64.45,112,64.45), { reverse: true });
  assert.equal(setSignal(g, a.id, 21, 'twoway', true, 0), null);
  const cut = g.world.net.splitEdge(b.id, 52)!; cut.node.signal = 2;
  g.railSections.adoptUnassigned(); const s = [...g.railSections.sections.values()][0];
  assert.equal(g.railSections.sections.size, 1); assert.equal(s.count, 2); assert.equal(s.traffic.signals.length, 0);
  const slot = s.slots.find((q) => q.steps.some((q) => q.edge === cut.e1.id))!, id = slot.id;
  const q = slot.steps[0], mid = (q.u0 + q.u1) / 2;
  assert.ok(Math.abs(railUAtS(q, railSAtU(q, mid)) - mid) < 1e-6);
  const split = g.world.net.splitEdge(q.edge, g.world.net.edges.get(q.edge)!.len / 2)!;
  assert.equal(g.railSections.membership(split.e1.id)!.slot, id); assert.equal(g.railSections.membership(split.e2.id)!.slot, id);
  assert.equal(g.railSections.membership(q.edge), undefined); g.railSections.validate();
});
scenario('short passing loop never supplies two slots over a longer main', () => {
  const g = flatGame(160), main = rawRail(g); rawRail(g, bezLine(45,64.45,90,64.45));
  g.railSections.adoptUnassigned(); assert.equal(g.railSections.get(g.railSections.membership(main.id)!.section)!.count, 1);
  assert.equal([...g.railSections.sections.values()].every((s) => s.count === 1), true);
});
scenario('partial loop at branch ports yields 1/2/1 spans, manual junction identity', () => {
  const g = flatGame(160), net = g.world.net, main = rawRail(g), c1 = net.splitEdge(main.id, 25)!, c2 = net.splitEdge(c1.e2.id, 38)!;
  rawRail(g, bezLine(49,64.45,87,64.45));
  for (const node of [c1.node, c2.node]) {
    const end = net.addNode('rail',node.x+8,3,node.z-12);
    net.addEdge('rail',node.id,end.id,bezLine(node.x,node.z,end.x,end.z),new Float32Array(17).fill(3),[],'standard',0);
  }
  g.railSections.adoptUnassigned();
  assert.equal(g.railSections.get(g.railSections.membership(c1.e1.id)!.section)!.count, 1);
  assert.equal(g.railSections.get(g.railSections.membership(c2.e1.id)!.section)!.count, 2);
  assert.equal(g.railSections.get(g.railSections.membership(c2.e2.id)!.section)!.count, 1);
  assert.ok([...g.railSections.junctions.values()].every((j) => j.origin === 'manual' && j.connectors.length === 0));
  g.railSections.validate();
});
for (const attribute of ['owner','wire','height','duplicate'] as const) scenario(`${attribute} ambiguity remains singleton`, () => {
  const g = flatGame(160); rawRail(g);
  rawRail(g, bezLine(24,64.45,112,64.45), { owner: attribute === 'owner' ? 1 : 0, type: attribute === 'wire' ? 'electric' : 'standard', y: attribute === 'height' ? 3.2 : 3 });
  if(attribute === 'duplicate') rawRail(g,bezLine(24,64.45,112,64.45));
  g.railSections.adoptUnassigned(); assert.equal([...g.railSections.sections.values()].every((s) => s.count === 1), true); g.railSections.validate();
});
scenario('through/platform attachment lookup excludes both from ordinary sections', () => {
  const g = flatGame(160), st = station(g,80,80,Math.PI/2,12,2,0,{through:2})!;
  g.railSections.adoptUnassigned(); assert.equal(g.railSections.sections.size, 0);
  for(const id of st.rail!.throughEdges) { assert.equal(g.world.net.edges.get(id)!.station,-1); assert.deepEqual(g.stations.railAttachment(id),{station:st.id,role:'through'}); }
  for(const id of st.rail!.edges) assert.deepEqual(g.stations.railAttachment(id),{station:st.id,role:'platform'});
});
scenario('signal, wire, depot and removal edits never leave discontinuous membership', () => {
  const g = flatGame(160), s = authored(g,2), net = g.world.net, id = s.slots[0].steps[0].edge;
  assert.equal(setSignal(g,id,30,'twoway',true,0),null); g.railSections.reconcile(); assert.equal(g.railSections.get(s.id)!.count,2);
  const fragment = g.railSections.get(s.id)!.slots[0].steps[0].edge;
  assert.equal(electrify(g,[fragment],0).error,null); g.railSections.reconcile(); g.railSections.validate();
  const e = net.edges.get(fragment)!; e.depot = 17; g.railSections.reconcile(); assert.equal(g.railSections.membership(e.id),undefined);
  const remaining = [...g.railSections.byEdge.keys()][0]; net.removeEdge(remaining); g.railSections.reconcile(); assert.equal(g.railSections.membership(remaining),undefined); g.railSections.validate();
});
scenario('buyout transfers existing section ownership; preview singleton lookup is pure', () => {
  const g = flatGame(160), e = rawRail(g,undefined,{owner:1});
  const before = state(g); for(let i=0;i<4;i++) assert.equal(g.railSections.viewForEdge(e.id)!.id,0); assert.equal(state(g),before);
  g.railSections.adoptUnassigned(); const s = [...g.railSections.sections.values()][0]; e.owner = 0; g.railSections.reconcile();
  assert.equal(g.railSections.get(s.id)!.owner,0); assert.equal(planSectionCount(g,s.id,2).ok,true);
});
scenario('real buyout and immediate wire/relevel/demolition saves stay valid before a network flush', () => {
  const g=Game.create({size:160,seed:7,towns:0,hilliness:'flat',water:'low',startYear:1990,aiCompanies:1});g.aiEnabled=false;g.economy.money=4e8;g.world.h.fill(3);
  const e=rawRail(g,undefined,{owner:1});g.railSections.adoptUnassigned();const sid=g.railSections.membership(e.id)!.section;
  assert.equal(g.buyCompany(0,1),null);assert.equal(g.railSections.get(sid)!.owner,0);assert.equal(g.railSections.membership(e.id)!.section,sid);
  assert.equal(electrify(g,[e.id],0).error,null);assert.equal(g.railSections.get(sid)!.type,'electric');
  const snapshot=JSON.stringify(serialize(g));assert.equal(JSON.stringify(serialize(deserialize(JSON.parse(snapshot)))),snapshot);
  e.prof[10]+=.1;g.world.net.touchEdge(e);g.onNetworkChanged();assert.equal(g.railSections.get(sid),undefined);g.railSections.validate();
  const after=JSON.stringify(serialize(g));assert.equal(JSON.stringify(serialize(deserialize(JSON.parse(after)))),after);
  assert.equal(bulldoze(g,60,64,60,64,0,false).error,null);g.railSections.validate();assert.equal(g.railSections.membership(e.id),undefined);
  const removed=JSON.stringify(serialize(g));assert.equal(JSON.stringify(serialize(deserialize(JSON.parse(removed)))),removed);
});
scenario('temporary joint-construction owner is never captured by a synchronous network notification', () => {
  const g=flatGame(160),s=authored(g),e=g.world.net.edges.get(s.slots[0].steps[0].edge)!;
  e.owner=1;g.onNetworkChanged();assert.equal(s.owner,0);e.owner=0;g.flushNetworkChanges();assert.equal(g.railSections.get(s.id),s);g.railSections.validate();
});
done();
