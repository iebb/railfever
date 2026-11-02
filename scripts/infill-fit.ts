// Controlled native rail and ample fixture funds; forecasts, acceptance, paid works and stock placement stay native.
import '../src/game/patterns';
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { runNetworkTask, networkDaily, networkPlanner, networkProfile } from '../src/game/ai-network';
import { infillCandidate, infillCallsFit, infillPlanFits } from '../src/game/ai-infill-fit';
import { planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { addPattern, setVehiclePattern, patternStops } from '../src/game/patterns';
import { electrify } from '../src/game/build-ops';
import { replaceLineStops } from '../src/game/line-edit';
import { TRACK_TYPES } from '../src/game/constants';
import { station, depotFor } from './stationlib';
import { connectDouble, checkReservations } from './lib';

const saved = (g: Game) => JSON.stringify(serialize(g));
const cars = (mail: boolean) => ['diesel_a', ...(mail ? ['van_steel'] : []), 'coach_steel', 'coach_steel'].map(id => MODEL_BY_ID.get(id)!);
type Kind = 'shared' | 'express' | 'full';
function fixture(kind: Kind) {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1970, aiCompanies: 2 });
  g.aiEnabled = false; g.aiAcquisitions = false; g.vehicles.ambientEnabled = false;
  g.world.h.fill(3); g.world.heightsVersion++;
  for (const tree of [...g.world.trees]) if (tree) g.world.removeTreesNear(tree.x, tree.z, .1);
  for (const c of g.companies) c.economy.money = 200_000_000;
  const a = station(g, 35, 192, Math.PI / 2, 14, 2, 1)!, b = station(g, 345, 192, Math.PI / 2, 14, 2, 1)!;
  assert(a && b); assert(connectDouble(g, a, b, 1, () => {}).ok);
  const depot = depotFor(g, a, b, 1); assert(depot >= 0);
  const lines = [false, true].map((long, i) => {
    const l = g.lines.create('rail', 1); l.stops = [a.id, b.id];
    const t = g.vehicles.buyTrain(depot, cars(long || kind === 'full'), l.id); assert(t instanceof Train, String(t));
    if (i === 0) { const second = g.vehicles.buyTrain(depot, cars(kind === 'full'), l.id); assert(second instanceof Train, String(second)); }
    (g.aiOf(1)! as any).lines.set(l.id, { kind: 'rail', towns: [], depot, maxVehicles: 6, opened: 0, double: true });
    if (kind === 'express' && i === 1) {
      const local = g.vehicles.buyTrain(depot, cars(false), l.id); assert(local instanceof Train, String(local));
      // Distinct native pattern IDs are retained even though their initial two calls coincide.
      const express = addPattern(g, l.id, 'express'); assert(express);
      assert.equal(setVehiclePattern(g, t.id, express.id), null);
    }
    return l;
  });
  // The grown district is genuine uncovered population; the original infill payback test remains native.
  for (let i = 0; i < 8; i++) for (let j = 0; j < 8; j++) g.world.addBuilding({ townId: -1,
    x: 176 + i * 2.5, z: 200 + j * 1.8, angle: 0, w: 1.2, d: 1.1, type: 1, floors: 2, pop: 6, seed: i * 8 + j, y: 3, built: 0 });
  g.lines.rebuild();
  assert(lines.every(l => infillCallsFit(g, l)), 'every original paid consist has legal full-body calls');
  return { g, a, b, lines, long: g.vehicles.get(lines[1].vehicles[0]) as Train,
    trains: lines.flatMap(l => l.vehicles.map(id => g.vehicles.get(id) as Train)) };
}

let checkpoints = 0, ticks = 0;
for (const kind of ['shared', 'express', 'full'] as Kind[]) {
  const { g, a, b, lines, trains, long } = fixture(kind), ai = g.aiOf(1)!;
  const cash = g.company(1).economy.money, oldConsists = trains.map(t => [t.id, t.cars.map(m => m.id)]);
  assert(runNetworkTask(ai, 'insert', 1));
  assert.equal(networkPlanner(ai)?.task, 'insert', 'a real pending inventory crosses a cold save');
  const before = saved(g), clone = deserialize(JSON.parse(before)); assert.equal(saved(clone), before);
  networkDaily(ai); networkDaily(clone.aiOf(1)!); assert.equal(saved(g), saved(clone), `${kind}: paid work unit cold replay`); checkpoints++;
  assert(!networkPlanner(ai)?.task, `${kind}: bounded native item completes (${ai.log.slice(-3).join('; ')}; ${JSON.stringify(networkProfile.decisions)})`);
  const infill = [...g.stations.map.values()].find(st => st.id !== a.id && st.id !== b.id && !!st.rail);
  assert(infill?.rail, `${kind}: native population and cost gates build the station`);
  assert(g.company(1).economy.money < cash, `${kind}: construction actually paid`);
  assert.deepEqual(trains.map(t => [t.id, t.cars.map(m => m.id)]), oldConsists, 'mail vans and every paid original consist remain complete');
  const served = (t: Train) => patternStops(g.lines.get(t.lineId)!, t.pattern).map(i => g.lines.get(t.lineId)!.stops[i]);
  assert(served(trains[0]).includes(infill.id), 'the target gets a legal paid call');
  assert.equal(served(long).includes(infill.id), kind === 'full', `${kind}: no undersized collateral call; long express legally passes`);
  assert([...g.lines.map.values()].filter(l => l.kind === 'rail').every(l => infillCallsFit(g, l)), 'every actual owner/pattern retains full native arrival and onward cells');
  const operating = deserialize(JSON.parse(saved(g)));
  for (let i = 0; i < 128; i++) { g.stepTick(); operating.stepTick(); assert.equal(saved(g), saved(operating), `${kind}: operating replay ${i}`); }
  const calls = new Map(trains.map(t => [t.id, new Set<number>()]));
  for (let i = 0; i < 20000 && trains.some(t => !served(t).every(id => calls.get(t.id)!.has(id))); i++) {
    g.stepTick(); ticks++;
    for (const t of trains) if (t.state === 'loading') calls.get(t.id)!.add(t.atStation);
  }
  assert(trains.every(t => served(t).every(id => calls.get(t.id)!.has(id))), `${kind}: actual complete trains serve every admitted call`);
  assert(!calls.get(long.id)!.has(infill.id) || kind === 'full');
  assert.equal(checkReservations(g).length, 0);
  const broken = deserialize(JSON.parse(saved(g))), bst = broken.stations.get(infill.id)!;
  for (const group of broken.stations.railTrackGroups(bst)) broken.world.net.removeEdge(group.steps[0].edge);
  broken.onNetworkChanged();
  assert([...broken.lines.map.values()].some(l => !infillCallsFit(broken, l)), 'broken physical cells are rejected, never summed as a full platform');
  console.log(`PASS ${kind}: paid native infill, preserved mail/full consists, actual calls and legal pass-through`);
}

