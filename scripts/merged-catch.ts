// Shared public station zones, one population claim, prospective forecasts, published access and exact saves.
// Bundle as merged-catch.mjs and run with Node.
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { walkingCatchment, readWalkingCatchment, walkClaimShares, walkWeight, coverOf, walkLimit } from '../src/game/catchment';
import { forecastMailRevenue } from '../src/game/ai-mail';
import { flatGame, station, build, free, check, fails } from './stationlib';
import { roadOpts } from './lib';
import type { Town } from '../src/game/towns';
import type { Vehicle } from '../src/game/vehicle';
import type { Station, StationPlan } from '../src/game/stations';
import { WALK_TRIP_INTENSITY } from '../src/game/constants';

const near = (a: number, b: number) => Math.abs(a - b) < 1e-8;
const flush = (g: Game) => { g.stations.refreshAccess(true); g.stations.recomputeCatchment(); g.demand.recomputeShares(); };
const house = (g: Game, x: number, z: number, pop = 100) => g.world.addBuilding({ townId: 0, x, z, angle: 0, w: .8, d: .8, type: 0, floors: 2, pop, seed: 1, y: 3, built: 0 });
const bus = (g: Game, x: number, z: number, owner: number) => {
  const id = g.stations.nextId, error = g.stations.commitBusStop(x, z, owner);
  if (error) throw new Error(error); return g.stations.get(id)!;
};
const saved = (g: Game) => JSON.stringify(serialize(g));
const g = flatGame(192); g.addAICompany(); g.addAICompany(); g.aiEnabled = false;
g.towns.list = [0, 1].map((id): Town => ({ id, name: `Town ${id}`, x: 62 + id * 72, z: 64, angle: 0, pop: 2000, radius: 24,
 buildings: new Set(), nextGrowthDay: 1e6, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 }));
for (const c of g.companies) c.hqTown = c.id % 2;
check(!!build(g, free(g, 16, 64), free(g, 176, 64), roadOpts(), 'shared street'), 'fixture street');
const A = bus(g, 60, 64, 0), B = bus(g, 64, 64, 1), rival = bus(g, 62, 64, 2);
const h = house(g, 62, 62), outer = house(g, 72, 62);
A.townId = B.townId = rival.townId = 0; g.demand.rebuild(); flush(g);
const oldNetwork = g.world.net.version, owners = [A.owner, B.owner, rival.owner];
check(!g.stations.link(A.id, B.id), 'native public passage admits different owners'); flush(g);
check(g.world.net.version === oldNetwork && A.name === B.name, 'logical merge shares name and keeps physical network');
const walk = walkingCatchment(g, A);
check(walk === walkingCatchment(g, B) && walk.buildings.has(outer.id), 'every member sees the exact same union geometry and outer member coverage');
check(readWalkingCatchment(g, A) === readWalkingCatchment(g, B), 'passive member reads share one union object');
const claims = g.stations.stationsForBuilding(h.id), byId = new Map(claims.st.map((id, i) => [id, claims.w[i]]));
const cw = walkWeight(walk.buildings.get(h.id)!.distance), rw = walkWeight(walkingCatchment(g, rival).buildings.get(h.id)!.distance);
const expected = cw / (cw + rw) * coverOf(Math.max(cw, rw));
check(near((byId.get(A.id) ?? 0) + (byId.get(B.id) ?? 0), expected), 'two physical members compete with the rival as one public station');
check(near(claims.w.reduce((n, w) => n + w, 0), 1), 'one building population is allocated once');
const equal = walkClaimShares([{ group: 1, weight: 1 }, { group: 1, weight: 1 }, { group: 2, weight: 1 }]);
check(near(equal[0] + equal[1], .5) && near(equal[2], .5), 'equal-distance two-part complex receives half against one rival');
const mail = g.mail.forecastPops([A, B, rival], 0);
// (walkers post at WALK_TRIP_INTENSITY since the walks were halved after 2.9: mail.ts allocateMail)
check(near(mail[0] + mail[1] + mail[2], [h, outer].reduce((n, b) => n + b.pop, 0) * WALK_TRIP_INTENSITY), 'mail forecast allocates the union once');
check(g.demand.forecastLine([A, B], 'mainline', 50, 120).boardings === 0, 'same-complex physical endpoints do not sell pedestrian trips');
B.townId = 1;
check(forecastMailRevenue(g, [A, B], 50, 120, 40) === 0, 'cross-town member metadata cannot sell an internal-complex mail journey'); B.townId = 0;
const plan = { ...g.stations.planRail(60, 72, Math.PI / 2, 8, 2, 0, { level: 'underground', depth: 4, style: 'none' }), townId: 0, links: [A], join: null, roadAccess: true, walk } as StationPlan & { walk: typeof walk };
check(g.demand.forecastLine([plan, B], 'mainline', 50, 120).boardings === 0, 'admitted planned passage gets shared prospective identity');
const beforeRead = saved(g); readWalkingCatchment(g, A); g.stations.buildingShares(B); g.demand.coverageSnapshot(A);
check(saved(g) === beforeRead, 'shared zone and demand UI reads never publish simulation state');
const replay = deserialize(serialize(g));
if (saved(replay) !== saved(g)) {
  const a = serialize(g), b = serialize(replay);
  for (const key of Object.keys(a)) if (JSON.stringify((a as any)[key]) !== JSON.stringify((b as any)[key])) console.log('save differs', key, JSON.stringify((a as any)[key]).slice(0,500), JSON.stringify((b as any)[key]).slice(0,500));
}
check(saved(replay) === saved(g), 'new shared-zone save round trip is exact');
let identical = true; for (let tick = 0; tick < 32; tick++) { g.stepTick(); replay.stepTick(); if (saved(g) !== saved(replay)) { identical = false; break; } }
check(identical, 'new shared-zone save replays every native tick exactly');
check([A.owner, B.owner, rival.owner].every((owner, i) => owner === owners[i]), 'public sharing retains every physical owner');

