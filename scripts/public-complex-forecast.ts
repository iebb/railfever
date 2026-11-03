// A single future railway must advertise exactly the public passages its paid native commit makes.
// The fixture uses the established flat city-line layout, actual streets/residents and ordinary funds.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { planWalkingCatchment, readWalkingCatchment, walkingPopulation, forecastRailLinks,
  prospectiveWalkGroups } from '../src/game/catchment';
import { WALK_LINE, type StationPlan, type Station } from '../src/game/stations';
import { consistRule, findRailRoute, platformDepartureFrontiers } from '../src/game/train';
import { bezDeriv, type Bez } from '../src/game/geom';
import { planStationOnTrack, commitStationOnTrack } from '../src/game/trackops';
import { stationPose } from '../src/game/station-geometry';
import { pickTrain } from '../src/game/ai';
import { flat, cityLine, newTown, district, M } from './linegrow-fixtures';
import { build, free, roadOpts } from './lib';

const save = (g: Game) => JSON.stringify(serialize(g));
const ids = (stations: readonly Station[]) => stations.map(st => st.id);
const plain = (value: unknown) => JSON.stringify(value, (_key, v) => v instanceof Map ? [...v] : v);
let checks = 0;
function check(value: unknown, label: string): asserts value {
  assert(value, label); checks++; console.log(`PASS ${label}`);
}
function plan(g: Game, owner: number, x: number, z: number, level: StationPlan['level'] = 'ground') {
  const p = g.stations.planRail(x, z, Math.PI / 2, 10, 2, owner,
    { mode: 'mainline', trackType: 'standard', level, style: 'none' });
  check(p.ok, `native ${level} station preflight at ${x}/${z}: ${p.error ?? 'ok'}`);
  return p;
}
function commit(g: Game, owner: number, p: StationPlan) {
  const id = p.join?.id ?? g.stations.nextId, before = g.company(owner).economy.money;
  assert.equal(g.stations.commitRail(p, owner), null);
  check(Math.abs(before - g.company(owner).economy.money - p.cost) < 1e-6, 'native complete station price paid');
  return g.stations.get(id)!;
}
function compareCommit(g: Game, owner: number, p: StationPlan, label: string) {
  const before = save(g), expected = ids(g.stations.prospectiveRailLinks(p));
  assert.equal(save(g), before, `${label}: prospective links are full-save pure`);
  const inherited = [...(p.join?.links ?? [])], st = commit(g, owner, p);
  assert.deepEqual(st.links, [...inherited, ...expected], `${label}: exact direct-link order`);
  check(true, `${label}: preview equals paid native commit in original manual/automatic order`);
  return st;
}
function refresh(g: Game) {
  g.flushNetworkChanges(); g.stations.refreshAccess(); g.lines.flushCatchment();
}
function fundAccess(g: Game, st: Station) {
  refresh(g);
  check(!st.roadAccess, 'native access refresh confirms the old facility really lacks a road');
  const repair = g.aiOf(st.owner) as any, oldMoney = repair.eco.money, oldLoan = repair.eco.loan;
  const roadCount = [...g.world.net.edges.values()].filter(e => e.kind === 'road').length;
  check(!repair.advanceRailRoadAccess(st) && repair.accessTask?.stage === 'roadCommit'
    && repair.accessTask.road?.ok, 'first ordinary native access unit quotes a lawful retained-facility street');
  const cost = repair.accessTask.road.cost;
  check(repair.advanceRailRoadAccess(st) && !repair.accessTask && g.stations.hasAccess(st),
    'second ordinary native access unit funds and commits the real street');
  check(Math.abs(oldMoney - repair.eco.money - cost) < 1e-6 && repair.eco.loan === oldLoan
    && [...g.world.net.edges.values()].filter(e => e.kind === 'road').length > roadCount,
    'retained-facility street pays its full native cost without changing the loan');
  console.log(`native access ledger: station=${st.id}, cost=${cost}, money=${oldMoney}->${repair.eco.money}, loan=${repair.eco.loan}`);
}

