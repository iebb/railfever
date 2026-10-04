// Extendable city trunks through real neighbouring centres. Bundle as urbantrunks.mjs.
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import type { Town } from '../src/game/towns';
import { bezLine } from '../src/game/geom';
import { linearStops } from '../src/game/lines';
import { railPartMode } from '../src/game/stations';
import { terminusOf, outerEnd, forecastSeatFactor } from '../src/game/ai-grow';
import { urbanTrunks, onwardCentres } from '../src/game/ai-urban';
import { walkingCatchment, planWalkingCatchment } from '../src/game/catchment';
import { serialize, deserialize } from '../src/game/save';
import { planEdge, commitProposal } from '../src/game/construction';
import { planDoubleTrackFinish, finishDoubleTrack } from '../src/game/trackops';
import { deadlockCycles } from '../src/game/train';
import { marginalSharedTrain } from '../src/game/ai-capacity';
import { SIGNAL_COST } from '../src/game/signals';
import { stationEnds, nodeSnap } from '../src/game/routing';
import { discountedPayback, URBAN_PAYBACK, RAIL } from '../src/game/constants';
import { scheduleNetworkTask, networkPlanner, networkProfile } from '../src/game/ai-network';
import { check, fails, fmt, checkReservations } from './lib';
import { writeFileSync } from 'node:fs';
const access = (ai: AIController) => ai as AIController & Record<string, any>;
const saved = (g: Game) => JSON.stringify(serialize(g));
const audit = (name: string, g: Game) => { if (process.env.TRUNK_AUDIT_DIR) writeFileSync(process.env.TRUNK_AUDIT_DIR + '/' + name + '.json', saved(g)); };
function flat(ais: number, size = 512) {
  const g = Game.create({ size, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: Array.from({ length: ais }, () => ({ startMoney: 100_000_000, accessPolicy: 'open' as const })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  return g;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
/**
 * Dense apartment neighbourhoods on a connected pedestrian grid; reserve the centre railway alignment (no buildings
 * on it). `crossStreets`: the grid's streets cross the alignment as well, as a real grid's do (else it is a free strip
 * that a street-level line could take without a single crossing street).
 */
function town(g: Game, name: string, x: number, z: number, pop: number, width = 120, height = 64, crossStreets = false): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0,
    passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) {
    if (!crossStreets && zs[i - 1] < z && zs[i] > z) continue;
    road(g, rx, zs[i - 1], rx, zs[i]);
  }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) {
    if (Math.abs(rz - z) < 7) continue; // platforms and their entrances can be built without clearing the town
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  g.demand.rebuild(); return t;
}

const isScenario = (name: string) => !process.argv[2] || process.argv[2] === name;
if (isScenario('finishing')) {
  const g = flat(1), me = g.ais[0].companyId, net = g.world.net;
  const pair = (x: number, L: number, y = 4, z = 80, type = 'standard') => {
    const ns = [net.addNode('rail',x,y,z,1,0,me),net.addNode('rail',x,y,z+RAIL.spacing,1,0,me),
      net.addNode('rail',x+L,y,z,-1,0,me),net.addNode('rail',x+L,y,z+RAIL.spacing,-1,0,me)];
    const snap = (ids: number[]) => ({ kind:'node' as const,x:net.nodes.get(ids[0])!.x,y,z:net.nodes.get(ids[0])!.z,node:ids[0],group:ids });
    return planEdge(g,snap([ns[0].id,ns[1].id]),snap([ns[3].id,ns[2].id]),
      {kind:'rail',type,tracks:2,heightOffset:0,crossing:'auto',owner:me,...(y<4?{level:'underground' as const,levelDepth:4-y}:{})});
  };
  const proposal = pair(80,100), before = saved(g), plan = planDoubleTrackFinish(g,proposal,me);
  if(!proposal.ok)console.log('prospective formation',proposal.errors,proposal.tracks.length);
  check(!plan.error && plan.crossovers===4,'prospective double formation has both complete endpoint crossover pairs');
  check(saved(g)===before,'successful directional preflight does not mutate save, funds, allocators or signals');
  const edge0 = net.nextEdge;
  check(!commitProposal(g,proposal),'native prospective formation commits');
  const ids = [...net.edges.keys()].filter(id=>id>=edge0);
  const actual = finishDoubleTrack(g,ids,me,{crossoversAt:'always'});
  console.log('directional preflight parity',JSON.stringify({plan,actual}));
  check(!actual.error && actual.crossovers===plan.crossovers,'native finish constructs the forecast endpoint crossover geometry');
  check(Math.abs((plan.cost-plan.signals*SIGNAL_COST)-(actual.cost-actual.signals*SIGNAL_COST))<50,
    'prospective and actual native crossover prices agree within numerical rounding');
  check(actual.cost<=plan.cost,'directional budget covers native crossovers and actual signals');
  check(Math.abs(actual.track!-plan.track!)<.005 && Math.abs(actual.upkeep!-plan.upkeep!)<2,
    'prospective crossover arc length and section-weighted annual upkeep match native installation');
  const short = pair(260,15), rejectedState = saved(g), rejected = planDoubleTrackFinish(g,short,me);
  check(!!rejected.error,'a short formation without two complete crossover windows rejects before purchase');
  check(saved(g)===rejectedState,
    'rejected directional preflight preserves the existing route, directions and construction accounts');

  const tunnel=pair(80,100,0,400,'electric'),tunnelBefore=saved(g),tunnelPlan=planDoubleTrackFinish(g,tunnel,me);
  check(!tunnelPlan.error&&saved(g)===tunnelBefore,'electric tunnel crossover forecast is pure and feasible');
  const tunnelEdge0=net.nextEdge;check(!commitProposal(g,tunnel),'electric underground prospective pair commits');
  const tunnelActual=finishDoubleTrack(g,[...net.edges.keys()].filter(id=>id>=tunnelEdge0),me,{crossoversAt:'always'});
  console.log('tunnel upkeep parity',JSON.stringify({plan:tunnelPlan,actual:tunnelActual}));
  check(!tunnelActual.error&&Math.abs(tunnelActual.upkeep!-tunnelPlan.upkeep!)<2&&Math.abs(tunnelActual.track!-tunnelPlan.track!)<.005,
    'electric tunnel crossover upkeep and arc length agree with actual native installation');

  const h=flat(1), owner=h.ais[0].companyId, planned=[140,200,260,320].map(x=>
    h.stations.planRail(x,160,Math.PI/2,7,2,owner,{trackType:'electric',mode:'lightrail',level:'elevated',height:3.5}));
  const sts=planned.map(p=>{const id=h.stations.nextId;check(p.ok&&!h.stations.commitRail(p,owner),'three-gap native station commits');return h.stations.get(id)!;});
  let quoteCost=0,quoteTrack=0,quoteUpkeep=0,quoteCrossovers=0,quoteSignals=0;
  const links:number[]=[];
  for(let i=0;i<3;i++) {
    const a=stationEnds(h,sts[i]).map(e=>e.front),b=stationEnds(h,sts[i+1]).map(e=>e.back);
    const pj=planEdge(h,nodeSnap(h,a[0],'rail'),nodeSnap(h,b[0],'rail'),{kind:'rail',type:'electric',tracks:2,heightOffset:0,owner,crossing:'auto'});
    const before=saved(h),fin=planDoubleTrackFinish(h,pj,owner,planned);
    check(!fin.error&&saved(h)===before,'each actual prospective gap has pure complete endpoint windows');
    quoteCost+=fin.cost;quoteTrack+=fin.track!;quoteUpkeep+=fin.upkeep!;quoteCrossovers+=fin.crossovers;quoteSignals+=fin.signals;
    const edge0=h.world.net.nextEdge;check(!commitProposal(h,pj),'three-gap native paired link commits');
    links.push(...[...h.world.net.edges.keys()].filter(id=>id>=edge0));
  }
  const completed=finishDoubleTrack(h,links,owner);
  console.log('inline finish parity',JSON.stringify({quoteCost,quoteCrossovers,quoteSignals,quoteTrack,quoteUpkeep,completed}));
  check(!completed.error&&completed.crossovers===quoteCrossovers,'whole-pair finishing retains the quoted optional inline and mandatory terminal windows');
  check(completed.cost<=quoteCost&&quoteCost-completed.cost<=quoteSignals*SIGNAL_COST,
    'three-gap crossover capital quote covers actual finish within its explicit signal reserve');
  check(Math.abs(completed.track!-quoteTrack)<.02&&Math.abs(completed.upkeep!-quoteUpkeep)<25,
    'three-gap native installed arcs and elevated upkeep agree with the same per-gap prospective geometry');
}
if (isScenario('loads')) {
  const g=flat(1);g.aiEnabled=false;
  const ts=[town(g,'Load West',120,256,6000,32,32,true),town(g,'Empty Middle',240,256,0,32,32,true),town(g,'Load East',360,256,6000,32,32,true)];
  const ps=ts.map(t=>g.stations.planRail(t.x,t.z,Math.PI/2,7,2,g.ais[0].companyId,{trackType:'lightrail',mode:'lightrail',level:'elevated',height:3.5,entrances:4}));
  check(ps.every(p=>p.ok),'long-rider fixture has three native prospective sites');
  const before=saved(g), long=g.demand.forecastLine(ps,'lightrail',42,100,g.ais[0].companyId), short=g.demand.forecastLine([ps[0],ps[2]],'lightrail',42,100,g.ais[0].companyId);
  console.log('forecast leg loads',JSON.stringify({long,short}));
  check(saved(g)===before,'directional load forecasts remain pure');
  check(long.boardings>0 && Math.abs(long.legLoads.reduce((a,b)=>a+b,0)-2*long.boardings)<1e-7,
    'an end-to-end passenger occupies both native forecast legs');
  check(Math.abs(short.legLoads.reduce((a,b)=>a+b,0)-short.boardings)<1e-7,
    'one-hop riders occupy one leg each');
  const overlap=forecastSeatFactor([240,240,0,0],720,1,240), disjoint=forecastSeatFactor([120,120,0,0],720,1,240);
  check(Math.abs(overlap-0.7)<1e-12 && disjoint===1,'equal boarding totals consume different capacity when trips overlap a leg');
  check(forecastSeatFactor([240,240,0,0],720,2,240)===1 && forecastSeatFactor([240,240,0,0],1440,2,240)===overlap,
    'fleet and full route cycle determine the seats supplied in each direction');
}
if (isScenario('detour')) {
  const g = flat(1); g.aiEnabled = false;
  const ts = [town(g,'Detour West',120,256,6000,32,32,true),town(g,'Detour Middle',240,336,6000,32,32,true),town(g,'Detour East',360,256,6000,32,32,true)];
  const before = saved(g), candidates = ts.flatMap(t => urbanTrunks(g,t,26,5));
  check(candidates.length===0,'off-axis compact centres cannot create a straight city trunk with empty extra stops');
  check(!onwardCentres(g,120,256,1,0,new Set([ts[0].id,ts[2].id]),26).length,
    'an off-axis neighbour does not divert an existing straight trunk from its continuation');
  check(saved(g)===before,'detour rejection is pure and creates no track, depot, vehicle or funding changes');
}
if (isScenario('trunk')) {
const g = flat(1), ai = g.ais[0], a = access(ai);
g.aiEnabled = false; g.vehicles.ambientEnabled = false;
const centres = [120, 240, 360].map((x, i) => town(g, 'Centre ' + i, x, 256, 6000, 32, 32, true));
const before = saved(g), geometric = urbanTrunks(g, centres[1], 26, 5);
check(geometric.some(c => c.towns.length === 3 && c.targets.length === 3), 'three aligned native centres have a through corridor candidate');
check(saved(g) === before, 'corridor search is pure');
const survey = a.urbanStep(centres[1], 'lightrail'); let r = survey.next(); while (!r.done) r = survey.next();
console.log('selected survey', JSON.stringify({ towns: r.value.towns, targets: r.value.targets, quote: r.value.quote && { net:r.value.quote.net,total:r.value.quote.total } }));
check((r.value.towns?.length ?? 1) === 3, 'real forecasts and works rank the through-centre corridor above a local opening');
check(ai.startProject('lightrail', [centres[1].id]), 'city trunk starts under ordinary funding and profitability gates');
g.aiEnabled = true;
const replays: { g: Game; stage: string }[] = [], checkpoints = new Set<string>();
let ticks = 0, exact = true;
while (ai.busy && ticks++ < 40000) {
  g.stepTick(); for (const replay of replays) replay.g.stepTick();
  const task=a.urbanTask, stage=a.urbanSurvey?.trial>0?'survey':task?.stage==='stations'&&task.at>0?'stations':null;
  if (stage && !checkpoints.has(stage)) { const data=saved(g), loaded=deserialize(JSON.parse(data)); check(saved(loaded)===data, stage + ' checkpoint is immediately exact'); replays.push({g:loaded,stage});checkpoints.add(stage); }
  if (g.tick % g.ticksPerDay===0) for (const replay of replays) {
    if (saved(g)!==saved(replay.g)) { console.log('replay mismatch',replay.stage,g.day); exact=false; }
  }
}
g.aiEnabled=false;
console.log('opening',ai.log.slice(-6).join(' | '));
const info=[...a.lines].find(([,i]:any)=>i.urban),line=info&&g.lines.get(info[0]),path=line?linearStops(line.stops):null;
check(!ai.busy && !!line, 'the profitable centre trunk completes within the normal work budget');
check(checkpoints.size===2 && exact,'survey and partial construction resume exactly at fixed work-unit checkpoints');
if (line && path) {
  const towns=new Set(path.map(id=>g.stations.get(id)!.townId));
  check(towns.size===3 && centres.every(c=>path.some(id=>g.stations.get(id)!.townId===c.id && Math.hypot(g.stations.get(id)!.x-c.x,g.stations.get(id)!.z-c.z)<10)), 'one ordinary railway serves all three actual town centres');
  check(path.every(id=>railPartMode(g.stations.get(id)!.rail!)==='lightrail'),'one physical track carries the city service');
  for(const [id,near] of [[path[0],path[1]],[path[path.length-1],path[path.length-2]]]) {
    const st=g.stations.get(id)!,te=terminusOf(g,st,outerEnd(st,g.stations.get(near)!),ai.companyId);
    check(te?.kind==='free'||te?.kind==='tail',st.name+' retains an extendable through end');
  }
  const catchPop=path.map(id=>{const st=g.stations.get(id)!;return [...walkingCatchment(g,st).buildings].reduce((n,[b])=>n+(g.world.buildings.get(b)?.pop??0),0)});
  check(catchPop.every(n=>n>0),'every centre stop has real pedestrian access to occupied buildings');
  const target=g.day+3*360;while(g.day<target)g.stepTick();
  const net=line.incomeLast-line.costLast-g.maintenanceOf(ai.companyId);
  console.log('mature trunk',JSON.stringify({centres:[...towns],stops:path.length,catchPop,income:line.incomeLast,cost:line.costLast,upkeep:g.maintenanceOf(ai.companyId),net}));
  check(net>0,'mature actual passenger receipts exceed vehicles and all corridor/station/depot upkeep');
  check(checkReservations(g).length===0,'trunk reservations remain consistent');

  const busy = g.vehicles.trains().flatMap(t=>t.occupiedEdges())[0];
  check(busy!==undefined,'running trunk supplies a genuinely occupied clearance obstacle');
  if (busy!==undefined) {
    const before = saved(g), result = finishDoubleTrack(g,[],ai.companyId,{ignoreEdges:[busy]});
    check(!!result.error && saved(g)===before,'busy-track exclusion rejects without changing the old running route or signals');
    const foreign = deserialize(serialize(g)), edge = foreign.world.net.edges.get(busy)!;
    edge.owner = 0;
    const foreignBefore = saved(foreign), denied = finishDoubleTrack(foreign,[],ai.companyId,{ignoreEdges:[busy]});
    check(!!denied.error && saved(foreign)===foreignBefore,'foreign-track exclusion rejects without changing assets or accounts');
  }

  const next = town(g, 'Next Centre', 464, 256, 16000, 64, 48, true);
  const start = g.day, growthRuns: { g: Game; day: number; exact: boolean }[] = [];
  let constructionSave = false, unchanged: Game | undefined, investmentStart = 0;
  let constructionStart = 0, vehiclesStart = 0, debtStart = 0;
  let failedFinishRecovery: {g:Game;oldRail:number[];oldSignals:string;paid:number;construction:number;day:number}|undefined;
  let growing = false, comparisons = 0;
  g.aiEnabled = true; ai.state.cooldown = 1e9;
  scheduleNetworkTask(ai, 'extend', 0);
  while (g.day < start + 720) {
    const network = g.tick % g.ticksPerDay === 0 ? serialize(g).aiNetwork : undefined;
    const cursor = network?.companies.flatMap(([,p])=>p.job?.items??[]).map(i=>i.grow).find(c=>c?.best&&!c.best.fleet);
    if (cursor && !unchanged) {
      unchanged = deserialize(serialize(g)); unchanged.aiEnabled = false;
      investmentStart = ai.eco.money;
      constructionStart = ai.eco.thisYear.construction; vehiclesStart = ai.eco.thisYear.vehicles; debtStart = ai.eco.loan;
      audit('before-continuation',unchanged);
      console.log('investment checkpoint',JSON.stringify({day:g.day,trains:line.vehicles.length,cursor}));
      const train=g.vehicles.trains().find(t=>t.lineId===line.id&&t.owner===ai.companyId)!;
      check(marginalSharedTrain(g,line,ai.companyId,train.cars,train.pattern)<=0,
        'an impossible extra fleet departure does not displace the positively priced continuation');
    }
    const partial = network?.companies.some(([,p]) => p.job?.items?.some(i => i.grow?.made));
    const finishing = network?.companies.flatMap(([,p])=>p.job?.items??[]).map(i=>i.grow).find(c=>c?.made?.links.length&&c.at===(c.opts?.length??0)+3);
    if(finishing?.made && !failedFinishRecovery) {
      const copy=deserialize(serialize(g)),b=finishing.made,created=new Set([...b.links,...b.pieces,...(b.debits??[]).flatMap(d=>d.edges)]);
      const oldRail=[...copy.world.net.edges.values()].filter(e=>e.kind==='rail'&&!created.has(e.id)&&!b.stations.includes(e.station)).map(e=>e.id);
      const oldNodes=new Set(oldRail.flatMap(id=>{const e=copy.world.net.edges.get(id)!;return[e.a,e.b]}));
      const oldSignals=JSON.stringify([...oldNodes].map(id=>{const n=copy.world.net.nodes.get(id)!;return[id,n.signal,n.signalKind,n.signalPass]}));
      // Another investment consumes the funds after the saved quote, leaving enough for one native elevated
      // crossover but not its partner. The fin must refund it, remove its new splits, and retain the old service.
      copy.company(ai.companyId).economy.spend(Math.max(0,copy.company(ai.companyId).economy.money-300000),'construction',true);
      failedFinishRecovery={g:copy,oldRail,oldSignals,paid:b.spent,construction:copy.company(ai.companyId).economy.thisYear.construction,day:copy.day};
    }
    if (g.tick % g.ticksPerDay === 0 && networkPlanner(ai)?.task === 'extend' && (growthRuns.length < 6 || partial && !constructionSave)) {
      const data = saved(g), loaded = deserialize(JSON.parse(data));
      check(saved(loaded) === data, 'neighbour extension day ' + g.day + ' is immediately exact');
      growthRuns.push({ g: loaded, day: g.day, exact: true });
      if (partial) constructionSave = true;
    }
    g.stepTick(); for (const replay of growthRuns) if (replay.exact) replay.g.stepTick();
    unchanged?.stepTick();
    if (g.tick % g.ticksPerDay === 0) for (const replay of growthRuns) if (replay.exact) {
      comparisons++;
      if (saved(g) !== saved(replay.g)) { replay.exact = false; check(false, 'neighbour extension saved day ' + replay.day + ' differs on day ' + g.day); }
    }
    growing ||= networkPlanner(ai)?.task === 'extend';
    if (growing && networkPlanner(ai)?.task !== 'extend' && linearStops(line.stops)?.length === 4) break;
  }
  g.aiEnabled = false;
  audit('after-continuation',g);
  const extended = linearStops(line.stops)!;
  console.log('neighbour extension', JSON.stringify({ day:g.day, stops:extended.length, replays:growthRuns.length, comparisons, decisions:networkProfile.decisions, notes:ai.log.slice(-6) }));
  check(extended.length === 4 && extended.some(id => g.stations.get(id)?.townId === next.id), 'the same trunk extends to the next actual town centre under incremental economic gates');
  check(growthRuns.length >= 2 && constructionSave && growthRuns.every(r => r.exact), 'saved cross-town survey, valuation and actual partial construction resume exactly');
  const end = g.stations.get(extended[extended.length - 1])!;
  check(Math.hypot(end.x-next.x,end.z-next.z)<10, 'the continuation stops within walking reach of the neighbour centre');
  const capital = constructionStart-ai.eco.thisYear.construction+vehiclesStart-ai.eco.thisYear.vehicles;
  check(extended.length===4 && capital>0,'continuation accounts contain the actual committed infrastructure and vehicle investment');
  console.log('continuation investment',JSON.stringify({capital,construction:constructionStart-ai.eco.thisYear.construction,
    vehicles:vehiclesStart-ai.eco.thisYear.vehicles,cashChange:investmentStart-ai.eco.money,debtBefore:debtStart,debtAfter:ai.eco.loan}));
  const after = g.day + 3 * 360; while (g.day < after) { g.stepTick(); unchanged?.stepTick(); }
  const interest = -(ai.eco.yearTotals.at(-1)?.v.interest ?? 0);
  const grownNet = line.incomeLast - line.costLast - g.maintenanceOf(ai.companyId) - interest;
  const unLine = unchanged?.lines.get(line.id), oldInterest = -(unchanged?.company(ai.companyId).economy.yearTotals.at(-1)?.v.interest ?? 0);
  const oldNet = unLine ? unLine.incomeLast-unLine.costLast-unchanged!.maintenanceOf(ai.companyId)-oldInterest : 0;
  console.log('mature extended trunk',JSON.stringify({income:line.incomeLast,cost:line.costLast,upkeep:g.maintenanceOf(ai.companyId),net:grownNet,unchangedNet:oldNet,increment:grownNet-oldNet,capital}));
  audit('mature-continuation',g); if(unchanged)audit('mature-unchanged',unchanged);
  check(!!unchanged && grownNet-oldNet>0,'the continuation improves actual matching-year surplus over retaining the existing route');
  const pv = (grownNet-oldNet)*discountedPayback(URBAN_PAYBACK.lightrail,ai.eco.interestRate);
  console.log('continuation recovery',JSON.stringify({interest,oldInterest,increment:grownNet-oldNet,capital,pv}));
  check(extended.length===4 && pv>capital,'actual incremental surplus repays actual capital within the normal discounted civil horizon');
  check(grownNet>0,'the extended centre trunk earns positive actual surplus after all upkeep');
  check(checkReservations(g).length===0,'extended trunk reservations remain consistent');
  if(failedFinishRecovery) {
    const f=failedFinishRecovery,h=f.g,controller=h.ais[0];
    while(h.day<f.day+20&&!controller.log.some(s=>s.includes('incomplete directional extension')))h.stepTick();
    h.aiEnabled=false;
    const retained=[...h.world.net.edges.values()].filter(e=>e.kind==='rail').map(e=>e.id),oldNodes=new Set(f.oldRail.flatMap(id=>{const e=h.world.net.edges.get(id);return e?[e.a,e.b]:[]}));
    const signals=JSON.stringify([...oldNodes].map(id=>{const n=h.world.net.nodes.get(id)!;return[id,n.signal,n.signalKind,n.signalPass]}));
    const refund=h.company(ai.companyId).economy.thisYear.construction-f.construction;
    console.log('failed directional recovery',JSON.stringify({notes:controller.log.slice(-2),oldEdges:f.oldRail.length,retained:retained.length,refund,paid:f.paid}));
    check(controller.log.some(s=>s.includes('incomplete directional extension'))&&linearStops(h.lines.get(line.id)!.stops)?.length===3,
      'loss of funds between stages rejects incomplete directional construction and retains the old stopping route');
    check(retained.length===f.oldRail.length&&retained.every(id=>f.oldRail.includes(id))&&signals===f.oldSignals,
      'failed finish removes every new fragment/crossover and preserves old track directions and depot access');
    check(refund>0&&refund<=f.paid,'rollback refunds only the removed paid draft once');
    check(checkReservations(h).length===0,'failed-direction recovery retains valid old-service reservations');
  } else check(false,'actual final-construction stage was sampled for failed-direction recovery');
  let cycles=0,arrivals=0,maxWait=0;const states=new Map<number,string>();
  const auditEnd=g.day+360;while(g.day<auditEnd) {
    g.stepTick();
    for(const t of g.vehicles.trains()) {
      if(t.lineId!==line.id)continue;
      if(t.state==='loading'&&states.get(t.id)!=='loading')arrivals++;
      states.set(t.id,t.state);maxWait=Math.max(maxWait,t.stuckTime);
    }
    if(g.tick%g.ticksPerDay===0)cycles+=deadlockCycles(g,0).length;
  }
  console.log('directional continuation operations',JSON.stringify({cycles,arrivals,maxWait}));
  check(cycles===0 && arrivals>0,'complete new-pair directional running has no opposing reservation cycles and continues arriving');
}

}
if (isScenario('centres')) {
const central = flat(1, 768), centralAI = central.ais[0];
central.aiEnabled = false; central.vehicles.ambientEnabled = false;
const ca = town(central, 'Upper Eastbrook', 210, 384, 3234, 120, 64, true);
const cb = town(central, 'Port Grantmouth', 410, 384, 2330, 120, 64, true);
const cityCopy = deserialize(serialize(central)), cityAI = cityCopy.ais[0];
const twoSurvey = access(centralAI).urbanStep(ca,'lightrail'); let twoResult = twoSurvey.next(); while(!twoResult.done)twoResult=twoSurvey.next();
console.log('two-town urban quote',JSON.stringify({towns:twoResult.value.towns,targets:twoResult.value.targets,quote:twoResult.value.quote&&{capital:twoResult.value.quote.total,net:twoResult.value.quote.net}}));
check(urbanTrunks(central,ca,26,5).some(c=>c.towns.length===2&&c.targets.length>=3),'two actual centres and occupied neighbourhoods form a longer urban corridor candidate');
check(cityAI.startProject('lightrail',[ca.id]),'the two small centres can open an ordinary urban trunk');
cityCopy.aiEnabled=true;let ut=0;while(cityAI.busy&&ut++<40000)cityCopy.stepTick();cityCopy.aiEnabled=false;
const cityLine=[...cityCopy.lines.map.values()].find(l=>l.kind==='rail'&&l.owner===cityAI.companyId);
console.log('two-town urban opening',JSON.stringify({ticks:ut,notes:cityAI.log.slice(-4),stops:cityLine?.stops}));
check(!cityAI.busy&&!!cityLine,'two-town city trunk opens under the existing forecast, capital and construction gates');
if(cityLine) {
  const path=linearStops(cityLine.stops)!,points=path.map(id=>cityCopy.stations.get(id)!);
  check(points.length>=3&&[ca,cb].every(t=>points.some(st=>st.townId===t.id&&Math.hypot(st.x-t.x,st.z-t.z)<10)),
    'the small-town trunk has occupied urban stops and serves both actual centres');
  for(const [st,other] of [[points[0],points[1]],[points[points.length-1],points[points.length-2]]]) {
    const end=terminusOf(cityCopy,st,outerEnd(st,other),cityAI.companyId);
    check(end?.kind==='free'||end?.kind==='tail','the two-town trunk retains an extendable terminus');
  }
  const end=cityCopy.day+3*360;while(cityCopy.day<end)cityCopy.stepTick();
  const net=cityLine.incomeLast-cityLine.costLast-cityCopy.maintenanceOf(cityAI.companyId);
  console.log('mature two-town urban trunk',JSON.stringify({income:cityLine.incomeLast,cost:cityLine.costLast,upkeep:cityCopy.maintenanceOf(cityAI.companyId),net}));
  check(net>0,'two-town urban trunk earns positive actual surplus after all upkeep');
}
const centralAccess = access(centralAI), tested: { town: number; level: string; pop: number; x: number; z: number }[] = [];
const centreSite = centralAccess.centreStation;
centralAccess.centreStation = function*(t: Town, to: {x:number;z:number}, length: number, level: string) {
  const p = yield* centreSite.call(this,t,to,length,level);
  if(p) tested.push({town:t.id,level,pop:[...planWalkingCatchment(central,p).buildings].reduce((n,[id])=>n+(central.world.buildings.get(id)?.pop??0),0),x:p.x,z:p.z});
  return p;
};
check(centralAI.startProject('rail', [ca.id, cb.id]), 'a screenshot-sized two-town railway can survey central alternatives');
central.aiEnabled = true;
let ct = 0; while (centralAI.busy && ct++ < 40000) central.stepTick();
central.aiEnabled = false;
console.log('central railway', JSON.stringify({ticks:ct,alternatives:tested,notes:centralAI.log.slice(-8),stations:[...central.stations.map.values()].map(st=>({x:st.x,z:st.z,level:st.rail?.level,pop:st.catchPop}))}));
const centralLine = [...central.lines.map.values()].find(l=>l.kind==='rail'&&l.owner===centralAI.companyId);
check(!centralAI.busy && !!centralLine, 'central siting completes under the original bounded rail work budget');
if (centralLine) {
  const points = linearStops(centralLine.stops)!.map(id=>central.stations.get(id)!);
  check([ca,cb].every(t=>tested.some(p=>p.town===t.id&&Math.hypot(p.x-t.x,p.z-t.z)<15&&p.pop>0)), 'both small towns price genuinely accessible central alternatives without a population cutoff');
  const year = central.day+3*360; while(central.day<year)central.stepTick();
  const net = centralLine.incomeLast-centralLine.costLast-central.maintenanceOf(centralAI.companyId);
  console.log('mature central railway',JSON.stringify({income:centralLine.incomeLast,cost:centralLine.costLast,upkeep:central.maintenanceOf(centralAI.companyId),net}));
  check(net>0,'small-town central railway earns positive actual surplus after all upkeep');
}

for (const [label,pop,funds] of [['no funds',3234,0],['no demand',0,100_000_000]] as const) {
  const h=flat(1),ai=h.ais[0];h.aiEnabled=false;h.vehicles.ambientEnabled=false;
  const x=town(h,'Reject West',150,256,pop,120,64,true),y=town(h,'Reject East',350,256,pop,120,64,true);
  ai.eco.money=funds;ai.eco.loan=0;ai.eco.maxLoan=0;
  const net0=h.world.net.edges.size,nodes0=h.world.net.nodes.size;
  check(ai.startProject('rail',[x.id,y.id]),label+' starts a pure quotation');
  h.aiEnabled=true;let ticks=0;while(ai.busy&&ticks++<40000)h.stepTick();h.aiEnabled=false;
  console.log('central rejection',JSON.stringify({label,ticks,notes:ai.log.slice(-3)}));
  check(!ai.busy&&h.stations.map.size===0&&h.depots.map.size===0&&h.vehicles.map.size===0&&h.world.net.edges.size===net0&&h.world.net.nodes.size===nodes0,
    label+' rejects central/surface works without creating track, stations, depots or vehicles');
  check(ai.eco.money===funds&&ai.eco.loan===0,label+' does not spend or borrow');
}
}

if(isScenario('native-sites')) {
  for(const tid of [0,1]) {
    const g=Game.create({size:768,seed:23,towns:Math.round(768/42),hilliness:'hilly',water:'medium',startYear:1985,
      aiConfigs:Array.from({length:3},()=>({focus:{rail:2.5,road:1.2,tram:.5}}))});
    g.aiEnabled=false;g.aiAcquisitions=false;g.vehicles.ambientEnabled=false;
    for(const company of g.ais)company.state.cooldown=1e9;
    const ai=g.ais[1],a=access(ai),T=g.towns.list[tid],before=saved(g);
    const survey=a.urbanStep(T,'lightrail');let result=survey.next();while(!result.done)result=survey.next();
    const layout=result.value;
    console.log('native feasible starter',JSON.stringify({seed:23,size:768,town:T.name,footprint:layout.towns??[tid],targets:layout.targets,
      capital:layout.quote?.total,net:layout.quote?.net}));
    check(!layout.towns||layout.towns.length===1,T.name+' does not price impossible centre platforms as virtual stops');
    check(saved(g)===before,T.name+' rejects the unbuildable preliminary corridor without spending or changing assets');
    check(ai.startProject('lightrail',[tid]),T.name+' starts its ordinary funded native alternative');
    g.aiEnabled=true;let copy:Game|undefined,ticks=0,exact=true;
    while(ai.busy&&ticks++<40000) {
      g.stepTick();copy?.stepTick();
      const cursor=a.urbanSurvey;
      if(!copy&&cursor?.trial>0&&cursor.site===0&&(cursor.trials[cursor.trial-1]?.layout.towns?.length??0)>1) {
        const frozen=saved(g);copy=deserialize(JSON.parse(frozen));
        check(saved(copy)===frozen,T.name+' skipped native corridor trial round-trips exactly');
      }
      if(copy&&g.tick%g.ticksPerDay===0)exact&&=saved(g)===saved(copy);
    }
    const info=[...a.lines].find(([,i]:any)=>i.urban),line=info&&g.lines.get(info[0]);
    check(!ai.busy&&!!line,T.name+' constructs and runs the feasible native starter');
    check(!!copy&&exact,T.name+' saved skipped trials continue exactly through construction');
    if(line) {
      check(line.stops.every(id=>g.stations.get(id)?.townId===tid),T.name+' serves its actual occupied city districts');
      g.aiEnabled=false;const mature=g.day+3*360;while(g.day<mature)g.stepTick();
      const net=line.incomeLast-line.costLast-g.maintenanceOf(ai.companyId)-ai.eco.loan*ai.eco.interestRate;
      console.log('native starter accounts',JSON.stringify({town:T.name,income:line.incomeLast,cost:line.costLast,
        upkeep:g.maintenanceOf(ai.companyId),loan:ai.eco.loan,interest:ai.eco.loan*ai.eco.interestRate,net}));
      check(net>0,T.name+' mature actual receipts pay operating costs, native upkeep and interest');
    }
  }
}
if(isScenario('natural')) {
  const g=Game.create({size:512,seed:7,towns:Math.round(512/38),hilliness:'hilly',water:'medium',startYear:1980,aiCompanies:1});
  g.aiEnabled=false;g.vehicles.ambientEnabled=false;
  const candidates=g.towns.list.flatMap(t=>urbanTrunks(g,t,26,5).map(c=>({seed:t.id,...c}))),two=candidates.filter(c=>c.towns.length===2);
  console.log('native generated corridors',JSON.stringify({seed:7,size:512,towns:g.towns.list.length,alternatives:candidates.length,twoCentres:two.length,sample:candidates.slice(0,5)}));
  check(candidates.length>0&&two.length>0,'an ordinary generated map offers populated two-centre corridor alternatives');
  const selected=candidates.slice(0,3);
  for(const c of selected) {
    const survey=access(g.ais[0]).urbanStep(g.towns.list[c.seed],'lightrail');let r=survey.next();while(!r.done)r=survey.next();
    console.log('native quote',JSON.stringify({town:c.seed,geometry:c.towns,selected:r.value.towns??[c.seed],targets:r.value.targets,capital:r.value.quote?.total,net:r.value.quote?.net}));
  }
}
console.log(fails.length ? fails.length+' FAILURES':'ALL CHECKS PASSED');process.exitCode=fails.length?1:0;
