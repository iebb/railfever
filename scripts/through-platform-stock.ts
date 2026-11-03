// Native proposed-stock platform proof, independent of whether an identical paid train already exists.
import assert from 'node:assert/strict';
import { serialize as pack } from 'node:v8';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { Train, consistRule, ruleAllows } from '../src/game/train';
import { outAndBack, type Line } from '../src/game/lines';
import { platformChoicesForStock } from '../src/game/rail-platforms';
import { throughPlatformProof, throughRouteProof } from '../src/game/ai-through';
import { station, depotFor } from './stationlib';
import { connectDouble } from './lib';

const saved = (g: Game) => JSON.stringify(serialize(g));
const model = (id: string) => { const m = MODEL_BY_ID.get(id); assert(m); return m; };
const diesel = [model('diesel_b'), model('coach_ic')], electric = [model('metro_a')];
const body = (cars: VehicleModel[]) => cars.reduce((sum, m) => sum + m.length + .1, 0);
const stockKey = (cars: VehicleModel[]) => cars.map(m => m.id).sort().join(',');
let requests = 0;
interface Fixture { raw: string; path: number[]; depot: number }

function fixture(short: boolean): Fixture {
  // Disclosed initial balances fund real native construction; there is no revenue or guard override.
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995,
    aiConfigs: [{ startMoney: 100_000_000, accessPolicy: 'open' }, { startMoney: 100_000_000, accessPolicy: 'open' }] });
  g.aiEnabled = false; g.vehicles.ambientEnabled = false; g.aiAcquisitions = false;
  g.world.h.fill(4); g.world.heightsVersion++;
  assert.equal(g.ais.length, 2); assert.equal(g.towns.list.length, 0);
  assert.equal(g.company(1).economy.money, 100_000_000); assert.equal(g.company(2).economy.money, 100_000_000);
  const before = g.companies.map(c => ({ money: c.economy.money, loan: c.economy.loan }));
  const sts = [40, 180, 320].map((x, i) => station(g, x, 192, Math.PI / 2, short && i === 1 ? 4 : 12, 2, i ? 2 : 1));
  assert(sts.every(Boolean), 'fixed native stations are paid and physically valid');
  const [a, b, c] = sts.map(s => s!);
  assert(connectDouble(g, a, b, 1, () => {}).ok, 'fixed native A-B double track');
  assert(connectDouble(g, b, c, 2, () => {}).ok, 'fixed native B-C double track');
  const depot = depotFor(g, a, b, 1); assert(depot >= 0, 'native owner depot');
  assert(g.canUse(1, 2), 'foreign native infrastructure is open');
  assert.equal(g.vehicles.trains().length, 0, 'initial proposed stock has no matching paid train');
  assert.equal(g.lines.all().length, 0, 'physical proof inserts no timetable');
  const groups = [a, b, c].map(st => g.stations.railTrackGroups(st));
  assert(groups.every(gs => gs.length >= 2), 'complete native physical two-track groups');
  if (short) assert(groups[1].every(q => q.length + 1e-6 < body(diesel) + .05), 'real intermediate groups cannot fit the diesel body');
  else assert(groups.every(gs => gs.some(q => q.length + 1e-6 >= body(diesel) + .05)), 'real native groups fit the diesel body');
  const rails = [...g.world.net.edges.values()].filter(e => e.kind === 'rail' && e.depot < 0);
  assert(rails.length > 0 && rails.every(e => !ruleAllows(consistRule(electric), e)), 'actual standard nondepot rails have no overhead wire');
  assert(g.company(1).economy.money < before[1].money && g.company(2).economy.money < before[2].money, 'both owners pay native construction capital');
  g.companies.forEach((company, i) => assert.equal(company.economy.loan, before[i].loan, 'no extra fixture borrowing'));
  const raw = saved(g); assert.equal(saved(deserialize(JSON.parse(raw))), raw, 'complete paid fixture cold roundtrip');
  return { raw, path: [a.id, b.id, c.id], depot };
}

function query(g: Game, raw: string, path: number[], cars: VehicleModel[], label: string) {
  const q = <T>(fn: () => T): T => {
    assert(++requests <= 72, 'fixed physical request ceiling72');
    try { return fn(); } finally { assert.equal(saved(g), raw, label + ': native proof preserves full save/RNG/ledger/rights/planner state'); }
  };
  const fits = q(() => throughPlatformProof(g, path, 1, cars));
  // Independent native call witnesses expose the real short group / wire / permission failure.
  const line = { id: -1, owner: 1, kind: 'rail', stops: outAndBack(path), vehicles: [] } as unknown as Line;
  assert.equal(line.stops.length, 4, 'native full pendulum contains both intermediate directional calls');
  assert.equal(g.lines.get(line.id), undefined, 'pure descriptor is never inserted in Game');
  const calls = line.stops.map((station, stop) => ({ station, stop,
    groups: q(() => platformChoicesForStock(g, line, 0, stop, { owner: 1, rule: consistRule(cars), length: body(cars) })) }));
  const route = q(() => throughRouteProof(g, path, 1, cars));
  return { fits, calls, route };
}