// A long access road can supply native access while leaving every resident outside the walk budget.
// This is the retained original failed-positive geometry, now explicitly checked as a negative.
let joinedCheckpoint = '';
{
  const { g: long } = flat(2), west = newTown(long, 'Long Westbank', 200, 272);
  const service = cityLine(long, 1, [180, 220], 256, 'west', 'tail', 2);
  district(long, west, 150, 246, 272, 8, 1200, false, false);
  const east = newTown(long, 'Long Eastbank', 370, 272);
  district(long, east, 340, 400, 272, 8, 1200, false, false);
  fundAccess(long, service.sts[1]);
  const far = commit(long, 2, plan(long, 2, 360, 256)); refresh(long);
  check(service.sts[1].roadAccess && far.roadAccess
    && readWalkingCatchment(long, service.sts[1]).buildings.size === 0
    && readWalkingCatchment(long, far).buildings.size === 0,
    'long real access streets grant native access but no residents beyond the unchanged walking budget');
  joinedCheckpoint = save(long);
  compareCommit(long, 2, plan(long, 2, 180, 264), 'long-access public link without invented walking demand');
}

// Analytic positive: roads lie eight units from railway axes, so a native forecourt's access
// street is about 5.5u and nearby frontage fits the unchanged 14.7u walk. No roads cross rail sweeps.
const { g } = flat(2), town = newTown(g, 'Westbank', 200, 252);
const old = cityLine(g, 1, [180, 220], 256, 'west', 'tail', 2);
district(g, town, 150, 246, 232, 8, 600, false, false);
district(g, town, 150, 246, 264, 8, 600, false, false);
const farTown = newTown(g, 'Eastbank', 370, 264);
district(g, farTown, 340, 400, 264, 8, 1200, false, false);
// Repair the existing facility through exactly its ordinary two saved native road units.
// A full replacement quote is inappropriate here: its station footprint can intersect the throat.
for (const st of old.sts) fundAccess(g, st);
const far = commit(g, 2, plan(g, 2, 360, 256));
g.setAccessPolicy(1, 'auto-reject'); refresh(g);
check([...g.world.net.edges.values()].some(e => e.kind === 'road')
  && old.sts.every(st => st.roadAccess && readWalkingCatchment(g, st).buildings.size > 0)
  && far.roadAccess && readWalkingCatchment(g, far).buildings.size > 0,
  'fixed existing service has actual road access and walking residents');
const p = plan(g, 2, 180, 248);
check(p.roadAccess && planWalkingCatchment(g, p).buildings.size > 0,
  'future station has actual surveyed access and native resident walking claims');
const literalWalk = planWalkingCatchment(g, p, p.links), automaticWalk = planWalkingCatchment(g, p);
const publicResidents = [...readWalkingCatchment(g, old.sts[0]).buildings.keys()]
  .filter(id => automaticWalk.buildings.has(id) && !literalWalk.buildings.has(id));
check(publicResidents.length > 0, 'actual public passage adds genuine existing resident walks beyond the literal preview');
check(!p.links.some(st => st.owner === 1), 'native explicit plan contains no denied foreign operating facility');
const links = g.stations.prospectiveRailLinks(p);
check(links.some(st => st.id === old.sts[0].id), 'single future facility discovers native automatic foreign public passage');
check(!g.canUse(2, 1), 'public passage does not grant railway operating permission');
const stock = [M('lrv_b')], rule = consistRule(stock), length = stock[0].length + .1;
const group = g.stations.railTrackGroups(old.sts[0])[0], onward = old.sts[1].id;
const start = platformDepartureFrontiers(g, group.steps, 1, rule, length);
const route = (owner: number) => findRailRoute(g, [...start.forward, ...start.reverse], onward, owner, -1,
  15000, false, rule, true, { length, onward: old.sts[0].id });
