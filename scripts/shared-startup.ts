// A through timetable must start at the actual depot's lawful call, with the purchased consist.
import { flatGame, station, endNode, nodeSnap, build, railOpts, loco, check, fails } from './stationlib';
import { checkReservations } from './lib';
import { buildDepotOnLine } from '../src/game/routing';
import { Train, depotServes } from '../src/game/train';
import * as AI from '../src/game/ai';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { sharedCapacityPlan } from '../src/game/ai-capacity';
import { addPattern, setVehiclePattern } from '../src/game/patterns';

const firstCall = (g: ReturnType<typeof flatGame>, t: Train, preferred = -1) =>
  (AI as unknown as { openingRailCall?: (g: typeof g, t: Train, preferred?: number) => number }).openingRailCall?.(g, t, preferred) ?? 0;

function fixture(firstLength = 10, otherLength = 10, privateRail = false) {
  const g = flatGame(384), foreign = g.addAICompany({ startMoney: 100_000_000 }).id,
    me = g.addAICompany({ startMoney: 100_000_000 }).id;
  // This bounded operating fixture isolates the paid train; the capacity manager is tested separately.
  g.aiEnabled = false; g.aiAcquisitions = false;
  const trackOwner = privateRail ? me : foreign;
  const A = station(g, 30, 192, Math.PI / 2, firstLength, 2, trackOwner)!,
    B = station(g, 180, 192, Math.PI / 2, otherLength, 2, trackOwner)!, C = station(g, 350, 192, Math.PI / 2, otherLength, 2, me)!;
  build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(trackOwner), 'existing corridor');
  build(g, nodeSnap(g, endNode(g, B, 0, true), 'rail'), nodeSnap(g, endNode(g, C, 0, false), 'rail'), railOpts(me), 'paid extension');
  const edge = g.world.net.nearestEdge(295, 192.49, 2, 'rail', e => e.owner === me && e.station < 0)!;
  const depot = buildDepotOnLine(g, edge.edge.id, edge.s, me, { dir: 1, side: 1 });
  check(depot >= 0, 'native one-direction depot is built and paid');
  const l = g.lines.create('rail', me); l.stops = [A.id, B.id, C.id, B.id]; g.lines.rebuild();
  return { g, foreign, me, A, B, C, l, depot };
}

console.log('Native final-itinerary first call');
const f = fixture(), beforeStock = JSON.stringify(serialize(f.g));
const old = deserialize(JSON.parse(beforeStock)), oldTrain = old.vehicles.buyTrain(f.depot, loco(), f.l.id) as Train;
old.stepTick();
check(oldTrain.state === 'noroute' && !oldTrain.onMap && oldTrain.stopIndex === 0,
  'original reset-to-zero purchase fails before it can enter the network');
const t = f.g.vehicles.buyTrain(f.depot, loco(), f.l.id) as Train;
const provenStation = depotServes(f.g, f.g.depots.get(f.depot)!, f.B.id, f.C.id, t.cars);
check(provenStation === f.C.id, 'native two-site depot proof returns the far opening station');
const state = JSON.stringify(serialize(f.g)), call = firstCall(f.g, t, provenStation);
check(JSON.stringify(serialize(f.g)) === state, 'actual consist/depot/call quote preserves saved state and RNG');
check(call === 2 && f.l.stops[call] === provenStation, 'returned station maps to its actual final timetable occurrence');
t.stopIndex = call;
const visited = new Set<number>(); let noRoute = 0;
for (let tick = 0; tick < 240 * f.g.ticksPerDay; tick++) {
  const target = f.l.stops[(t.stopIndex + 1) % f.l.stops.length];
  for (const sid of new Set(f.l.stops)) {
    const st = f.g.stations.get(sid)!;
    if (sid !== target) f.g.stations.addWaiting(st, f.l.id, target, target, Math.max(0, 12 - st.waitingTotal));
  }
  f.g.stepTick(); noRoute += Number(t.state === 'noroute');
  if (t.state === 'loading') visited.add(t.stopIndex);
}
console.log(`  final calls ${[...visited].sort().join('/')}, delivered ${t.delivered}, NOROUTE ${noRoute}`);
check(noRoute === 0 && [0, 1, 2, 3].every(i => visited.has(i)) && t.delivered > 0,
  'native operation serves both foreign/own calls and both repeated hub occurrences with paid delivery');
