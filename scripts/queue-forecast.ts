// Finite shared physical queues with native directed eligibility and unchanged paid stock.
import assert from 'node:assert/strict';
import {queueCapture,nativeQueueTimetable,nativeQueueFootprint,directedMasks,type NativeQueueTimetable} from '../src/game/queue-forecast';
import {deserialize,serialize} from '../src/game/save';
import {plannedSet} from '../src/game/demand';
import {lineRoute,patternHeadways} from '../src/game/patterns';
import { flat, newTown, district, cityLine, mainCityLine, runDays, M } from './linegrow-fixtures';
import { Train } from '../src/game/train';
import { YEAR_S } from '../src/game/opcosts';
import { marginalTrainInvestment } from '../src/game/ai-capacity';
import { planEdge, commitProposal } from '../src/game/construction';
import type { Game } from '../src/game/game';
import {setPatterns} from '../src/game/patterns';
let checks=0;
const check=(ok:unknown,label:string)=>{assert(ok,label);checks++;};
function context(H:number,delta:number,one=false):NativeQueueTimetable{return{line:1,pattern:0,path:[1,2,3],baseCycle:H,fleet:1,effectiveCycle:H,headway:H,kmh:48,key:'synthetic-explicit',calls:one?[{station:2,offset:0,alights:[1,3]}]:[{station:2,offset:0,alights:[1]},{station:2,offset:delta,alights:[3]}]};}
const nativeCalls=[{station:1,offset:0,alights:[2,3]},{station:2,offset:1,alights:[3]},{station:3,offset:2,alights:[1,2]},{station:2,offset:3,alights:[1]}];
check(directedMasks([1,2,3,2],2,nativeCalls),'native directed call masks partition every destination and end before each terminus');
check(!directedMasks([1,2,3,2],2,nativeCalls.map((c,i)=>i===1?{...c,alights:[1,3]}:c)),'a cohort allowed across a terminus invalidates support even with zero forecast demand');
check(!directedMasks([1,2,3,2],2,nativeCalls.map((c,i)=>i===1?{...c,alights:[]}:c)),'missing physical eligibility invalidates the whole layout independent of positive OD rates');
const captures=(H:number,delta:number,C:number,annual:number[],periods=16)=>queueCapture(context(H,delta),2,[1,3],annual,C,periods)!;
check(JSON.stringify(captures(10,5,10,[1,2]))==='[1,2]','sparse OD counts are literally unchanged');
check(JSON.stringify(captures(10,5,10,[468,468]))==='[468,468]','separated no-overflow calls carry936/year, so blanket720/year halving is wrong');
check(Math.abs(captures(10,0,10,[100000,100000]).reduce((a,b)=>a+b)-720)<1e-8,'coincident opposite calls share one physical queue');
check(Math.abs(captures(10,5,10,[100000,0])[0]-720)<1e-8,'empty wrong-direction calls cannot double a one-direction queue');
for(const C of [0,1,12,50,300])for(const H of [1,10,100])for(const amount of [0,.001,10,100000]){
  const value=queueCapture(context(H,0,true),2,[1,3],[amount,amount/2],C)!;
  const expected=Math.min(amount*1.5,C*YEAR_S/H);
  check(Math.abs(value[0]+value[1]-expected)<1e-9,'endpoint or one-way loop equals the native single-call finite queue');
}
let corpus=0,maxDelta=0,annualBound=0;
const begin=performance.now();
for(const C of [1,12,50,300])for(const H of [1,2,47.44322515674995,3600])for(const phase of [0,.000001,.01,.125,.25,.499,.75,.999999])
for(const load of [.0001,.1,.5,1,1.5,2,8,100])for(const p of [0,.001,.1,.5,.9,.999,1]){
  const annual=load*C/H*YEAR_S,amounts=[annual*p,annual*(1-p)];
  const bounded=captures(H,H*phase,C,amounts),reference=captures(H,H*phase,C,amounts,64);
  const error=Math.max(...bounded.map((v,i)=>Math.abs(v-reference[i]))),bound=2*C/4**16/H*YEAR_S;
  check(error<=bound+1e-8,'16-period estimate respects its analytic annual error bound');
  check(bounded.every((n,i)=>n>=0&&n<=amounts[i]+1e-8),'cohort capture never creates demand');
  maxDelta=Math.max(maxDelta,error);annualBound=Math.max(annualBound,bound);corpus++;
}
const corpusMs=performance.now()-begin;
check(queueCapture(undefined,2,[1],[1],10)===null,'missing explicit timetable retains fallback');
check(queueCapture({...context(10,5),calls:[{station:2,offset:0,alights:[1]},{station:2,offset:5,alights:[1]}]},2,[1],[100],10)===null,'overlapping eligibility is outside the proved two-disjoint-class solver');