{
  const { g, a, b, lines } = fixture('shared');
  const edge = g.world.net.nearestEdge(190, 192, 3, 'rail', e => e.station < 0 && e.depot < 0)!; assert(edge);
  const plan = planStationOnTrack(g, edge.edge.id, edge.s, { length: 8, tracks: 2, reuseTrack: true, style: 'none' }, 2);
  assert(plan.ok && plan.native, plan.error);
  const id = g.stations.nextId, short = infillCandidate(lines[0], a.id, b.id, id)!, long = infillCandidate(lines[1], a.id, b.id, id)!;
  const before = saved(g);
  assert(infillPlanFits(g, plan, short, id), 'native proposed interval admits the short full consist');
  assert(!infillPlanFits(g, plan, long, id), 'mail van body makes the longer paid train fail before spending');
  assert.equal(saved(g), before, 'proposal admission leaves the game and both original pattern arrays unchanged');
  g.blockCompany(2, 1);
  assert(!infillPlanFits(g, plan, short, id), 'actual train owner cannot gain a call on a denied facility');
  assert.equal(g.stations.nextId, id, 'unsafe and denied preflight creates no station');
}
{
  const { g, a, b, lines } = fixture('shared');
  const result = electrify(g, [...g.world.net.edges.values()].filter(e => e.kind === 'rail').map(e => e.id), 1);
  assert(!result.error && result.changed > 0, result.error ?? 'native wire upgrade');
  const depot = [...g.depots.map.values()].find(d => d.owner === 1 && d.kind === 'rail')!;
  const emu = g.vehicles.buyTrain(depot.id, [MODEL_BY_ID.get('metro_a')!], lines[0].id); assert(emu instanceof Train, String(emu));
  const edge = g.world.net.nearestEdge(190, 192, 3, 'rail', e => e.station < 0 && e.depot < 0)!; assert(edge);
  const plan = planStationOnTrack(g, edge.edge.id, edge.s, { length: 12, tracks: 2, through: 2, style: 'none' }, 1);
  assert(plan.ok && plan.station && !plan.native, plan.error ?? 'genuine widened station proposal');
  const candidate = infillCandidate(lines[0], a.id, b.id, g.stations.nextId)!;
  assert(infillPlanFits(g, plan, candidate, g.stations.nextId), 'widened mainline platforms inherit real wire and admit EMU');
  const unwired = { ...plan, station: { ...plan.station, trackType: 'standard' } };
  assert(!infillPlanFits(g, unwired, candidate, g.stations.nextId), 'a proposal losing overhead wire rejects the actual electric consist');
  const built = commitStationOnTrack(g, plan); assert.equal(built.error, null); assert(built.station >= 0);
  assert(g.stations.get(built.station)!.rail!.edges.every(id => TRACK_TYPES[g.world.net.edges.get(id)!.type]?.electrified));
  assert(infillCallsFit(g, candidate), 'accepted widened proposal has complete native built arrival and onward platforms');
  replaceLineStops(g, lines[0], candidate.stops);
  const calls = new Set<number>();
  for (let i = 0; i < 20000 && calls.size < 3; i++) { g.stepTick(); ticks++; if (emu.state === 'loading') calls.add(emu.atStation); }
  assert([a.id, built.station, b.id].every(id => calls.has(id)), 'actual EMU serves all widened wired calls');
  assert.equal(checkReservations(g).length, 0);
  console.log('PASS widened wire: native electric stock, real paid widening, full-body onward proof and actual calls');
}
assert(checkpoints === 3);
console.log(`PASS infill full fit: ${checkpoints} cold pending-work replays, ${ticks} native operating ticks; complete consists, express pass, physical cells and rights`);