const replay = deserialize(JSON.parse(JSON.stringify(serialize(f.g)))); let same = true;
for (let tick = 0; tick < 640; tick++) {
  f.g.stepTick(); replay.stepTick();
  if (JSON.stringify(serialize(f.g)) !== JSON.stringify(serialize(replay))) { same = false; break; }
}
check(same && checkReservations(f.g).length === 0 && checkReservations(replay).length === 0,
  'saved first-call mapping and subsequent service replay exactly for 640 native ticks with lawful reservations');

console.log('Later foreign full-fit boundary');
const short = fixture(5, 12), mail = [...loco(), MODEL_BY_ID.get('van_steel')!], longer = short.g.vehicles.buyTrain(short.depot, mail, short.l.id) as Train;
check(short.C.rail!.length > longer.length && short.B.rail!.length > longer.length && short.A.rail!.length < longer.length,
  'actual mail consist fits the first two calls but exceeds the later foreign platform');
check(firstCall(short.g, longer, short.C.id) === -1, 'final timetable with a later foreign short platform is refused');
const pattern = addPattern(short.g, short.l.id, 'limited', [false, true, true, true])!;
check(setVehiclePattern(short.g, longer.id, pattern.id) === null && firstCall(short.g, longer, short.C.id) === 2,
  'the actual inherited pattern may skip the short foreign call and start at its served depot occurrence');
longer.pattern = 99999;
check(firstCall(short.g, longer, short.C.id) === -1, 'unknown pattern follows the native first-service fallback and retains its full-fit checks');
const manual = fixture(), manualTrain = manual.g.vehicles.buyTrain(manual.depot, loco(), manual.l.id) as Train;
const later = manual.l.platforms!.find(p => p.stop === 0)!;
later.group = -1; later.manual = true;
check(firstCall(manual.g, manualTrain, manual.C.id) === 2, 'an unavailable manual preference retains native fallback to a lawful full-fit group');
manual.g.setAccessPolicy(manual.foreign, 'auto-reject');
check(firstCall(manual.g, manualTrain) === -1, 'startup does not bypass revoked foreign track access');

console.log('Native empty-service restoration');
const restored = fixture(10, 10, true), restoredAI = restored.g.aiOf(restored.me)! as any;
restoredAI.lines.set(restored.l.id, { kind: 'rail', towns: [], depot: restored.depot, maxVehicles: 2, opened: restored.g.day });
restoredAI.manage();
const restoredTrain = restored.g.vehicles.get(restored.l.vehicles[0]) as Train;
check(restoredTrain instanceof Train && restoredTrain.stopIndex === 2,
  'minimum-service restoration buys native stock and maps the final timetable before its first tick');
if (restoredTrain instanceof Train) {
  for (let tick = 0; tick < 240 * restored.g.ticksPerDay; tick++) {
    const target = restored.l.stops[(restoredTrain.stopIndex + 1) % restored.l.stops.length];
    for (const sid of new Set(restored.l.stops)) if (sid !== target) {
      const st = restored.g.stations.get(sid)!;
      restored.g.stations.addWaiting(st, restored.l.id, target, target, Math.max(0, 12 - st.waitingTotal));
    }
    restored.g.stepTick();
  }
  check(restoredTrain.delivered > 0 && restoredTrain.state !== 'noroute' && checkReservations(restored.g).length === 0,
    'restored native service carries paid passengers with lawful reservations');
}