check(route(1) !== null && route(2) === null,
  'existing railway remains routable for its owner and denied for prospective operator');

const resolution = forecastRailLinks(g, [p, far]), groups = prospectiveWalkGroups(g, [p, far], resolution);
check(groups.groups[0] === groups.native(old.sts[0].id), 'prospective population group uses the same public member');
const distance = Math.hypot(p.x - far.x, p.z - far.z);
const proposedStock = pickTrain(g.year, Math.min(p.length, far.rail!.length), distance * 1.3, 2);
check(proposedStock, 'native ordinary opening stock exists for the quoted platform lengths');
const service = (g.aiOf(2) as any).serviceYear(proposedStock, 2, distance, distance * 1.3);
const { headway, kmh } = service;
check(headway > 0 && kmh > 0 && Number.isFinite(headway + kmh), 'prospective timetable uses the unchanged native service estimator');
const context = (g.demand as any).forecastRoutes([p, far], kmh, headway, 2);
check(context.edges.get(-1)?.some((e: any) => e.line === WALK_LINE && e.to === old.sts[0].id),
  'passenger forecast graph includes the actual public walk before a paid background leg');
check(context.tables.get(-1)?.get(old.sts[1].id)?.line === WALK_LINE,
  'prospective journey to existing destination starts with public walk and retains existing paid line');
const quote = () => g.demand.forecastLine([p, far], 'mainline', kmh, headway, 2);
quote(); g.mail.forecastPops([p, far], headway); // Mandatory native catchment preparation precedes purity boundary.
const before = save(g), q = quote(), mail = g.mail.forecastPops([p, far], headway);
check(q.boardings > 0 && q.revenue > 0 && mail.some(pop => pop > 0), 'native passenger fares and mail claims remain positive');
assert.equal(save(g), before, 'passenger/mail/public-link query is full-save pure');
const output = g.stations.prospectiveRailLinks(p); output.length = 0;
assert.deepEqual(ids(g.stations.prospectiveRailLinks(p)), ids(links), 'returned arrays cannot poison another query');
check(true, 'pure query output is isolated');

// Original plan-object cardinality controls the whole query. Never guess two plans' construction order.
const other = plan(g, 2, 360, 248), duplicate = forecastRailLinks(g, [p, p, far]);
assert.deepEqual(ids(duplicate.get(p)!), ids(links));
for (const points of [[p, other], [other, p]]) {
  const batch = forecastRailLinks(g, points);
  for (const part of points) assert.deepEqual(ids(batch.get(part)!), ids(part.links));
  const literal = prospectiveWalkGroups(g, points, new Map(points.map(part => [part, part.links])));
  assert.deepEqual(prospectiveWalkGroups(g, points, batch).groups, literal.groups);
  // The batch fallback must reach every consumer, including mail's independent walking pass.
  const original = g.stations.prospectiveRailLinks;
  g.stations.prospectiveRailLinks = () => { throw new Error('ambiguous batch must not resolve a single future'); };
  try {
    g.mail.forecastPops(points, headway);
    g.demand.forecastLine(points, 'mainline', kmh, headway, 2);
  } finally { delete (g.stations as any).prospectiveRailLinks; }
  assert.equal(g.stations.prospectiveRailLinks, original);
}
check(true, 'same-object duplicate is supported; two distinct plans in either order retain all literal passages');