const { g, me } = flat(), town = newTown(g, 'Queue proof', 208, 256);
district(g, town, 150, 270, 256, 64, 1000);
const { line, sts, depot } = cityLine(g, me, [158, 208, 258], 256, 'west', 'tail', 1);
// Real apartment doors on the paid facilities' native access roads. No catch-pop override or synthetic waits.
for (const id of [...town.buildings]) g.world.removeBuilding(id);
town.buildings.clear(); town.pop = 0;
for (const st of sts) {
  const fc = g.stations.forecourt(st)!, near = g.world.net.nearestEdge(fc.x, fc.z, 3, 'road')!;
  const at = { x: 0, y: 0, z: 0 }; g.world.net.pointAt(near.edge, near.s, at);
  for (const dx of [-.8, 0, .8]) for (const dz of [1.1, 1.9, 2.7]) {
    const b = g.world.addBuilding({ townId: town.id, x: at.x + dx, z: at.z + dz, angle: 0,
      w: .6, d: .6, type: 4, floors: 8, pop: 40, seed: 10000 + town.buildings.size, y: 4, built: 0 });
    town.buildings.add(b.id); town.pop += 40;
  }
}
g.demand.rebuild(); g.stations.recomputeCatchment(); g.demand.recomputeShares();
g.flushNetworkChanges(); g.lines.flushCatchment();
const saved = (world: Game) => JSON.stringify(serialize(world)), cold = (world: Game) => deserialize(JSON.parse(saved(world)));
const p = patternHeadways(g, line)[0], H = p.headway, kmh = 48, t = nativeQueueTimetable(g, line, 1, H)!;
check(sts.every(st => st.catchPop > 0) && !!t, 'paid isolated three-stop service has real walking demand and native timetable');
check(t.footprints!.reduce((a, b) => a + b, 0) === 186 && t.seats === 240,
  'all origin queues fit together in the unchanged native consist');
const forecast = (world = g, context: NativeQueueTimetable | undefined = t, points = sts, excluded: number | undefined = line.id, pattern?: number) =>
  world.demand.forecastLine(points, 'lightrail', kmh, H, me, excluded, pattern, 'rail', { ...plannedSet(world, points), queueTimetable: context });
const original = (world = g, points = sts, excluded: number | undefined = line.id, pattern?: number) =>
  world.demand.forecastLine(points, 'lightrail', kmh, H, me, excluded, pattern, 'rail', plannedSet(world, points));
const before = saved(g), q = forecast(), control = original();
check(q.boardings > 0 && q.boardings <= control.boardings, 'physical native quote retains real demand without creating riders');
const sparseH = YEAR_S * 10, sparseContext = nativeQueueTimetable(g, line, 1, sparseH)!;
const sparse = g.demand.forecastLine(sts, 'lightrail', kmh, sparseH, me, line.id, undefined, 'rail',
  { ...plannedSet(g, sts), queueTimetable: sparseContext });
