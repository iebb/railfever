// Demolition charges, affordability and vehicle resale regressions.
// Bundle as demolish.mjs with esbuild, then run with node.
import { bulldoze } from '../src/game/build-ops';
import { makeSeg, Train } from '../src/game/train';
import { serialize, deserialize } from '../src/game/save';
import { flatGame, station, loco, check, done } from './stationlib';

function run() {
  console.log('demolition charges');
  const g = flatGame(128), economy = g.economy;
  const plan = g.depots.plan('rail', 32, 32, 0, 0);
  check(plan.ok && !g.depots.commit('rail', plan, 0), 'test depot built');
  const dp = g.depots.all()[0];
  if (!dp) { done(); return; }
  const bought = g.vehicles.buyTrain(dp.id, loco(), null);
  check(bought instanceof Train, 'test train purchased');
  if (!(bought instanceof Train)) { done(); return; }
  const train = bought;
  let money = economy.money, construction = economy.current.construction;
  for (const dryRun of [true, false]) {
    const r = bulldoze(g, dp.x, dp.z, dp.x, dp.z, 0, dryRun);
    check(r.cost === 0 && r.changed === 0 && r.error === 'Vehicles are in the depot', 'occupied depot preview/removal costs nothing');
    check(economy.money === money && economy.current.construction === construction && !!g.depots.get(dp.id), 'failed depot removal leaves finances and depot intact');
  }

  const st = station(g, 76, 64, 0, 12, 1, 0, { through: 1 });
  if (!st?.rail) { check(false, 'test station built'); done(); return; }
  money = economy.money; construction = economy.current.construction;
  const tracks = [...st.rail.edges, ...st.rail.throughEdges];
  const seg = makeSeg(g, g.world.net.edges.get(st.rail.edges[0])!, 1);
  train.segs = [seg]; train.headSeg = 0; train.headPos = seg.len / 2;
  train.state = 'loading'; train.atStation = st.id;
  for (const dryRun of [true, false]) {
    const r = bulldoze(g, st.x, st.z, st.x, st.z, 0, dryRun);
    check(r.cost === 0 && r.changed === 0 && r.error === 'Train in the station', 'loading train blocks station preview/removal without a charge');
    check(economy.money === money && economy.current.construction === construction && !!g.stations.get(st.id), 'failed station removal leaves finances and station intact');
  }
  const house = g.world.addBuilding({ townId: -1, x: 92, z: 64, y: 3, angle: 0, w: 1, d: 1, floors: 1, type: 0, pop: 10, seed: 1, built: 0 });
  const partialPreview = bulldoze(g, 70, 55, 94, 73, 0, true);
  const partial = bulldoze(g, 70, 55, 94, 73, 0, false);
  check(partialPreview.cost === 31000 && partialPreview.changed === 1 && partialPreview.error === 'Train in the station', 'mixed area preview charges only the removable house');
  check(partial.cost === partialPreview.cost && partial.changed === partialPreview.changed && partial.error === partialPreview.error, 'mixed area execution agrees with the preview');
  check(economy.money === money - 31000 && !g.world.buildings.has(house.id) && tracks.every((id) => g.world.net.edges.has(id)), 'partial demolition charges once and preserves the occupied station, including through tracks');

  train.segs = []; train.state = 'depot'; train.atStation = -1;
  money = economy.money;
  const emptyStationPreview = bulldoze(g, st.x, st.z, st.x, st.z, 0, true);
  const emptyStation = bulldoze(g, st.x, st.z, st.x, st.z, 0, false);
  check(emptyStationPreview.cost === 20000 && emptyStation.cost === 20000 && emptyStation.changed === 1 && !emptyStation.error, 'empty station costs exactly $20,000 to remove');
  check(economy.money === money - 20000 && tracks.every((id) => !g.world.net.edges.has(id)), 'station and through tracks are charged together');
  money = economy.money;
  g.vehicles.sell(train.id);
  check(economy.money === money + train.value, 'selling a newly purchased train refunds the full purchase value');
  money = economy.money;
  const emptyDepotPreview = bulldoze(g, dp.x, dp.z, dp.x, dp.z, 0, true);
  const emptyDepot = bulldoze(g, dp.x, dp.z, dp.x, dp.z, 0, false);
  check(emptyDepotPreview.cost === 15000 && emptyDepot.cost === 15000 && emptyDepot.changed === 1 && !emptyDepot.error && economy.money === money - 15000, 'empty depot costs exactly $15,000 to remove');

  console.log('area affordability');
  const a = flatGame(128), net = a.world.net;
  const b1 = a.world.addBuilding({ townId: -1, x: 30, z: 35, y: 3, angle: 0, w: 1, d: 1, floors: 1, type: 0, pop: 10, seed: 1, built: 0 });
  const b2 = a.world.addBuilding({ townId: -1, x: 40, z: 35, y: 3, angle: 0, w: 1, d: 1, floors: 1, type: 0, pop: 20, seed: 2, built: 0 });
  a.economy.money = 40000; // one house is affordable, but the whole rectangle is not
  construction = a.economy.current.construction;
  const insufficient = bulldoze(a, 20, 20, 50, 50, 0, true);
  check(insufficient.cost === 87000 && insufficient.error === 'Not enough money' && insufficient.changed === 0, 'area preview reports insufficient funds for the whole selection');
  const rejected = bulldoze(a, 50, 50, 20, 20, 0, false);
  check(rejected.error === 'Not enough money' && rejected.changed === 0 && rejected.cost === 0, 'unaffordable reversed rectangle removes nothing');
  check(a.economy.money === 40000 && a.economy.current.construction === construction && a.world.buildings.size === 2 && net.edges.size === 0, 'unaffordable area leaves the map and finances unchanged');
  a.economy.money = 0;
  check(bulldoze(a, b1.x, b1.z, b1.x, b1.z, 0, true).error === 'Not enough money', 'single demolition preview also checks money');
  check(bulldoze(a, b1.x, b1.z, b1.x, b1.z, 0, false).changed === 0 && a.world.buildings.has(b1.id), 'single demolition respects money');
  a.economy.money = insufficient.cost;
  const affordable = bulldoze(a, 20, 20, 50, 50, 0, true);
  const cleared = bulldoze(a, 50, 50, 20, 20, 0, false);
  check(!cleared.error && cleared.cost === affordable.cost && cleared.changed === affordable.changed && cleared.changed === 2, 'affordable area removal agrees with its preview');
  check(a.economy.money === 0 && a.economy.current.construction === construction - 87000 && !a.world.buildings.has(b1.id) && !a.world.buildings.has(b2.id), 'area demolition spends exactly its cost without entering debt');

  console.log('resale curve');
  const r = flatGame(128);
  const idle = new Train(r, 1, loco(), -1);
  r.vehicles.map.set(idle.id, idle);
  r.day = idle.boughtDay + 20 * 360;
  r.vehicles.monthly();
  check(r.vehicles.resaleValue(idle) === idle.value, 'never-used depot stock retains full value despite age and depot overheads');
  const loaded = deserialize(serialize(r)), restored = loaded.vehicles.get(idle.id)!;
  check(loaded.vehicles.resaleValue(restored) === restored.value, 'unused depot stock retains full resale value after a save round trip');
  idle.opLastSt = 1; idle.state = 'running'; // recorded service: the vehicle has left the depot
  let last = idle.value;
  for (const days of [0, 29, 30, 30.01, 360, (30 + 15 * 360) / 2, 15 * 360, 30 * 360]) {
    r.day = idle.boughtDay + days;
    const price = r.vehicles.resaleValue(idle);
    check(Number.isFinite(price) && price <= last && price >= idle.value * 0.1, `resale is finite, monotonic and bounded at ${days} days`);
    if (days <= 30) check(price === idle.value, 'full purchase value through the 30-day grace period');
    if (days === 30.01) check(idle.value - price < idle.value * 0.00001, 'depreciation starts smoothly after the grace period');
    if (days === (30 + 15 * 360) / 2) check(Math.abs(price / idle.value - 0.55) < 1e-9, 'resale declines linearly to 55% halfway to 15 years');
    if (days >= 15 * 360) check(Math.abs(price / idle.value - 0.1) < 1e-9, 'old vehicles retain a 10% resale floor');
    last = price;
  }
  idle.state = 'depot'; idle.status = 'Returned to depot';
  r.day = idle.boughtDay + 360;
  check(r.vehicles.resaleValue(idle) < idle.value, 'returning a used vehicle to the depot does not restore its purchase value');
  done();
}

if (import.meta.url.endsWith('/demolish.mjs')) run();