// A real street-stop join inherits the old road stops and public links. The replacement rail
// geometry must be used together with those retained members when checking the whole complex.
{
  const joinedWorld = deserialize(JSON.parse(joinedCheckpoint));
  assert.equal(save(joinedWorld), joinedCheckpoint, 'joined fixture is an independently detached exact cold copy');
  const addStop = (x: number, owner: number) => {
    const stop = joinedWorld.stations.planBusStop(x, 272, owner);
    check(stop.ok && !stop.join, `fixed native separate street stop ${x}/${owner}: ${stop.error ?? 'ok'}`);
    const id = joinedWorld.stations.nextId;
    assert.equal(joinedWorld.stations.commitBusStop(x, 272, owner), null);
    return joinedWorld.stations.get(id)!;
  };
  const joined = addStop(180, 2), neighbor = addStop(184, 1);
  assert.equal(joinedWorld.stations.link(joined.id, neighbor.id), null);
  const future = plan(joinedWorld, 2, 180, 264);
  check(future.join === joined && joined.stops.length > 0 && joined.links.includes(neighbor.id),
    'future railway genuinely joins a real stop with an existing public passage');
  const duplicatePlan = plan(joinedWorld, 2, 180, 264);
  for (const batch of [[future, duplicatePlan], [duplicatePlan, future]]) {
    const map = forecastRailLinks(joinedWorld, batch);
    for (const part of batch) assert.deepEqual(ids(map.get(part)!), ids(part.links));
  }
  const oldStops = plain(joined.stops), oldLinks = [...joined.links];
  const built = compareCommit(joinedWorld, 2, future, 'real stop join and inherited public membership');
  assert.equal(built.id, joined.id); assert.equal(plain(built.stops), oldStops);
  check(oldLinks.every(id => built.links.includes(id)), 'join retains every original stop and link');
  check(true, 'distinct native plans sharing a join identity retain literal batch fallback');
}

const inherited = [...(p.join?.links ?? [])], previewWalk = planWalkingCatchment(g, p);
const built = compareCommit(g, 2, p, 'real-road foreign public interchange'); refresh(g);
check(built.links.length > inherited.length && built.roadAccess && readWalkingCatchment(g, built).buildings.size > 0,
  'ordinary paid facility has the advertised public complex and real resident access');
check(publicResidents.every(id => readWalkingCatchment(g, built).buildings.has(id)),
  'paid native complex really reaches the residents added by its prospective public passage');
console.log(`native public interchange: cost=${p.cost}, walking=${walkingPopulation(g, previewWalk)}, boardings=${q.boardings}, revenue=${q.revenue}`);

// Replacement access estimates deliberately keep explicit passages. An old forecourt must not be borrowed.
const replacement = g.stations.planRail(built.x, built.z, built.rail!.angle, built.rail!.length, 2, 2,
  { mode: 'mainline', trackType: 'standard', style: 'none', ignoreStation: built.id });
check(replacement.ok, `native replacement quote: ${replacement.error ?? 'ok'}`);
const replacementBefore = save(g);
const literalReplacement = plain(planWalkingCatchment(g, replacement, replacement.links));
const originalResolver = g.stations.prospectiveRailLinks;
g.stations.prospectiveRailLinks = () => { throw new Error('literal replacement must not resolve a new facility'); };
try { assert.equal(plain(planWalkingCatchment(g, replacement, replacement.links)), literalReplacement); }
finally { delete (g.stations as any).prospectiveRailLinks; }
assert.equal(g.stations.prospectiveRailLinks, originalResolver);
assert.equal(save(g), replacementBefore);
check(true, 'replacement explicitly retains literal accepted access without borrowing a replaced facility');

// Zero-road source control: a public passage alone does not invent an origin walking isochrone.
{
  const { g: empty } = flat(2), line = cityLine(empty, 1, [180, 220], 256, 'west', 'tail', 2);
  empty.setAccessPolicy(1, 'auto-reject'); refresh(empty);
  const noRoad = plan(empty, 2, 180, 264), before = save(empty);
  check(!noRoad.roadAccess && planWalkingCatchment(empty, noRoad).buildings.size === 0,
    'literal no-access early return remains empty');
  const groups = prospectiveWalkGroups(empty, [noRoad]);
  check(groups.groups[0] === groups.native(line.sts[0].id),
    'public identity is retained even when its own walking catchment is empty');
  assert.equal(save(empty), before);
  compareCommit(empty, 2, noRoad, 'zero-road public passage');
}