const sparseOld = g.demand.forecastLine(sts, 'lightrail', kmh, sparseH, me, line.id, undefined, 'rail', plannedSet(g, sts));
// Native queues are62 each. Widely separated saturated directional calls share the interior queue,
// giving three queues per7200s, rather than counting the entire middle queue twice.
const saturatedDirectional = sparseContext.footprints!.reduce((a, b) => a + b, 0) * YEAR_S / sparseH;
check(Math.abs(sparse.boardings - saturatedDirectional) < 1e-6, 'binding native full forecast has the expected18.6 directional riders/year');
check(!!sparseContext && sparse.boardings < sparseOld.boardings, 'a supported binding physical queue strictly reduces the real full forecast');
const loaded = cold(g), loadedLine = loaded.lines.get(line.id)!, loadedSites = sts.map(st => loaded.stations.get(st.id)!);
const loadedContext = nativeQueueTimetable(loaded, loadedLine, 1, H)!;
check(JSON.stringify(forecast(loaded, loadedContext, loadedSites)) === JSON.stringify(q), 'native quote is warm/cold exact');
const mutable = nativeQueueTimetable(g, line, 1, H)!;
(mutable.path as number[])[0] = -999; (mutable.calls[0].alights as number[]).splice(0); mutable.calls[0].offset = 9;
check(JSON.stringify(nativeQueueTimetable(g, line, 1, H)) === JSON.stringify(t), 'returned paths, calls and alights cannot poison cached native layout');
const alteredCalls = { ...t, calls: t.calls.map(c => ({ ...c, alights: [] })) };
check(JSON.stringify(forecast(g, alteredCalls)) === JSON.stringify(q), 'accepted context uses revalidated native calls instead of mutable caller arrays');
const clones = sts.map(st => ({ ...st, x: st.x + .125 }));
check(JSON.stringify(forecast(g, t, clones)) === JSON.stringify(original(g, clones)), 'planned clones bearing native IDs retain literal fallback');
const aliases = [sts[0], sts[1], sts[1], sts[2]];
check(JSON.stringify(forecast(g, t, aliases)) === JSON.stringify(original(g, aliases)), 'duplicate physical identities retain literal fallback');
check(JSON.stringify(forecast(g, t, sts, line.id, 0)) === JSON.stringify(original(g, sts, line.id, 0)), 'partial pattern quote retains literal fallback');
check(JSON.stringify(g.demand.forecastLine(sts, 'lightrail', kmh, H, me, undefined, undefined, 'rail', { queueTimetable: t }))
  === JSON.stringify(g.demand.forecastLine(sts, 'lightrail', kmh, H, me)), 'missing excluded line cannot adopt another service timetable');
check(saved(g) === before, 'all pure forecast reads preserve every saved field');
// A real paid unrelated road edit leaves access refresh cold when the context is constructed.
const edited = cold(g), editLine = edited.lines.get(line.id)!;
const road = planEdge(edited, { kind: 'free', x: 20, y: 4, z: 20 }, { kind: 'free', x: 30, y: 4, z: 20 },
  { kind: 'road', type: 'street', tracks: 1, heightOffset: 0, crossing: 'auto', owner: me });
check(road.ok && !commitProposal(edited, road), 'native unrelated road edit pays and commits before cold walking refresh');
const editContext = nativeQueueTimetable(edited, editLine, 1, H)!, editSites = sts.map(st => edited.stations.get(st.id)!);
const editCold = cold(edited), editVersion = edited.stations.walkVersion;
const editQuote = forecast(edited, editContext, editSites);
check(edited.stations.walkVersion > editVersion, 'forecast still performs mandatory native walking/access refresh after context construction');
check(JSON.stringify(editQuote) === JSON.stringify(forecast(editCold,
  nativeQueueTimetable(editCold, editCold.lines.get(line.id)!, 1, H), sts.map(st => editCold.stations.get(st.id)!))),
  'edited-world first use and cold native context have exact forecasts despite disposable walking epochs');
check(nativeQueueTimetable(edited, editLine, 1, H)!.key === editContext.key, 'walking warmup changes private epoch without changing semantic context');
const small = cold(g), smallLine = small.lines.get(line.id)!, smallStock = small.vehicles.get(line.vehicles[0]) as Train;
marginalTrainInvestment(small, smallLine, me, smallStock.madeUp);
check(!small.vehicles.recompose(smallStock, [M('lrv_a')]), 'lower-seat negative control pays native consist replacement');
check(!nativeQueueTimetable(small, smallLine, 1, H), '186 physical queue places do not prove full clearing in160 seats');
check(JSON.stringify(forecast(small, t, sts.map(st => small.stations.get(st.id)!)))
  === JSON.stringify(original(small, sts.map(st => small.stations.get(st.id)!))), 'stale context after paid stock edit falls back exactly');
const smallQuote = marginalTrainInvestment(small, smallLine, me, smallStock.madeUp), smallCold = cold(small);
check(JSON.stringify(smallQuote) === JSON.stringify(marginalTrainInvestment(smallCold, smallCold.lines.get(line.id)!, me, (smallCold.vehicles.get(smallStock.id) as Train).madeUp)),
  'paid consist edit invalidates full memo and agrees with cold marginal quote');
