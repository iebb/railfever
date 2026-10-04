// A shallow underpass must support the entire existing road across its segment boundaries.
// Bundle as bridge-window.mjs. No private saves or synthetic terrain exceptions are required.
import { Game } from '../src/game/game';
import { planEdge, commitProposal, structureFactor } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';
import { ROAD_TYPES } from '../src/game/constants';
import { bezLine } from '../src/game/geom';
import { RoadVehicle, makeLaneSeg } from '../src/game/roadvehicle';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { terrainFit } from './terrainfit';
import { check, fails, free, roadOpts, railOpts } from './lib';
function setup(split = true) {
  const g = Game.create({ size: 256, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  g.aiEnabled = false; g.world.h.fill(3); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e8;
  const p = planEdge(g, free(g, 60, 128), free(g, 190, 128), roadOpts(1));
  check(p.ok && !commitProposal(g, p), 'existing foreign road is built');
  const net = g.world.net, road = [...net.edges.values()].find(e => e.kind === 'road')!;
  const cut = split ? net.splitEdge(road.id, 65)! : null;
  const quote = () => planEdge(g, free(g, 116, 106), free(g, 135, 150), railOpts(0, 1, { heightOffset: -0.65, crossing: 'under' }));
  return { g, net, road, cut, quote };
}
const f = setup(), p = f.quote(), saved = JSON.stringify(serialize(f.g));
console.log('split road quote', JSON.stringify({ ok: p.ok, errors: p.errors, crossings: p.crossings, works: p.roadBridges, cost: p.cost, split: p.stats.costSplit }));
check(p.ok && (p.roadBridges?.length ?? 0) === 2, 'the complete bridge window crosses the existing road split');
f.quote(); check(JSON.stringify(serialize(f.g)) === saved, 'bridge-window preview is pure');
const h = deserialize(serialize(f.g)), hp = planEdge(h, free(h, 116, 106), free(h, 135, 150), railOpts(0, 1, { heightOffset: -0.65, crossing: 'under' }));
const beforeProfile = f.cut && [f.cut.e1, f.cut.e2].map(e => ({ id: e.id, owner: e.owner, prof: [...e.prof] }));
const payer = f.g.economy.money, owner = f.g.company(1).economy.money, upkeep = f.g.maintenanceOf(1);
check(!commitProposal(f.g, p) && !commitProposal(h, hp), 'the quoted complete bridge commits both live and after load');
check(f.g.economy.money === payer-p.cost && f.g.company(1).economy.money === owner, 'the building company pays the complete quote, preserving the road titleholder cash');
check(f.g.maintenanceOf(1) > upkeep, 'the titleholder maintains the complete existing-road bridge');
check(beforeProfile?.every(q => { const e=f.net.edges.get(q.id); return e?.owner===q.owner && JSON.stringify([...e.prof])===JSON.stringify(q.prof); }), 'road ownership and graded profiles are preserved');
const fit = terrainFit(f.g);
check(fit.covered===0 && fit.floating===0, 'the split underpass supports every ground road and rail sample');
check(JSON.stringify(serialize(f.g))===JSON.stringify(serialize(h)), 'bridge construction decisions, cash, terrain and IDs replay exactly');
for(let i=0;i<640;i++){ f.g.stepTick(); h.stepTick(); check(JSON.stringify(serialize(f.g))===JSON.stringify(serialize(h)), 'fixed bridge ticks replay exactly'); if(fails.length)break; }
const whole = setup(false), wp=whole.quote();
check(wp.ok && Math.abs((wp.stats.costSplit?.bridges??0)-(p.stats.costSplit?.bridges??0))<2, 'splitting an existing road does not reduce the quoted support price');
const span=(p.roadBridges??[]).reduce((s,q)=>s+q.s1-q.s0,0);
check((p.stats.costSplit?.bridges??0)>=span*ROAD_TYPES.road.costPerUnit*(structureFactor('road','bridge',0)-1)-1, 'all new support is charged at the common bridge construction premium');
const partial=setup(); partial.cut!.e2.sections=[{s0:0,s1:2,type:'bridge'}]; partial.net.touchEdge(partial.cut!.e2);
const pq=partial.quote();
check(pq.ok && (pq.roadBridges?.length??0)===2 && (pq.stats.costSplit?.bridges??0)<(p.stats.costSplit?.bridges??0),
  'existing bridge support is retained while its remaining ground window is priced once');
const busy=setup(), bq=busy.quote(), bus=new RoadVehicle(busy.g,busy.g.vehicles.nextId++,MODEL_BY_ID.get('bus_b')!,-1);
bus.owner=1; bus.seg=makeLaneSeg(busy.g,busy.cut!.e1,1); bus.pos=bus.seg.len-1; bus.state='stopped'; busy.g.vehicles.map.set(bus.id,bus);
const occupied=JSON.stringify(serialize(busy.g));
check(busy.g.vehicles.isEdgeBusy(busy.cut!.e1.id) && /vehicle/i.test(commitProposal(busy.g,bq)??'') && JSON.stringify(serialize(busy.g))===occupied,
  'a physical bus on the adjacent support segment blocks the entire bridge commit before spending');
const funds=setup(), fq=funds.quote(); funds.g.economy.money=0; funds.g.economy.loan=funds.g.economy.maxLoan;
const noMoney=JSON.stringify(serialize(funds.g));
check(/money/i.test(commitProposal(funds.g,fq)??'') && JSON.stringify(serialize(funds.g))===noMoney, 'unfunded full-window work changes no cash, IDs, sections or terrain');
for(const boundary of ['branch','tunnel','end','stale'] as const){
  const b=setup(), net=b.net, cut=b.cut!, oldQuote=b.quote();
  if(boundary==='branch') { const n=net.addNode('road',125,3.04,140,0,0,1); net.addEdge('road',cut.node.id,n.id,bezLine(125,128,125,140),new Float32Array(13).fill(3.04),[],'road',1); }
  if(boundary==='tunnel') {cut.e1.sections=[{s0:60,s1:cut.e1.len,type:'tunnel'}];net.touchEdge(cut.e1);}
  if(boundary==='end') net.removeEdge(cut.e1.id);
  if(boundary==='stale') {cut.e2.prof[0]+=0.2;net.touchEdge(cut.e2);}
  const before=JSON.stringify(serialize(b.g)), next=b.quote();
  check(boundary==='stale' || !next.ok && /bridge window/i.test(next.errors.join(' ')), `${boundary}: incomplete road support is rejected during planning`);
  check(!!commitProposal(b.g,oldQuote) && JSON.stringify(serialize(b.g))===before, `${boundary}: stale work is rejected before any construction mutation`);
}
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode=fails.length?1:0;