// Native levels use the same geometry rules. Construction is paid on independent exact snapshots.
for (const level of ['ground', 'elevated', 'underground'] as const) {
  const { g: native } = flat(2);
  commit(native, 1, plan(native, 1, 200, 200));
  compareCommit(native, 2, plan(native, 2, 200, 208, level), `${level} public passage`);
}

// Two real stops on one paid street can become consecutive calls before the joined railway is
// committed. Their public rail passage must then be refused without erasing either physical stop.
{
  const { g: native } = flat(2), line = cityLine(native, 1, [180, 220], 256, 'west', 'tail', 2);
  check(build(native, free(native, 150, 264), free(native, 230, 264), roadOpts(2, 'street'), 'joined-stop street'),
    'native paid street supports the fixed consecutive-stop control');
  const id = native.stations.nextId;
  const ownStop = native.stations.planBusStop(180, 264, 2);
  check(ownStop.ok && !ownStop.join, 'new operator has its own physical street stop');
  assert.equal(native.stations.commitBusStop(180, 264, 2), null);
  const foreignStop = native.stations.planBusStop(184, 264, 1);
  check(foreignStop.ok && foreignStop.join?.id === line.sts[0].id, 'existing operator adds a real stop to its rail facility');
  assert.equal(native.stations.commitBusStop(184, 264, 1), null);
  const future = plan(native, 2, 180, 270);
  check(future.join?.id === id && native.stations.prospectiveRailLinks(future).includes(line.sts[0]),
    'before the line edit, native joined geometry physically admits the public passage');
  const calls = native.lines.create('road', 2); calls.stops = [id, line.sts[0].id]; native.lines.rebuild();
  check(native.stations.consecutiveStops(id, line.sts[0].id)
    && !native.stations.prospectiveRailLinks(future).includes(line.sts[0]),
    'new consecutive real street calls invalidate the pending automatic passage');
  compareCommit(native, 2, future, 'consecutive call revalidation at native commit');
}

// The original explicit-owned passage wins even when the foreign automatic candidate is closer.
// The two old stations cannot all share one compact automatic complex.
{
  const { g: native } = flat(2);
  const own = commit(native, 2, plan(native, 2, 200, 200));
  const foreign = commit(native, 1, plan(native, 1, 200, 214));
  const future = plan(native, 2, 200, 208);
  check(future.links.some(st => st === own) && !future.links.includes(foreign),
    'native preflight supplies the original owned manual passage');
  const preview = native.stations.prospectiveRailLinks(future);
  assert.deepEqual(ids(preview), [own.id]);
  const built = compareCommit(native, 2, future, 'owned manual before closer foreign automatic');
  check(native.stations.gap(built, foreign) < native.stations.gap(built, own)
    && !built.links.includes(foreign.id), 'all-member compactness prevents a later closer public link');
}

// Equal automatic distances retain the native station-ID tie; no owned passage precedes them.
{
  const { g: native } = flat(2);
  const first = commit(native, 1, plan(native, 1, 200, 200));
  const second = commit(native, 1, plan(native, 1, 200, 214));
  const future = plan(native, 2, 200, 207);
  assert.deepEqual(ids(native.stations.prospectiveRailLinks(future)), [first.id]);
  const built = compareCommit(native, 2, future, 'automatic gap and ID order');
  check(native.stations.gap(built, first) === native.stations.gap(built, second), 'fixed automatic candidates genuinely tie');
}

