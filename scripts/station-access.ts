// A priced station access street must commit, or refuse before any station/cash/terrain mutation.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { walkingCatchment, walkingPopulation } from '../src/game/catchment';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { check, fails, roadOpts, addBusStop, roadDepotNear, RoadVehicle } from './lib';
import { flatGame, build, free } from './stationlib';
import { terrainFit, fitLine } from './terrainfit';

function need(v: unknown, label: string): asserts v { if (!v) throw new Error('fixture setup: ' + label); }
const saved = (g: Game) => JSON.stringify(serialize(g));
const flush = (g: Game) => { g.flushNetworkChanges(); g.lines.flushCatchment(); g.stations.refreshAccess(true); };

{
  const g = flatGame(192), plan = g.stations.planRail(96, 96, Math.PI / 2, 16, 2, 0);
  check(plan.ok && !plan.access && !plan.roadAccess, 'an explicit manual station may be quoted without an access street');
  const error = g.stations.commitRail(plan, 0); flush(g);
  check(error === null && !g.stations.all()[0].roadAccess,
    'an explicitly unconnected manual station still builds without promising access');
}

// Two surveyed native seed-23 sites: installing the second platform first used to make its quoted road fail
// the live formation guard. commitRail discarded that error and left a successful-looking station with no access.
{
  const g = Game.create({ size: 384, seed: 23, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1950 });
  g.economy.money = 1e9; g.aiEnabled = false;
  const before = terrainFit(g), cash = g.economy.money;
  let cost = 0;
  const sites = [
    [192.0339294381769, 132.84678695094624, -1.392204883144559, 8.365983817699801],
    [119.65482078349278, 202.82187677335162, 1.8005109379309454, 2.982393937539206],
  ];
  for (let i = 0; i < sites.length; i++) {
    const [x, z, angle, fixedY] = sites[i], data = saved(g);
    const plan = g.stations.planRail(x, z, angle, 16, 2, 0, { fixedY });
    check(plan.ok && plan.roadAccess && !!plan.access?.ok, `site ${i}: native quote includes a priced access street`);
    need(plan.ok && plan.access, 'surveyed native site');
    check(data === saved(g), `site ${i}: access/platform quote is pure`);
    const h = deserialize(JSON.parse(data)), cold = h.stations.planRail(x, z, angle, 16, 2, 0, { fixedY });
    check(JSON.stringify(plan) === JSON.stringify(cold), `site ${i}: cold and warm native quotes agree`);
    const id = g.stations.nextId, err = g.stations.commitRail(plan, 0), coldErr = h.stations.commitRail(cold, 0);
    check(err === null && coldErr === null, `site ${i}: native quoted access and platforms both commit`);
    flush(g); flush(h);
    const st = g.stations.get(id)!;
    check(st.roadAccess && walkingPopulation(g, walkingCatchment(g, st)) > 0,
      `site ${i}: the quoted access reaches real walking homes after construction`);
    check(saved(g) === saved(h), `site ${i}: access-first construction agrees after cold loading`);
    cost += plan.cost;
  }
  const after = terrainFit(g);
  check(after.station === 0 && after.covered === 0 && after.floating <= before.floating,
    'joint native station/access construction adds no actual-width support failures');
  check(cash - g.economy.money === cost, 'platforms and access streets charge exactly their combined native quotes');
  const h = deserialize(JSON.parse(saved(g))); let exact = saved(g) === saved(h);
  for (let i = 0; i < 80; i++) { g.stepTick(); h.stepTick(); exact &&= saved(g) === saved(h); }
  check(exact, 'native access roads and stations replay exactly at every fixed step');
  console.log(`native station access: ${fitLine(after)}`);
}

// A real bus reaches the road edge selected for the quoted access connection after the survey.
{
  const g = flatGame(192); g.aiEnabled = false; g.vehicles.ambientEnabled = false;
  need(build(g, free(g, 15, 60), free(g, 175, 60), roadOpts(0, 'street')), 'street');
  const a = addBusStop(g, 30, 60, 0), b = addBusStop(g, 150, 60, 0), depot = roadDepotNear(g, 25, 60, 0);
  const line = g.lines.create('road', 0); line.stops = [a, b];
  const bus = g.vehicles.buyRoad(depot, MODEL_BY_ID.get('bus_c')!, line.id);
  need(bus instanceof RoadVehicle, 'native bus');
  const plan = g.stations.planRail(96, 70, Math.PI / 2, 16, 2, 0);
  need(plan.ok && plan.access?.ok, 'priced native access');
  const ends = plan.access.tracks.flatMap(t => [t.start, t.end]).filter(s => s.kind === 'edge').map(s => s.edge!);
  need(ends.length, 'access snaps to a real street edge');
  for (let k = 0; k < 10000 && !ends.some(id => g.vehicles.isEdgeBusy(id)); k++) g.stepTick();
  check(ends.some(id => g.vehicles.isEdgeBusy(id)), 'a native operated bus makes the quoted road connection busy');
  const data = saved(g), err = g.stations.commitRail(plan, 0);
  check(err === 'Vehicle in the way', 'station reports the priced access street refusal');
  check(saved(g) === data, 'a refused access street leaves cash, buildings, station IDs, roads and terrain untouched');
  const h = deserialize(JSON.parse(data));
  check(h.stations.commitRail(plan, 0) === err && saved(h) === data, 'cold loading preserves the same atomic access refusal');
}

console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