const loop = cold(g); loop.lines.setLoop(line.id, true);
check(!nativeQueueTimetable(loop, loop.lines.get(line.id)!, 1, H), 'native loop edit invalidates cached support');
const partial = cold(g), partialLine = partial.lines.get(line.id)!;
setPatterns(partial, line.id, [{ id: 0, name: 'Short', kind: 'local', stops: partialLine.stops.map((_, i) => i !== 2), ids: [...partialLine.stops] }]);
check(!nativeQueueTimetable(partial, partialLine, 1, H), 'native partial pattern cannot use full-route masks');
const shared = cold(g), sharedLine = shared.lines.get(line.id)!;
check(!!nativeQueueTimetable(shared, sharedLine, 1, H), 'shared-service control warms supported layout');
marginalTrainInvestment(shared, sharedLine, me, [M('lrv_b')]);
const other = shared.lines.create('rail', me); other.stops = [...line.stops];
check(shared.vehicles.buyTrain(depot, [M('lrv_b')], other.id) instanceof Train, 'competing service purchases lawful native stock');
check(!nativeQueueTimetable(shared, sharedLine, 1, H), 'competing fleet activation invalidates previously supported isolated layout');
const sharedQuote = marginalTrainInvestment(shared, sharedLine, me, [M('lrv_b')]), sharedCold = cold(shared);
check(JSON.stringify(sharedQuote) === JSON.stringify(marginalTrainInvestment(sharedCold, sharedCold.lines.get(line.id)!, me, [M('lrv_b')])),
  'active competitor invalidates full native memo and preserves cold marginal agreement');
// Real paid mixed MUs are legal, but native full reversal can change their leading nose resistance.
const mixed = cold(g), mixedLine = mixed.lines.get(line.id)!, mixedFirst = mixed.vehicles.get(line.vehicles[0]) as Train;
const mixedCars = [M('lrv_a'), M('lrv_b')];
check(!mixed.vehicles.recompose(mixedFirst, mixedCars), 'mixed-MU control pays its native legal consist replacement');
const mixedSecond = mixed.vehicles.buyTrain(depot, mixedCars, line.id);
check(mixedSecond instanceof Train, 'mixed-MU control pays a second real native departure');
const mixedH = patternHeadways(mixed, mixedLine)[0].headway;
check(!nativeQueueTimetable(mixed, mixedLine, 2, mixedH), 'heterogeneous MUs fall back before movement, independently of matching order');
const limit = mixed.day + 300;
while (mixed.day < limit && mixedFirst.cars[0].id === 'lrv_a') mixed.stepTick();
check(mixedFirst.cars[0].id === 'lrv_b' && mixedSecond.cars[0].id === 'lrv_a',
  'native terminal operation actually reverses one mixed MU while its identical partner faces the other way');
check(!nativeQueueTimetable(mixed, mixedLine, 2, mixedH, mixedCars)
  && !nativeQueueTimetable(mixed, mixedLine, 2, mixedH, [...mixedCars].reverse()),
  'both physical mixed-MU orientations consistently retain unsupported fallback');
const mixedSites = sts.map(st => mixed.stations.get(st.id)!);
check(JSON.stringify(mixed.demand.forecastLine(mixedSites, 'lightrail', kmh, mixedH, me, line.id, undefined, 'rail',
  { ...plannedSet(mixed, mixedSites), queueTimetable: nativeQueueTimetable(mixed, mixedLine, 2, mixedH) }))
  === JSON.stringify(mixed.demand.forecastLine(mixedSites, 'lightrail', kmh, mixedH, me, line.id, undefined, 'rail', plannedSet(mixed, mixedSites))),
  'actual opposing mixed-MU orientations preserve the literal original full forecast');
const mixedBid = marginalTrainInvestment(mixed, mixedLine, me, mixedCars), reversedBid = marginalTrainInvestment(mixed, mixedLine, me, [...mixedCars].reverse());
check(JSON.stringify(mixedBid) === JSON.stringify(reversedBid), 'candidate orientation cannot toggle mixed-MU queue correction or its full marginal value');
const mixedCold = cold(mixed), mixedColdLine = mixedCold.lines.get(line.id)!;
check(!nativeQueueTimetable(mixedCold, mixedColdLine, 2, mixedH)
  && JSON.stringify(marginalTrainInvestment(mixedCold, mixedColdLine, me, mixedCars)) === JSON.stringify(mixedBid),
  'native mixed-MU reversal and fallback preserve cold-cache candidate decisions');