console.log('Saved depot-only purchase repair');
const legacy = fixture(10, 10, true), legacyAI = legacy.g.aiOf(legacy.me)! as any;
legacyAI.lines.set(legacy.l.id, { kind: 'rail', towns: [], depot: legacy.depot, maxVehicles: 2, opened: legacy.g.day });
const stranded = legacy.g.vehicles.buyTrain(legacy.depot, loco(), legacy.l.id) as Train;
legacy.g.stepTick();
check(stranded.state === 'noroute' && !stranded.onMap && !stranded.pending.length, 'native reset-to-zero failure is a saved depot-only train');
const healed = deserialize(JSON.parse(JSON.stringify(serialize(legacy.g)))), healAI = healed.aiOf(legacy.me)! as any,
  healLine = healed.lines.get(legacy.l.id)!, healTrain = healed.vehicles.get(stranded.id) as Train;
check(healAI.startShare(legacy.foreign, legacy.A.id, legacy.C.id), 'an unrelated native job isolates the existing-stock management boundary');
const economyBefore = JSON.stringify(healed.companies[legacy.me].economy), rngBefore = JSON.stringify(healAI.rng.state), fleetBefore = healLine.vehicles.join(',');
healTrain.backoff = { waitFor: [], clear: [] };
healAI.manage();
check(healTrain.stopIndex === 0 && healTrain.state === 'noroute' && !!healTrain.backoff,
  'existing native backoff is not redirected or cleared by depot first-call repair');
healTrain.backoff = null;
healAI.manage();
check(healTrain.stopIndex === 2 && healTrain.state === 'depot' && healLine.vehicles.join(',') === fleetBefore
  && JSON.stringify(healed.companies[legacy.me].economy) === economyBefore && JSON.stringify(healAI.rng.state) === rngBefore,
  'native management repairs only the saved first call without purchase, cash/books or RNG changes');
let legacyNoRoute = 0;
for (let tick = 0; tick < 240 * healed.ticksPerDay; tick++) {
  const target = healLine.stops[(healTrain.stopIndex + 1) % healLine.stops.length];
  for (const sid of new Set(healLine.stops)) if (sid !== target) {
    const st = healed.stations.get(sid)!;
    healed.stations.addWaiting(st, healLine.id, target, target, Math.max(0, 12 - st.waitingTotal));
  }
  healed.stepTick(); legacyNoRoute += Number(healTrain.state === 'noroute');
}
check(healTrain.delivered > 0 && legacyNoRoute === 0 && checkReservations(healed).length === 0,
  'the existing saved train resumes paid service through the final itinerary without a new purchase');

console.log('Actual pattern replacement');
const replacement = fixture(12, 12, true), replaceAI = replacement.g.aiOf(replacement.me)! as any;
const replacementPattern = addPattern(replacement.g, replacement.l.id, 'limited', [false, true, true, true])!;
const replaceOld = replacement.g.vehicles.buyTrain(replacement.depot, loco(), replacement.l.id) as Train;
setVehiclePattern(replacement.g, replaceOld.id, replacementPattern.id); replaceOld.stopIndex = firstCall(replacement.g, replaceOld);
replaceAI.lines.set(replacement.l.id, { kind: 'rail', towns: [], depot: replacement.depot, maxVehicles: 2, opened: replacement.g.day });
for (let tick = 0; tick < 120 * replacement.g.ticksPerDay && replaceOld.state !== 'loading'; tick++) {
  replacement.g.stations.addWaiting(replacement.C, replacement.l.id, replacement.B.id, replacement.B.id,
    Math.max(0, 12 - replacement.C.waitingTotal));
  replacement.g.stepTick();
}
check(replaceOld.state === 'loading' && replaceOld.load > 0, 'replacement boundary is reached with passengers aboard by native platform arrival');
const replaceCars = [...loco(), MODEL_BY_ID.get('coach_ic')!];
const refusedReplacement = deserialize(JSON.parse(JSON.stringify(serialize(replacement.g)))), refusedAI = refusedReplacement.aiOf(replacement.me)! as any;
refusedReplacement.world.net.removeEdge(refusedReplacement.depots.get(replacement.depot)!.edge);
refusedReplacement.onNetworkChanged();
const retainedBefore = JSON.stringify(serialize(refusedReplacement).vehicles.find(v => v.id === replaceOld.id));
refusedAI.relengthen = [[replaceOld.id, replacement.depot, replaceCars.map(c => c.id)]]; refusedAI.replaceTrains();
check(refusedReplacement.vehicles.get(replaceOld.id) instanceof Train
  && JSON.stringify(serialize(refusedReplacement).vehicles.find(v => v.id === replaceOld.id)) === retainedBefore
  && refusedReplacement.lines.get(replacement.l.id)!.vehicles.join(',') === String(replaceOld.id),
  'refused replacement from a removed depot approach retains the existing loaded train, cargo and reservations');