// A legacy directed passage is deliberately retained by current saves. An inbound-only member is
// not part of native complex(A)'s outgoing traversal; a preview must not silently symmetrize it.
{
  const { g: native } = flat(2);
  const inbound = commit(native, 1, plan(native, 1, 200, 192));
  const own = commit(native, 2, plan(native, 2, 200, 200));
  native.stations.unlink(inbound.id, own.id);
  assert.equal(native.stations.link(inbound.id, own.id), null);
  const oldSave = JSON.parse(save(native)) as ReturnType<typeof serialize>;
  const savedOwn = oldSave.stations.find((st: { id: number }) => st.id === own.id)!;
  savedOwn.links = []; // Historical JSON compatibility control, not a construction bypass.
  const legacy = deserialize(oldSave), a = legacy.stations.get(own.id)!;
  assert.deepEqual(legacy.stations.complex(a.id), [a.id]);
  assert(legacy.stations.complex(inbound.id).includes(a.id));
  const future = plan(legacy, 2, 200, 208);
  assert.deepEqual(ids(legacy.stations.prospectiveRailLinks(future)), [a.id]);
  compareCommit(legacy, 2, future, 'asymmetric legacy outgoing membership');
}

// The established native retained-curve geometry, with one fixed companion eight units normal
// to its surveyed centre. The proposed platforms retain their actual arc, rather than a tangent box.
{
  const { g: native } = flat(2), net = native.world.net;
  const curve: Bez = { x0: 70, z0: 70, x1: 70, z1: 100, x2: 100, z2: 130, x3: 130, z3: 130 };
  const ad = bezDeriv(curve, 0), bd = bezDeriv(curve, 1);
  const a = net.addNode('rail', curve.x0, 4.1, curve.z0, ad.x, ad.z, 1);
  const b = net.addNode('rail', curve.x3, 4.1, curve.z3, bd.x, bd.z, 1);
  const edge = net.addEdge('rail', a.id, b.id, curve, new Float32Array(300).fill(4.1), [], 'standard', 1);
  const survey = () => planStationOnTrack(native, edge.id, edge.len / 2,
    { length: 20, tracks: 1, reuseTrack: true, style: 'none' }, 2);
  const initial = survey(); check(initial.ok && initial.station?.alignment, `native curved preflight: ${initial.error ?? 'ok'}`);
  const centre = stationPose(initial.station!, 0, 0);
  const companionPlan = native.stations.planRail(centre.x + 8 * centre.fz, centre.z - 8 * centre.fx,
    initial.station!.angle, 10, 2, 1, { mode: 'mainline', trackType: 'standard', style: 'none' });
  check(companionPlan.ok, `fixed curved companion preflight: ${companionPlan.error ?? 'ok'}`);
  const companion = commit(native, 1, companionPlan), quoted = survey();
  check(quoted.ok && quoted.station?.alignment, `native curved resurvey: ${quoted.error ?? 'ok'}`);
  const before = save(native), expected = ids(native.stations.prospectiveRailLinks(quoted.station!));
  check(expected.includes(companion.id), 'actual bent platform admits its fixed public companion');
  assert.equal(save(native), before);
  const cash = native.company(2).economy.money, built = commitStationOnTrack(native, quoted);
  assert.equal(built.error, null);
  const st = native.stations.get(built.station)!;
  assert.deepEqual(st.links, expected);
  assert.equal(cash - native.company(2).economy.money, quoted.cost);
  const mid = stationPose(st.rail!, 0, 0), end = stationPose(st.rail!, 0, st.rail!.length / 2);
  check(Math.abs((end.x - mid.x) * mid.fz - (end.z - mid.z) * mid.fx) > .2,
    'paid public link uses substantial retained curvature and exact native facility cost');
}

// The read adds no decision state: a cold save and its warm original continue identically.
refresh(g);
const twin = deserialize(JSON.parse(save(g)));
assert.equal(save(twin), save(g), 'raw JSON cold round trip is exact before native continuation');
for (let i = 0; i < 128; i++) {
  g.stepTick(); twin.stepTick();
  assert.equal(save(g), save(twin), `exact native continuation tick ${i + 1}`);
}
check(true, '128 native ticks preserve exact warm/cold continuation');
console.log(`ALL CHECKS PASSED (${checks})`);
