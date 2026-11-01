// Controlled discovery/stock/replay contracts; unforced network emergence is checked separately.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { Train } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { networkDaily, networkPlanner, networkItem, runNetworkTask } from '../src/game/ai-network';
import { throughRouteProof, throughCandidates, throughMiddleLines, type ThroughHost } from '../src/game/ai-through';
import { railPartMode } from '../src/game/stations';
import { patternStops } from '../src/game/patterns';
import { electrify } from '../src/game/build-ops';
import { station, depotFor } from './stationlib';
import { connectDouble, checkReservations } from './lib';

const model = (id: string) => MODEL_BY_ID.get(id)!;
const saved = (g: Game) => JSON.stringify(serialize(g));
{
  // Pure candidate ordering, independent of construction or economic admission.
  const stations = new Map([0, 1, 2, 3].map(id => [id, { id, x: id * 40, z: 0, rail: { mode: id === 3 ? 'metro' : 'mainline' } }]));
  const lines = [
    { id: 1, owner: 1, kind: 'rail', stops: [0, 1], vehicles: [101] },
    { id: 2, owner: 2, kind: 'rail', stops: [1, 2], vehicles: [] },
    { id: 3, owner: 1, kind: 'rail', stops: [2, 3], vehicles: [103] },
  ];
  const host = { me: 1, cared: () => false, selectSides: (_: number, ids: number[]) => ids,
    g: { stations, lines: { all: () => lines }, vehicles: { get: () => ({ owner: 1 }) }, canUse: () => true } } as unknown as ThroughHost;
  assert.deepEqual(throughCandidates(host, [2]), [[3, 2], [1, 2, 3], [1, 2]],
    'existing urban pairs and complete chains retain priority over new mainline pairs');
}
type Kind = 'plain' | 'mail' | 'variants' | 'unpaid' | 'denied' | 'short' | 'mailOnly';
function fixture(kind: Kind) {
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: 2 });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.aiAcquisitions = false;
  g.world.h.fill(4); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  const sts = [40, 180, 320].map((x, i) => station(g, x, 192, Math.PI / 2, kind === 'short' && i === 2 ? 6 : 12, 2, i ? 2 : 1)!);
  assert(sts.every(Boolean));
  for (let i = 0; i < 2; i++) assert(connectDouble(g, sts[i], sts[i + 1], i ? 2 : 1, () => {}).ok);
  const depots = [depotFor(g, sts[0], sts[1], 1), depotFor(g, sts[2], sts[1], 2)];
  assert(depots.every(id => id >= 0));
  const lines = [1, 2].map((owner, i) => {
    const l = g.lines.create('rail', owner); l.stops = [sts[i].id, sts[i + 1].id];
    const own = ['diesel_b', ...(kind === 'mailOnly' ? [] : ['coach_ic']), ...(kind === 'short' ? ['coach_ic', 'coach_ic'] : []), ...(kind === 'mail' || kind === 'mailOnly' ? ['van_ic'] : [])];
    const t = g.vehicles.buyTrain(depots[i], (i ? ['diesel_b', 'coach_ic'] : own).map(model), l.id);
    assert(t instanceof Train, String(t));
    (g.aiOf(owner)! as any).lines.set(l.id, { kind: 'rail', towns: [], depot: depots[i], maxVehicles: 6, opened: 0, double: true });
    return l;
  });
  if (kind === 'variants') {
    const edges = [...g.world.net.edges.values()].filter(e => e.kind === 'rail' && (e.owner === 1 || e.station === sts[1].id)).map(e => e.id);
    const result = electrify(g, edges, 1); assert(!result.error, result.error ?? undefined);
    const t = g.vehicles.buyTrain(depots[0], [model('metro_a')], lines[0].id); assert(t instanceof Train, String(t));
    assert(model('metro_a').cost < model('diesel_b').cost + model('coach_ic').cost, 'incompatible electric option really is cheaper');
    assert(!throughRouteProof(g, sts.map(s => s.id), 1, t.cars), 'unwired foreign leg genuinely rejects the cheapest consist');
  }
  g.lines.rebuild();
  if (kind === 'denied') g.setAccessPolicy(2, 'auto-reject');
  return { g, sts, lines, depots };
}
function receipts(g: Game, positive: boolean) {
  // This deliberately controlled market isolates discovery, native paid stock and safe operations.
  // No forceBuild, capacity bypass, physical placement or construction refund is used.
  g.demand.forecastLine = ((sites: unknown[]) => ({ revenue: positive && sites.length === 3 ? 1e8 : 0,
    boardings: positive ? 10000 : 0, covered: 10000, transfers: 0, legLoads: Array(2 * (sites.length - 1)).fill(10) })) as any;
}
let checkpoints = 0, cursorChecks = 0, operatingTicks = 0;
for (const kind of ['plain', 'mail', 'variants', 'unpaid', 'denied', 'short', 'mailOnly'] as Kind[]) {
  const { g, sts, lines } = fixture(kind), own = [...lines[0].vehicles], foreign = [...lines[1].vehicles];
  const oldCars = own.map(id => (g.vehicles.get(id) as Train).cars.map(m => m.id));
  assert(sts.every(s => railPartMode(s.rail!) === 'mainline'));
  const host = { g, me: 1, ai: g.aiOf(1)!, cared: () => false, selectSides: (_: number, ids: number[]) => ids } as unknown as ThroughHost;
  const candidates = throughCandidates(host, throughMiddleLines(host));
  assert(kind === 'denied' ? !candidates.length : candidates.some(ids => ids.length === 2 && ids[0] === lines[0].id && ids[1] === lines[1].id), `${kind}: native mainline pair eligibility`);
  receipts(g, kind !== 'unpaid'); const cash = g.company(1).economy.money;
  assert(runNetworkTask(g.aiOf(1)!, 'through', 1));
  for (let unit = 0; networkPlanner(g.aiOf(1)!)?.task && unit < 64; unit++) {
    const bytes = saved(g), clone = deserialize(JSON.parse(bytes)); receipts(clone, kind !== 'unpaid');
    assert.equal(saved(clone), bytes, `${kind}: cold pending save`);
    const cursor = (networkItem(g.aiOf(1)!) as any)?.through;
    if (cursor?.stock) { assert.equal((networkItem(clone.aiOf(1)!) as any)?.through.stock, cursor.stock); cursorChecks++; }
    networkDaily(g.aiOf(1)!); networkDaily(clone.aiOf(1)!);
    assert.equal(saved(g), saved(clone), `${kind}: complete work unit ${unit} replays exactly`); checkpoints++;
  }
  assert(!networkPlanner(g.aiOf(1)!)?.task, `${kind}: bounded review finishes`);
  const through = g.lines.all().find(l => l.owner === 1 && new Set(l.stops).size === 3);
  const shouldOpen = ['plain', 'mail', 'variants'].includes(kind);
  assert.equal(!!through, shouldOpen, `${kind}: exact paid admission outcome`);
  assert.equal(g.lines.get(lines[1].id), lines[1]); assert.deepEqual(lines[1].vehicles, foreign, 'foreign timetable and paid stock unchanged');
  assert.deepEqual(own.map(id => (g.vehicles.get(id) as Train).cars.map(m => m.id)), oldCars, 'all original local consists and mail vans remain');
  if (!through) { assert.equal(g.company(1).economy.money, cash, `${kind}: rejected investment pays nothing`); continue; }
  const t = through.vehicles.map(id => g.vehicles.get(id)).find(v => v instanceof Train && !own.includes(v.id)) as Train;
  assert(t && t.mailCapacity === 0 && t.cars.every(m => m.traction !== 'electric'), `${kind}: paid compatible passenger stock`);
  assert.equal(cash - g.company(1).economy.money, t.cars.reduce((n, m) => n + m.cost, 0), 'ordinary purchase pays the complete catalogue price');
  assert(own.every(id => new Set(patternStops(through, g.vehicles.get(id)!.pattern).map(i => through.stops[i])).size === 2), 'original local service remains a short-turn pattern');
  assert(throughRouteProof(g, sts.map(s => s.id), 1, t.cars));
  const clone = deserialize(JSON.parse(saved(g))); receipts(clone, true);
  for (let tick = 0; tick < 128; tick++) { g.stepTick(); clone.stepTick(); assert.equal(saved(g), saved(clone), `${kind}: operating replay ${tick}`); }
  const calls = new Set<number>();
  for (let tick = 0; tick < 24000 && calls.size < sts.length; tick++) { g.stepTick(); if (t.state === 'loading') calls.add(t.atStation); operatingTicks++; }
  assert(sts.every(s => calls.has(s.id)), `${kind}: native train actually serves all mainline calls`);
  assert.equal(checkReservations(g).length, 0);
  console.log(`PASS ${kind}: paid all-mainline through service, preserved locals, ${calls.size} actual calls`);
}
assert(cursorChecks > 0, 'an unfinished alternative-consist cursor genuinely crosses a cold save boundary');
console.log(`PASS through discovery: ${checkpoints} cold work checkpoints, ${cursorChecks} alternative-consist checkpoints, ${operatingTicks} native operating ticks; unpaid/access/full-fit/mail-only controls`);