replaceAI.relengthen = [[replaceOld.id, replacement.depot, replaceCars.map(c => c.id)]]; replaceAI.replaceTrains();
const replaceNew = replacement.g.vehicles.get(replacement.l.vehicles[0]) as Train;
check(!replacement.g.vehicles.get(replaceOld.id) && replaceNew instanceof Train && replaceNew.pattern === replacementPattern.id
  && replaceNew.stopIndex === 2 && replaceNew.cars.length === replaceCars.length,
  'native replacement inherits its actual pattern before depot-call proof and selling existing stock');
if (replaceNew instanceof Train) { replacement.g.stepTick(); check(replaceNew.state !== 'noroute', 'replacement leaves toward the proved served call'); }

console.log('Paid extension refusal cleanup');
function extensionBoundary() {
  const p = fixture(10, 10, true), ai = p.g.aiOf(p.me)! as any;
  const edge = p.g.world.net.nearestEdge(105, 192.49, 2, 'rail', e => e.owner === p.me && e.station < 0)!;
  const incumbentDepot = buildDepotOnLine(p.g, edge.edge.id, edge.s, p.me, { dir: 1, side: 1 });
  p.l.stops = [p.A.id, p.B.id]; p.g.lines.rebuild();
  const incumbent = p.g.vehicles.buyTrain(incumbentDepot, loco(), p.l.id) as Train;
  incumbent.stopIndex = firstCall(p.g, incumbent);
  const info = { kind: 'rail', towns: [0, 1], depot: incumbentDepot, maxVehicles: 2, opened: p.g.day };
  ai.lines.set(p.l.id, info);
  // Capture the exact paid-assets/extended-timetable boundary before railJob's final purchase validation.
  check(ai.startShare(p.foreign, p.A.id, p.C.id), 'native generator supplies the cancellable project at the extension boundary');
  ai.project.kind = 'rail'; ai.project.built = true; ai.project.openingLine = p.l.id;
  ai.project.stations = [p.C.id]; ai.project.depots = [p.depot];
  ai.project.edges = [...p.g.world.net.edges.values()].filter(e => e.owner === p.me && e.kind === 'rail'
    && e.station < 0 && e.depot < 0 && Math.min(p.g.world.net.nodes.get(e.a)!.x, p.g.world.net.nodes.get(e.b)!.x) > 185).map(e => e.id);
  p.l.stops = [p.A.id, p.B.id, p.C.id, p.B.id]; p.g.lines.rebuild(); incumbent.onLineChanged();
  return { ...p, ai, incumbent, info };
}
for (const exit of ['refusal', 'cancel', 'load'] as const) {
  const ext = extensionBoundary();
  const invalid = ext.g.vehicles.buyTrain(ext.depot, [...loco(), ...Array(4).fill(MODEL_BY_ID.get('van_steel')!)], ext.l.id) as Train;
  check(firstCall(ext.g, invalid) === -1, `${exit}: actual opening consist refuses the extension timetable`);
  ext.g.vehicles.sell(invalid.id);
  let cleanupGame = ext.g;
  if (exit === 'refusal') ext.ai.abandon(ext.ai.project);
  else if (exit === 'cancel') ext.ai.cancelJob();
  else cleanupGame = deserialize(JSON.parse(JSON.stringify(serialize(ext.g))));
  const line = cleanupGame.lines.get(ext.l.id), kept = cleanupGame.vehicles.get(ext.incumbent.id) as Train;
  check(!cleanupGame.stations.get(ext.C.id) && line?.stops.join(',') === `${ext.A.id},${ext.B.id}`
    && kept instanceof Train && firstCall(cleanupGame, kept) >= 0 && checkReservations(cleanupGame).length === 0,
    `${exit}: native paid-asset cleanup removes the added stop and retains a lawful incumbent fleet/timetable`);
  check((cleanupGame.aiOf(ext.me) as any).lines.get(ext.l.id)?.towns.join(',') === '0,1'
    && (cleanupGame.aiOf(ext.me) as any).lines.get(ext.l.id)?.maxVehicles === 2,
    `${exit}: incumbent town bookkeeping retains its pre-completion service`);
}