// No direct portal at the foreign rail part: the bus member supplies actual access, never a rail-radius upgrade.
const access = flatGame(128); access.addAICompany(); access.aiEnabled = false;
check(!!build(access, free(access, 16, 64), free(access, 112, 64), roadOpts(), 'access street'), 'access fixture street');
const stop = bus(access, 62, 64, 0), rail = station(access, 64, 68, Math.PI / 2, 8, 2, 1, { level: 'underground', depth: 4, style: 'none' })!;
if (!rail) throw new Error('access rail fixture'); rail.rail!.entrances = []; rail.rail!.forecourt = undefined;
flush(access); check(!rail.roadAccess, 'bare rail part has no direct landing');
const maintenance = access.stationMaintenance(rail), physicalEdges = [...rail.rail!.edges];
access.blockCompany(1, 0);
check(!access.stations.link(stop.id, rail.id), 'public walking merge does not require platform operating rights'); flush(access);
check(rail.roadAccess && !access.canUse(0, 1), 'logical access follows the public landing while native train rights remain blocked');
const farther = house(access, 62 + walkLimit('bus') + 2, 62);
flush(access); check(!walkingCatchment(access, rail).buildings.has(farther.id), 'unconnected mainline part cannot widen the bus landing budget');
check(access.stationMaintenance(rail) === maintenance && JSON.stringify(rail.rail!.edges) === JSON.stringify(physicalEdges), 'shared zone retains physical upkeep and platform edges');
const old = serialize(access); old.catchmentRulesVersion = 1; old.catchmentAccessCurrent = true;
(old.stations as any[]).find(s => s.id === rail.id).roadAccess = false;
const migrated = deserialize(old);
check(migrated.stations.get(rail.id)!.roadAccess && migrated.lines.catchmentDirty, 'old saves refresh shared access and owe a normal population publication');
access.unblockCompany(1, 0); access.refreshAccess();
access.recordStop({ owner: 0 } as Vehicle, rail); access.billAccess();
check(near(access.company(1).economy.current.trackIncome, maintenance / 12) && near(access.economy.current.trackFees, -maintenance / 12),
 'native station use pays the physical rail owner exactly its separate monthly upkeep');
const unchangedNetwork = access.world.net.version; access.stations.unlink(stop.id, rail.id); flush(access);
check(!rail.roadAccess && access.world.net.version === unchangedNetwork, 'unlink removes shared access without any physical track edit');

// Unrelated lots must not materialize extra old/new allocation claims for a local candidate.
const small = deserialize(serialize(g)), points = [small.stations.get(A.id)!, small.stations.get(rival.id)!];
small.demand.forecastLine(points, 'mainline', 50, 120); const count = { ...small.demand.forecastClaimStats };
check(!!build(small, free(small, 140, 148), free(small, 180, 148), roadOpts(), 'distant served street'), 'distant served street');
const distant = bus(small, 158, 148, 2);
for (let i = 0; i < 8; i++) house(small, 154 + i, 146);
// Isolate forecast allocation from route/fleet setup: this is the exact native served-station index.
(small.lines as any).servedStations.add(distant.id); small.lines.servedVersion++;
check(walkingCatchment(small, distant).buildings.size > 0, 'distant served site actually claims unrelated world lots');
small.demand.forecastLine(points, 'mainline', 50, 120);
check(JSON.stringify(count) === JSON.stringify(small.demand.forecastClaimStats), 'unrelated world lots add zero candidate allocation records');
const transit = flatGame(128); transit.addAICompany(); transit.aiEnabled = false;
check(!!build(transit, free(transit, 16, 64), free(transit, 112, 64), roadOpts(), 'transit street'), 'transit street');
const M = station(transit, 60, 74, Math.PI / 2, 8, 2, 1, { level: 'underground', depth: 3, style: 'none' })!;
const N = station(transit, 64, 79, Math.PI / 2, 8, 2, 0, { level: 'underground', depth: 3, style: 'none' })!;
if (!M || !N) throw new Error('transit parts');
for (const [st, x] of [[M, 60], [N, 64]] as const) { st.city = true; st.rail!.mode = 'metro'; st.rail!.entrances = [{ x, z: 64.8, angle: 0 }]; }
if (!transit.stations.catchmentMembers(M.id).includes(N.id)) check(!transit.stations.link(M.id, N.id), 'transit parts form one public station');
const nearHome = house(transit, 68, 62), farHome = house(transit, 74, 62); flush(transit);
check(walkingCatchment(transit, M) === walkingCatchment(transit, N) && walkingCatchment(transit, M).buildings.has(nearHome.id)
 && !walkingCatchment(transit, M).buildings.has(farHome.id), 'all-transit union retains half walking budgets rather than widening its main representative');
console.log(`complex/rival building share ${expected.toFixed(3)}; claims ${JSON.stringify(count)}; shared zones, access, mail, forecasts and replay`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED'); process.exitCode = fails.length ? 1 : 0;