const ended = flat(), endedTown = newTown(ended.g, 'Double-ended proof', 208, 256);
district(ended.g, endedTown, 150, 270, 256, 64, 1000);
const endedService = mainCityLine(ended.g, ended.me, [158, 208, 258], 256, 'west', 'tail', 1);
ended.g.flushNetworkChanges(); ended.g.lines.flushCatchment();
const endedTrain = ended.g.vehicles.get(endedService.line.vehicles[0]) as Train;
check(!ended.g.vehicles.recompose(endedTrain, [M('diesel_b'), M('coach_ic'), M('coach_ic'), M('coach_ic')]),
  'ordinary hauled positive control pays for sufficient native seats');
const ordinary = cold(ended.g), ordinaryLine = ordinary.lines.get(endedService.line.id)!, ordinaryTrain = ordinary.vehicles.get(endedTrain.id) as Train;
const ordinaryH = patternHeadways(ordinary, ordinaryLine)[0].headway;
const ordinaryBefore = nativeQueueTimetable(ordinary, ordinaryLine, 1, ordinaryH)!;
check(!!ordinaryBefore, 'locomotives-first with trailing unpowered coaches remains supported');
const ordinaryLimit = ordinary.day + 300;
while (ordinary.day < ordinaryLimit && ordinaryTrain.cars[0].kind === 'loco') ordinary.stepTick();
check(ordinaryTrain.cars[0].kind === 'wagon', 'ordinary hauled stock actually reverses through native terminal operation');
check(nativeQueueTimetable(ordinary, ordinaryLine, 1, ordinaryH)?.key === ordinaryBefore.key,
  'native madeUp keeps ordinary hauled timetable support and semantic identity stable after reversal');
const endedCars = [M('diesel_a'), M('coach_ic'), M('coach_ic'), M('coach_ic'), M('diesel_b')];
check(!ended.g.vehicles.recompose(endedTrain, endedCars), 'double-ended hauled control is legally recomposed and paid natively');
const endedH = patternHeadways(ended.g, endedService.line)[0].headway;
check(endedTrain.capacity >= endedService.sts.reduce((sum, st) => sum + nativeQueueFootprint(ended.g, st.id), 0),
  'double-ended fallback control has sufficient seats, so rejection is not a seat-bound artifact');
check(!nativeQueueTimetable(ended.g, endedService.line, 1, endedH), 'locomotives at both ends consistently fall back before movement');
const endedLimit = ended.g.day + 300;
while (ended.g.day < endedLimit && endedTrain.cars[0].id === 'diesel_a') ended.g.stepTick();
check(endedTrain.cars[0].id === 'diesel_b', 'native terminal operation actually reverses the legal double-ended hauled train');
check(!nativeQueueTimetable(ended.g, endedService.line, 1, endedH, endedCars)
  && !nativeQueueTimetable(ended.g, endedService.line, 1, endedH, [...endedCars].reverse()),
  'both locomotive-ended orientations retain literal fallback without a false timing-invariance claim');
const quote = marginalTrainInvestment(g, line, me, (g.vehicles.get(line.vehicles[0]) as Train).madeUp);
const quoted = saved(g), twin = cold(g), twinLine = twin.lines.get(line.id)!;
check(JSON.stringify(marginalTrainInvestment(twin, twinLine, me, (twin.vehicles.get(line.vehicles[0]) as Train).madeUp)) === JSON.stringify(quote),
  'full marginal quote agrees with discarded caches and saved native monthly observation');
check(saved(g) === quoted && saved(twin) === quoted, 'full marginal re-read and cold quote preserve saved observation');
runDays(g, 180); const mid = cold(g);
check((g.vehicles.get(line.vehicles[0]) as Train).delivered > 0 && line.incomeYear > 0, 'native funded stock actually calls, delivers and earns fares');
for (let tick = 0; tick < 256; tick++) { g.stepTick(); mid.stepTick(); }
runDays(g, 30); runDays(mid, 30);
check(saved(g) === saved(mid), 'mid-operation save and exact cold continuation preserve native queues, fares and planner state');
console.log(`queue-forecast: ${checks} assertions; ${corpus} analytic cases; max error ${maxDelta}; annual bound ${annualBound}; corpus ${corpusMs.toFixed(2)}ms`);
console.log('ALL CHECKS PASSED');