console.log('Paid-opening capacity lifecycle');
function paidOpeningFixture() {
  const p = fixture(), ai = p.g.aiOf(p.me)! as any, tr = p.g.vehicles.buyTrain(p.depot, loco(), p.l.id) as Train;
  tr.stopIndex = firstCall(p.g, tr);
  const quote = sharedCapacityPlan(p.g, p.l);
  check(quote.withdraw.some(x => x.train === tr.id), 'the native unserved fixture has an economic withdrawal to exercise');
  // A native project generator and paid assets supply the controlled incomplete-opening premise.
  // This tests the saved relation/manager boundary; no forced bid or protected fleet minimum is introduced.
  check(ai.startShare(p.foreign, p.A.id, p.C.id), 'native project is scheduled for lifecycle checks');
  ai.project.built = true; ai.project.openingLine = p.l.id;
  return { ...p, ai, tr };
}
const opening = paidOpeningFixture(), openingSave = JSON.stringify(serialize(opening.g));
opening.ai.manageSharedCapacity();
check(opening.g.vehicles.get(opening.tr.id) === opening.tr && JSON.stringify(serialize(opening.g)) === openingSave,
  'exact active paid opening defers the native withdrawal without physical, cash, ledger or RNG mutation');
const savedProject = serialize(opening.g).ais.find((a: any) => a.companyId === opening.me)!.state.project;
check(savedProject.openingLine === opening.l.id && savedProject.line === -1,
  'the final timetable relation is saved separately from project cleanup ownership');
const loaded = deserialize(JSON.parse(openingSave)), loadedAI = loaded.aiOf(opening.me)! as any;
check(!loadedAI.busy && loadedAI.project === null && loaded.lines.get(opening.l.id)?.stops.join(',') === opening.l.stops.join(','),
  'legacy load cleanup cancels opening deferral and retains the established timetable');
loadedAI.manageSharedCapacity();
check(!loaded.vehicles.get(opening.tr.id), 'native economic withdrawal resumes immediately after legacy cleanup');
opening.ai.cancelJob();
check(opening.ai.project === null && !opening.ai.busy && opening.g.lines.get(opening.l.id) === opening.l
  && opening.g.vehicles.get(opening.tr.id) === opening.tr, 'cancellation clears only the project relation and preserves incumbent stock/timetable');
opening.ai.manageSharedCapacity();
check(!opening.g.vehicles.get(opening.tr.id), 'native economic withdrawal resumes immediately after cancellation');

const unrelated = paidOpeningFixture(), owned = unrelated.l.stops.slice();
unrelated.ai.project.openingLine = -1;
unrelated.ai.manageSharedCapacity();
check(!unrelated.g.vehicles.get(unrelated.tr.id) && unrelated.l.stops.join(',') === owned.join(','),
  'an unrelated active project does not protect an economic depot withdrawal');
console.log(fails.length ? `${fails.length} CHECKS FAILED` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