assert(Math.abs(body(diesel) - 4.9) < 1e-12); assert(Math.abs(body(electric) - 5.3) < 1e-12);
const short = fixture(true), fit = fixture(false);
const cases = [
  { name: 'short/no paid match', fixture: short, cars: diesel, paid: false, denied: false, fits: false },
  { name: 'fit/no paid match', fixture: fit, cars: diesel, paid: false, denied: false, fits: true },
  { name: 'unwired/no paid match', fixture: fit, cars: electric, paid: false, denied: false, fits: false },
  { name: 'short/paid match', fixture: short, cars: diesel, paid: true, denied: false, fits: false },
  { name: 'fit/paid match', fixture: fit, cars: diesel, paid: true, denied: false, fits: true },
  { name: 'foreign access denied', fixture: fit, cars: diesel, paid: false, denied: true, fits: false },
];
const results = [];
for (const spec of cases) {
  const g = deserialize(JSON.parse(spec.fixture.raw)); assert.equal(saved(g), spec.fixture.raw);
  if (spec.paid) {
    const money = g.company(1).economy.money, loan = g.company(1).economy.loan, category = g.company(1).economy.current.vehicles;
    const t = g.vehicles.buyTrain(spec.fixture.depot, spec.cars, null);
    assert(t instanceof Train, 'actual native unassigned purchase: ' + String(t));
    const cost = spec.cars.reduce((sum, m) => sum + m.cost, 0);
    assert.equal(money - g.company(1).economy.money, cost, 'full catalogue purchase paid');
    assert.equal(g.company(1).economy.current.vehicles - category, -cost, 'native purchase ledger');
    assert.equal(g.company(1).economy.loan, loan, 'no injected purchase funds');
    assert.equal(t.owner, 1); assert.equal(t.depotId, spec.fixture.depot); assert.equal(t.lineId, null); assert.equal(t.state, 'depot');
    assert.deepEqual(t.cars.map(m => m.id), spec.cars.map(m => m.id)); assert.equal(t.length, body(spec.cars));
  }
  if (spec.denied) { g.setAccessPolicy(2, 'auto-reject'); assert(!g.canUse(1, 2), 'native foreign permission is actually denied'); }
  const matching = g.vehicles.trains().filter(t => t.owner === 1 && stockKey(t.cars) === stockKey(spec.cars));
  assert.equal(matching.length, spec.paid ? 1 : 0, spec.name + ': exact paid-stock premise');
  assert.equal(g.lines.all().length, 0); assert.equal(g.tick, 0); assert.equal(g.day, 0);
  const raw = saved(g), cold = deserialize(JSON.parse(raw)); assert.equal(saved(cold), raw, spec.name + ': full raw cold roundtrip');
  const actual = query(g, raw, spec.fixture.path, spec.cars, spec.name);
  const restored = query(cold, raw, spec.fixture.path, spec.cars, spec.name + ' cold');
  assert.deepEqual(pack(actual), pack(restored), spec.name + ': all native call/route outputs are exact after cold load');
  assert.equal(saved(g), raw); assert.equal(saved(cold), raw);
  results.push({ spec, actual });
}
for (const { spec, actual } of results) {
  assert.equal(actual.fits, spec.fits, spec.name + ': public through proof qualifies the proposed stock');
  assert.equal(actual.calls.every(c => c.groups.length > 0), spec.fits, spec.name + ': exact complete native call groups');
  assert.equal(!!actual.route, spec.fits, spec.name + ': separate strict full-body native route control');
  console.log('PASS', spec.name, 'platforms', actual.fits, 'call groups', actual.calls.map(c => c.groups.length).join('/'));
}
assert.equal(results[0].actual.fits, results[3].actual.fits, 'buying identical stock elsewhere cannot change the short-platform verdict');
assert.equal(results[1].actual.fits, results[4].actual.fits, 'buying identical stock elsewhere cannot change the fitting-platform verdict');
assert.equal(requests, 72, 'six fixed cases and independent cold repeats use exactly72 physical requests');
console.log('ALL CHECKS PASSED');
