// Exact save/load replay with player lines, AI companies and staggered depot departures.
// Bundle as replay.mjs in the scratch directory, then run with node replay.mjs [seed].
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { networkPlanner } from '../src/game/ai-network';
import {
  fails, check, placeAndConnect, depotBehind, busStopSites, addBusStop, roadDepotNear,
  checkReservations, checkNaN, Train, RoadVehicle,
} from './lib';

const seed = Number(process.argv[2] ?? 7);
const DAYS = 400;
const busy = (g: Game) => g.ais.some((a) => a.busy || !!networkPlanner(a)?.task);
const saved = (g: Game) => JSON.stringify(serialize(g));

function fixture() {
  const g = Game.create({ size: 384, seed, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 2 });
  g.economy.money = 40_000_000;
  const pr = placeAndConnect(g, 60, 150, 0, new Set(), 1, () => {});
  check(!!pr, 'player railway stations connected');
  if (!pr) return null;
  const dep = depotBehind(g, pr.A, pr.B, 0);
  const line = g.lines.create('rail', 0);
  line.stops = [pr.A.id, pr.B.id];
  const train = g.vehicles.buyTrain(dep, [MODEL_BY_ID.get('diesel_b')!, MODEL_BY_ID.get('coach_ic')!, MODEL_BY_ID.get('coach_ic')!], line.id);
  check(train instanceof Train, `player train bought: ${typeof train === 'string' ? train : train.id}`);
  if (!(train instanceof Train)) return null;

  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop)[0];
  const sites = busStopSites(g, big, 0, 12, 30);
  check(sites.length === 2, 'player bus stop sites');
  if (sites.length !== 2) return null;
  const stops = sites.map(([x, z]) => addBusStop(g, x, z, 0));
  check(stops.every((id) => id >= 0) && stops[0] !== stops[1], 'two player bus stations built');
  if (stops.some((id) => id < 0) || stops[0] === stops[1]) return null;
  const bd = roadDepotNear(g, sites[0][0], sites[0][1], 0);
  const bl = g.lines.create('road', 0);
  bl.stops = stops;
  const buses: RoadVehicle[] = [];
  for (let i = 0; i < 2; i++) {
    const bus = g.vehicles.buyRoad(bd, MODEL_BY_ID.get('bus_c')!, bl.id);
    check(bus instanceof RoadVehicle, `player bus ${i + 1} bought`);
    if (!(bus instanceof RoadVehicle)) return null;
    buses.push(bus);
  }
  check(line.evenSpacing === true && bl.evenSpacing === true, 'player lines use even spacing');
  g.ais[0].config = { ...g.ais[0].config, activeness: 1.4, risk: 0.7, focus: { rail: 2, road: 1, tram: 0.5 } };
  check(g.requestAccess(0, g.ais[1].companyId) === 'granted', 'access agreement signed');
  g.setAccessPolicy(0, 'ask');
  check(g.requestAccess(g.ais[0].companyId, 0, 'test') === 'pending', 'pending access request');
  g.lines.rename(line.id, 'Main Line');
  return { g, buses, bl };
}

/** Saves exclude in-flight AI jobs: wait for an idle point, using only committed simulation ticks. */
function advanceToIdle(g: Game, day: number): boolean {
  const limit = (day + 360) * TICKS_PER_DAY;
  while ((g.day < day || busy(g)) && g.tick < limit) g.stepTick();
  const ready = g.day >= day && !busy(g);
  check(ready, `AI projects finish before the save at day ${day}`);
  return ready;
}

function identical(a: string, b: string, label: string): boolean {
  if (a === b) return true;
  let i = 0;
  while (i < a.length && a[i] === b[i]) i++;
  check(false, `${label}: JSON differs at character ${i} (${a.length} vs ${b.length} chars)`);
  console.log(`    original: ${a.slice(Math.max(0, i - 100), i + 100)}\n    loaded:   ${b.slice(Math.max(0, i - 100), i + 100)}`);
  return false;
}

function replay(g: Game, label: string) {
  check(!busy(g), `${label}: no in-flight AI job at the save point`);
  if (busy(g)) return;
  const json = saved(g);
  const loaded = deserialize(JSON.parse(json));
  console.log(`${label}: saved on ${g.dateString()}, tick ${g.tick}; replaying ${DAYS} days`);
  if (!identical(json, saved(loaded), `${label}: exact round trip`)) return;
  let days = 0;
  for (; days < DAYS; days++) {
    for (let k = 0; k < TICKS_PER_DAY; k++) { g.stepTick(); loaded.stepTick(); }
    if (!identical(saved(g), saved(loaded), `${label}: day ${days + 1} (${g.dateString()}, tick ${g.tick})`)) break;
  }
  check(days === DAYS, `${label}: exact daily saves for all ${DAYS} days`);
  check(checkReservations(g).length === 0 && checkReservations(loaded).length === 0, `${label}: consistent reservations`);
  check(!checkNaN(g) && !checkNaN(loaded), `${label}: no NaN positions`);
  if (days === DAYS) console.log(`  ${DAYS} daily snapshots identical through ${g.dateString()}`);
}

function run() {
  // The original regression: a mature network, a buyout, then a local street edit before the next month.
  const mature = fixture();
  if (mature) {
    const { g } = mature;
    if (advanceToIdle(g, 200)) {
      g.economy.money += 80_000_000;
      check(g.buyCompany(0, g.ais[1].companyId) === null, 'player buys an AI company');
      if (advanceToIdle(g, 240)) replay(g, 'mature network');
    }
  }

  // A separate original game preserves the startup cache state. Save between the two depot releases,
  // with an absolute release clock, a waiting vehicle, and a street edit awaiting the next network flush.
  const staged = fixture();
  if (staged) {
    const { g, buses, bl } = staged;
    g.stepTick();
    check(buses.some((v) => v.onMap) && buses.some((v) => v.status === 'Waiting to depart (spacing)'), 'save during staggered depot dispatch');
    check(Object.values(bl.spacing ?? {}).some((s) => Object.values(s.released ?? {}).includes((g.tick - 1) * g.tickSeconds)), 'save includes the successful depot release clock');
    const st = g.stations.get(bl.stops[0])!, town = g.towns.list[st.townId];
    for (let i = 0; i < 40 && g.world.nextBuildingId - 1 === g.stations.catchMaxB; i++) g.towns.growStep(town, g.rng, g.day);
    g.towns.recomputePop(town);
    check(g.world.nextBuildingId - 1 > g.stations.catchMaxB, 'buildings added since the last catchment share-out');
    check(roadDepotNear(g, st.x, st.z, 0) >= 0, 'a local street edit before the save');
    const pending = serialize(g);
    check(pending.networkDirty && pending.catchmentRoadsDirty && !pending.catchmentDirty, 'street invalidation waits for the pending network flush');
    replay(g, 'staggered depot dispatch');
  }
}

check(Number.isSafeInteger(seed), 'seed must be an integer');
if (Number.isSafeInteger(seed)) {
  console.log(`save/load replay seed ${seed}`);
  try { run(); }
  catch (e) { check(false, `replay exception: ${(e as Error).stack ?? e}`); }
}
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
