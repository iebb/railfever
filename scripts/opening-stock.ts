// A proposed opening train must fit every served call, including calls beyond its first onward hop.
import assert from 'node:assert/strict';
import { serialize as pack } from 'node:v8';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { Train, findRailRoute } from '../src/game/train';
import { MODEL_BY_ID, type VehicleModel } from '../src/game/vehicle-types';
import { outAndBack } from '../src/game/lines';
import { replaceLineStops } from '../src/game/line-edit';
import { addPattern, patternStops, nextStopIndex } from '../src/game/patterns';
import { openingRailCall } from '../src/game/ai';
import { platformChoices, platformChoicesForStock, platformPreference } from '../src/game/rail-platforms';
import { station, depotFor } from './stationlib';
import { connectDouble, fails } from './lib';

const saved = (g: Game) => JSON.stringify(serialize(g));
const model = (id: string) => { const m = MODEL_BY_ID.get(id); assert(m); assert(m.intro <= 1985 && m.retire >= 1985); return m; };
const longIds = ['diesel_a', 'van_steel', 'coach_steel', 'coach_steel'];
const shortIds = ['diesel_a', 'coach_steel', 'coach_steel'];
const specs = [
  { name: 'C8 empty', length: 8, inactive: false }, { name: 'C12 empty', length: 12, inactive: false },
  { name: 'C8 inactive', length: 8, inactive: true }, { name: 'C12 inactive', length: 12, inactive: true },
];
let requests = 0;
function buy(g: Game, depot: number, cars: VehicleModel[], line: number | null): Train {
  const economy = g.company(1).economy, money = economy.money, loan = economy.loan, ledger = economy.current.vehicles;
  const t = g.vehicles.buyTrain(depot, cars, line);
  assert(t instanceof Train, 'native paid purchase: ' + String(t));
  const cost = cars.reduce((sum, car) => sum + car.cost, 0);
  assert.equal(money - economy.money, cost); assert.equal(economy.current.vehicles - ledger, -cost);
  assert.equal(economy.loan, loan); assert.equal(t.owner, 1); assert.equal(t.depotId, depot); assert.equal(t.lineId, line);
  assert.equal(t.state, 'depot'); assert.equal(t.onMap, false); assert.deepEqual(t.cars.map(c => c.id), cars.map(c => c.id));
  return t;
}
function fixture(spec: typeof specs[number]) {
  // Disclosed native starting balances fund actual paid assets. There is no investment/operating claim.
  const g = Game.create({ size: 384, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1985,
    aiConfigs: [{ startMoney: 100_000_000, accessPolicy: 'open' }, { startMoney: 100_000_000, accessPolicy: 'open' }] });
  g.aiEnabled = false; g.aiAcquisitions = false; g.vehicles.ambientEnabled = false;
  g.world.h.fill(4); g.world.heightsVersion++;
  assert.equal(g.ais.length, 2); assert.equal(g.towns.list.length, 0);
  for (const owner of [1, 2]) assert.equal(g.company(owner).economy.money, 100_000_000);
  const ledger = g.companies.map(c => ({ money: c.economy.money, loan: c.economy.loan }));
  const stations = [40, 140, 240, 340].map((x, i) => station(g, x, 192, Math.PI / 2, i === 2 ? spec.length : 12, 2, i < 2 ? 1 : 2));
  assert(stations.every(Boolean), 'four fixed native paid stations');
  const [a, b, c, d] = stations.map(s => { assert(s); return s; });
  assert.equal(new Set([a.id, b.id, c.id, d.id]).size, 4);
  assert(connectDouble(g, a, b, 1).ok, 'fixed A-B'); assert(connectDouble(g, b, c, 2).ok, 'fixed B-C');
  assert(connectDouble(g, c, d, 2).ok, 'fixed C-D'); assert.equal(fails.length, 0);
  const depot = depotFor(g, a, b, 1); assert(depot >= 0); assert(g.canUse(1, 2));
  const line = g.lines.create('rail', 1); replaceLineStops(g, line, outAndBack([a.id, b.id, c.id, d.id]));
  assert.deepEqual(line.stops, [a.id, b.id, c.id, d.id, c.id, b.id]);
  let pattern = 0, registered: Train | undefined;
  if (spec.inactive) {
    const p = addPattern(g, line.id, 'local', line.stops.map(() => true), 'Inactive all-calls');
    assert(p); assert.equal(p.id, 1); pattern = p.id;
    registered = buy(g, depot, shortIds.map(model), line.id); assert.equal(registered.pattern ?? 0, 0); assert(registered.length < 8);
  }
  const proposed = buy(g, depot, longIds.map(model), null);
  assert(proposed.length > 8 && proposed.length < 12); assert.equal(proposed.line, null);
  assert.equal(proposed.segs.length, 0); assert.equal(proposed.pending.length, 0);
  assert.deepEqual(line.vehicles, registered ? [registered.id] : []);
  assert(!line.vehicles.some(id => (g.vehicles.get(id)?.pattern ?? 0) === pattern), 'target pattern has no registered stock');
  assert.deepEqual(patternStops(line, pattern), [0, 1, 2, 3, 4, 5]);
  g.companies.forEach((co, i) => assert.equal(co.economy.loan, ledger[i].loan));
  assert(g.company(1).economy.money < ledger[1].money && g.company(2).economy.money < ledger[2].money);
  const before = saved(g), groups = g.stations.railTrackGroups(b);
  assert.equal(saved(g), before); assert(groups.length > 0 && groups.every(q => q.length + 1e-6 >= proposed.length + .05), 'actual B groups fit proposed stock');
  const raw = saved(g), cold = deserialize(JSON.parse(raw));
  assert.equal(saved(cold), raw, spec.name + ': complete paid fixture cold equality');
  return { spec, g, cold, raw, line: line.id, depot, pattern, proposed: proposed.id, registered: registered?.id, a: a.id, b: b.id };
}
function query(f: ReturnType<typeof fixture>, g: Game) {
  const l = g.lines.get(f.line), t = g.vehicles.get(f.proposed), dp = g.depots.get(f.depot);
  assert(l && t instanceof Train && dp?.kind === 'rail'); assert.equal(saved(g), f.raw);
  const length = t.length, rule = t.rule;
  assert.equal(saved(g), f.raw, 'native exact proposed operands are full-save pure');
  const q = <T>(read: () => T): T => {
    assert(++requests <= 84, 'four original query pairs plus deceptive ids and represented paid controls');
    try { return read(); } finally { assert.equal(saved(g), f.raw, f.spec.name + ': full save/RNG/ledger/rights/roster unchanged'); }
  };
  const pick = { line: l, depotId: dp.id, owner: 1, pattern: f.pattern, rule, length, id: -1 };
  const opening = q(() => openingRailCall(g, pick, f.a));
  const generic = q(() => platformChoices(g, l, f.pattern, 2));
  const full = l.stops.map((_station, stop) => q(() => platformChoicesForStock(g, l, f.pattern, stop, { owner: 1, rule, length })));
  const route = q(() => {
    const stub = g.world.net.edges.get(dp.edge); assert(stub?.kind === 'rail');
    const pref = platformPreference(l, f.pattern, 0), onward = l.stops[nextStopIndex(l, f.pattern, 0)]; assert.equal(onward, f.b);
    return findRailRoute(g, [{ edge: stub, dir: 1 }], f.a, 1, -1, 60000, false, rule, false,
      { preferred: pref?.group, manual: pref?.manual, length, onward });
  });
  // A DTO cannot borrow a different actual train's identity to omit its proposed full-stock proof.
  const existing = g.vehicles.get(f.registered ?? f.proposed); assert(existing instanceof Train);
  const deceptive = q(() => openingRailCall(g, { ...pick, id: existing.id }, f.a));
  let paid: number | undefined;
  if (f.registered !== undefined) {
    const actual = g.vehicles.get(f.registered); assert(actual instanceof Train);
    assert.equal(actual.line, l); assert.equal(actual.pattern ?? 0, 0); assert(l.vehicles.includes(actual.id));
    paid = q(() => openingRailCall(g, actual, f.a));
    assert.equal(paid, 0, 'registered native short pattern0 keeps its lawful original opening');
  }
  assert.equal(opening, f.spec.length === 8 ? -1 : 0, 'proposed opening rejects a late undersized served call');
  assert.equal(deceptive, opening, 'existing id alone cannot stand for represented proposed stock');
  assert(generic.length > 0, 'empty target-pattern fallback alone admits C');
  assert(full[0].length > 0, 'complete proposed A call fits'); assert(route, 'actual depot A/full-stock onward B remains legal');
  if (f.spec.length === 8) { assert.equal(full[2].length, 0); assert.equal(full[4].length, 0); }
  else assert(full.every(groups => groups.length > 0), 'all six proposed full-stock calls fit C12');
  assert.equal(t.lineId, null); assert.equal(t.onMap, false); assert.equal(g.tick, 0); assert.equal(g.day, 0);
  return { opening, generic, full, route, deceptive, paid };
}
// All four complete cold gates precede any diagnostic query.
const fixtures = specs.map(fixture);
for (const f of fixtures) {
  const warm = query(f, f.g), cold = query(f, f.cold);
  assert.deepEqual(pack(warm), pack(cold), f.spec.name + ': complete native outputs are exactly cold-replayable');
  assert.equal(saved(f.g), f.raw); assert.equal(saved(f.cold), f.raw);
  console.log('PASS', f.spec.name, 'opening', warm.opening, 'full groups', warm.full.map(q => q.length).join('/'));
}
assert.equal(requests, 84, '72 retained original witnesses +8 deceptive identities +4 actual-paid openings');
console.log('ALL CHECKS PASSED');
