// End-to-end line joining: through trains and passengers, retained short-turns, operators, access,
// disconnected platforms, vehicle compatibility, route identity/numbering, redirects and exact saves.
// Bundle into the task scratchpad with esbuild --bundle --platform=node --format=esm, then run with node.
import { Game, PLAYER } from '../src/game/game';
import type { Line } from '../src/game/lines';
import type { Station } from '../src/game/stations';
import { outAndBack } from '../src/game/lines';
import { Train, findRailRoute, railNext, lineCompatibility } from '../src/game/train';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { connectStationThroat } from '../src/game/trackops';
import { serialize, deserialize } from '../src/game/save';
import { fareFor, simNow } from '../src/game/fares';
import { bezLine } from '../src/game/geom';
import {
  canJoinLines, joinLines, lineRoute, linePatterns, patternStops, boards,
  addPattern, canonicalizeLines, setVehiclePattern,
} from '../src/game/patterns';
import { check, fmt, station, endNode, depotFor, nodeSnap, build, railOpts, done } from './stationlib';
import { connectDouble, checkReservations, addBusStop } from './lib';

const M = (id: string) => MODEL_BY_ID.get(id)!;
const diesel = () => [M('diesel_b'), M('coach_ic')];
const json = (g: Game) => JSON.stringify(serialize(g));
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const stats = (l: Line) => [l.passMonth, l.passLast, l.incomeYear, l.incomeLast, l.costYear, l.costLast];
const served = (l: Line, pid?: number) => [...new Set(patternStops(l, pid).map((i) => l.stops[i]))];

function game(size = 384, companies = 2) {
  const g = Game.create({ size, seed: 7, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: companies });
  g.aiEnabled = false;
  g.vehicles.ambientEnabled = false;
  g.world.h.fill(4);
  g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  return g;
}

function railStation(g: Game, x: number, owner = PLAYER, tracks = 2, opts: Parameters<typeof station>[7] = {}) {
  const st = station(g, x, 192, Math.PI / 2, 12, tracks, owner, opts);
  if (!st) throw new Error(`Could not build station at ${x}`);
  st.name = 'Station ' + x;
  return st;
}

function train(g: Game, dp: number, l: Line, model = diesel()) {
  const t = g.vehicles.buyTrain(dp, model, l.id);
  if (!(t instanceof Train)) throw new Error('buyTrain: ' + t);
  return t;
}

function exactSave(g: Game, label: string) {
  const before = json(g), loaded = deserialize(JSON.parse(before)), after = json(loaded);
  if (before !== after) {
    let i = 0;
    while (before[i] === after[i] && i < before.length) i++;
    console.log(`  ${label}: save differs at ${i}: ${before.slice(i - 80, i + 100)} vs ${after.slice(i - 80, i + 100)}`);
  }
  check(before === after, label + ': exact save/load');
  return loaded;
}

function run(g: Game, days: number, tick?: () => void) {
  const until = g.day + days;
  while (g.day < until) { g.update(0.25); tick?.(); }
}

console.log('own lines, through services and passengers');
{
  const g = game();
  const A = railStation(g, 40), W = railStation(g, 140), J = railStation(g, 240, PLAYER, 2, { through: 1 }), E = railStation(g, 340);
  A.name = 'Thornthorpe'; W.name = 'Westfield'; J.name = 'Lockworth'; E.name = 'Rockton';
  for (const [a, b] of [[A, W], [W, J], [J, E]]) {
    const connection = connectDouble(g, a, b, PLAYER, () => {});
    // With spare through tracks, check the running tracks and signals built by this helper.
    check(connection.len > 0 && connection.signals >= 2, `${a.name} – ${b.name}: double track built`);
  }
  // The two platform paths used below connect directly; through tracks remain available for passing.
  check(J.rail!.throughEdges.length > 0, 'junction has through tracks as well as platforms');
  const dpA = depotFor(g, A, W), dpE = depotFor(g, E, J);
  check(dpA >= 0 && dpE >= 0, 'depots at both ends');
  // The shorter line is older, and reversed; the longer line must nevertheless survive.
  const east = g.lines.create('rail', PLAYER), west = g.lines.create('rail', PLAYER);
  east.stops = [E.id, J.id];
  west.stops = outAndBack([A.id, W.id, J.id]);
  const rapid = addPattern(g, west.id, 'rapid', west.stops.map((s) => s !== W.id))!;
  const tw = train(g, dpA, west), tr = train(g, dpA, west), te = train(g, dpE, east);
  setVehiclePattern(g, tr.id, rapid.id);
  // An older removed id already points to the line we are about to join.
  const alias = g.lines.create('rail', PLAYER);
  alias.stops = [J.id, E.id];
  check(canonicalizeLines(g, alias.id).length === 1 && g.lines.get(alias.id) === east, 'existing service alias before the join');
  g.lines.rebuild();
  g.update(0.25);
  const originalHop = g.lines.nextHop(A.id, E.id);
  check(originalHop?.alight === J.id, 'before joining, the trip to Rockton changes at Lockworth');
  const identity = { id: west.id, owner: west.owner, name: west.name, code: west.code, color: west.color, num: west.num, autoName: west.autoName };
  const oldNumbers = [...west.numbers!];
  Object.assign(west, { passMonth: 3, passLast: 7, incomeYear: 11, incomeLast: 13, costYear: 17, costLast: 19 });
  Object.assign(east, { passMonth: 23, passLast: 29, incomeYear: 31, incomeLast: 37, costYear: 41, costLast: 43 });
  const combined = stats(west).map((n, i) => n + stats(east)[i]);
  g.stations.addWaiting(E, east.id, J.id, J.id, 7, 0, 3, 2);
  tw.stopIndex = 3; // return call at Westfield: preserve its direction when remapping indices.
  const before = json(g), version = g.lines.version;
  const preview = canJoinLines(g, west, east), reversedPreview = canJoinLines(g, east.id, west.id);
  check(preview.ok && preview.junction === J.id && equal(preview, reversedPreview), 'join preview finds the shared terminus regardless of argument order');
  check(preview.ok && equal(preview.route, [A.id, W.id, J.id, E.id]), 'preview joins the routes, with the junction once');
  check(json(g) === before && g.lines.version === version, 'repeated previews leave all saved state and routing versions unchanged');
  const result = joinLines(g, east.id, west.id);
  if (typeof result === 'string') throw new Error(result);
  const joined = result.line;
  check(result.into === west.id && result.from === east.id && g.lines.all().length === 1, 'longer line survives, shorter older line removed');
  check(equal({ id: joined.id, owner: joined.owner, name: joined.name, code: joined.code, color: joined.color, num: joined.num, autoName: joined.autoName }, identity), 'survivor keeps its owner, name, code, colour, line number and automatic naming state');
  check(equal(lineRoute(joined).stations, [A.id, W.id, J.id, E.id]) && joined.loop === false, 'one end-to-end route, with return calls for out-and-back operation');
  check(equal(stats(joined), combined), 'all current and previous passenger/income/cost totals combined');
  check(oldNumbers.every(([sid, n]) => joined.numbers!.some(([s, m]) => s === sid && m === n)) && joined.numbers!.find(([s]) => s === E.id)![1] === 4, 'survivor station numbers kept and continued eastward');
  check(tw.stopIndex === 5 && joined.stops[tw.stopIndex] === W.id, 'return-direction call index preserved');
  check([tw, tr, te].every((t) => t.lineId === joined.id && t.owner === PLAYER && t.pattern !== undefined), 'old trains keep their owner and receive explicit patterns');
  check(equal(served(joined, tw.pattern), [A.id, W.id, J.id]) && equal(served(joined, tr.pattern), [A.id, J.id]) && equal(served(joined, te.pattern), [J.id, E.id]), 'local, rapid and reversed east-side services retain precisely their old stops');
  const through = linePatterns(joined)[0];
  check(through.stops.every(Boolean) && ![tw, tr, te].some((t) => t.pattern === through.id), 'all-through local is first; existing trains stay on short-turns');
  check(g.lines.get(east.id) === joined && g.lines.get(alias.id) === joined && g.lines.redirect.get(alias.id)?.pattern === te.pattern, 'removed id and its earlier aliases point to the matching short-turn');
  const waiting = [...E.waiting.values()];
  check(waiting.length === 1 && waiting[0].line === joined.id && waiting[0].t === 3 && waiting[0].transfers === 2 && waiting[0].count === 7, 'waiting group redirects with its time, count and transfer history');
  check(g.news.some((n) => n.text === result.text && n.x === J.x && n.z === J.z), 'join notice appears in news at the junction');
  exactSave(g, 'immediately after joining');
  // New purchases use the all-through pattern; assigning a removed id still means its historical service.
  const tt = train(g, dpA, joined);
  check(tt.pattern === undefined && equal(served(joined, tt.pattern), [A.id, W.id, J.id, E.id]), 'new train defaults to the entire through route');
  const hop = g.lines.nextHop(A.id, E.id);
  check(hop?.line === joined.id && hop.alight === E.id, 'passenger routing offers Rockton directly, without a transfer');
  check(!boards(g, joined, tw.pattern, 0, A.id, E.id) && boards(g, joined, tt.pattern, 0, A.id, E.id), 'through passengers board the through train and skip the short-turn');
  const seen = new Map<number, Set<number>>(), visits = new Map<number, number>(), prev = new Map<number, string>();
  let boarded = false, stayedAtJunction = false, delivered = false, income = 0, expected = 0;
  let count = 0, t0 = 0, transfers = -1;
  g.listeners.income.push((amount, v, st) => {
    if (v.id !== tt.id || st.id !== E.id || delivered) return;
    income = amount;
    expected = fareFor(Math.hypot(E.x - A.x, E.z - A.z), simNow(g) - t0, count);
    delivered = true;
  });
  run(g, 400, () => {
    for (const t of [tw, tr, te, tt]) {
      if (t.state === 'loading' && prev.get(t.id) !== 'loading') {
        const stations = seen.get(t.id) ?? new Set<number>(); stations.add(t.atStation); seen.set(t.id, stations);
        visits.set(t.id, (visits.get(t.id) ?? 0) + 1);
        if (t === tt && t.atStation === A.id && !boarded) {
          // Queue at an actual call, then use normal boarding; avoid synthetic zero-population queue trimming.
          g.stations.addWaiting(A, hop!.line, hop!.alight, E.id, 10);
          tt.serveStation(A, 0.03);
          const c = [...tt.cargo.values()].find((c) => c.dest === E.id)!;
          if (!c) throw new Error('Through passengers did not board');
          count = c.count; t0 = c.t0!; transfers = c.transfers ?? 0; boarded = true;
        }
        if (t === tt && t.atStation === J.id && boarded && !delivered) {
          stayedAtJunction = tt.cargo.size > 0 && tt.load === count && [...tt.cargo.values()].every((c) => c.alight === E.id && !c.transfers);
        }
      }
      prev.set(t.id, t.state);
    }
  });
  console.log(`  calls: ${[tw, tr, te, tt].map((t) => visits.get(t.id) ?? 0).join('/')} · direct fare ${fmt(income, 2)} (expected ${fmt(expected, 2)})`);
  check([tw, tr, te, tt].every((t) => (visits.get(t.id) ?? 0) >= 6), 'every old service and the through train keeps running');
  check(equal([...seen.get(tw.id)!].sort(), [A.id, W.id, J.id].sort()) && equal([...seen.get(tr.id)!].sort(), [A.id, J.id].sort()) && equal([...seen.get(te.id)!].sort(), [J.id, E.id].sort()), 'actual old trains turn at their old termini and retain their local/rapid calls');
  check(seen.get(tt.id)?.size === 4 && seen.get(tt.id)?.has(E.id), 'through train actually runs from Thornthorpe to Rockton');
  check(boarded && stayedAtJunction && delivered && transfers === 0 && tt.delivered === count, 'passengers stay aboard at Lockworth and reach Rockton without changing');
  check(expected > 0 && Math.abs(income - expected) < 1e-6, 'actual direct fare is the full fare (no change of vehicle, no transfer reduction)');
  check(checkReservations(g).length === 0, 'reservations remain consistent after joining and running');
  const loaded = exactSave(g, 'running joined services');
  const state = (x: Game) => JSON.stringify({ lines: x.lines.all(), redirects: [...x.lines.redirect], money: x.companies.map((c) => c.economy.money), vehicles: x.vehicles.all().map((v) => [v.lineId, v.pattern, v.stopIndex, v.state, v.delivered, v.load]) });
  for (let i = 0; i < 60 * 8; i++) { g.update(0.25); loaded.update(0.25); }
  check(state(g) === state(loaded), 'original and loaded joined services continue identically for 60 days');
}

console.log('cross-company join, access and numbering');
{
  const g = game();
  const A = railStation(g, 60), J = railStation(g, 180), B = railStation(g, 300, 1);
  check(connectDouble(g, A, J, PLAYER, () => {}).ok && connectDouble(g, J, B, 1, () => {}).ok, 'two companies connect through the junction');
  const left = g.lines.create('rail', PLAYER), right = g.lines.create('rail', 1);
  left.stops = [A.id, J.id]; right.stops = [B.id, J.id];
  const ta = train(g, depotFor(g, A, J), left), tb = train(g, depotFor(g, B, J, 1), right);
  g.setAccessPolicy(PLAYER, 'open'); g.setAccessPolicy(1, 'open');
  g.lines.rebuild(); g.update(0.25);
  const noStation = g.lines.create('rail', 2); noStation.stops = [J.id, B.id];
  const ownership = canJoinLines(g, left, noStation);
  check(!ownership.ok && /needs its own station/.test(ownership.reason), 'a company without a station on the joined line cannot become an operator');
  g.lines.delete(noStation.id);
  const code = left.code, numbers = [...left.numbers!];
  check(canJoinLines(g, left, right).ok, 'open access permits a cross-company join');
  const result = joinLines(g, left, right);
  if (typeof result === 'string') throw new Error(result);
  check(result.line === left && left.operators?.includes(1) && g.lines.canOperate(left, 1), 'other company becomes an operator of the older surviving line');
  check(ta.owner === PLAYER && tb.owner === 1 && tb.lineId === left.id, 'both trains retain their owners');
  const stationCode = g.lines.stationCode(left.id, B.id);
  check(left.code === code && stationCode === g.company(1).code + code! + '03' && numbers.every(([s, n]) => left.numbers!.some(([sid, num]) => s === sid && num === n)), 'foreign station continues the survivor route letter and numbers with its company letter');
  const through = train(g, ta.depotId, left);
  const calls = new Set<number>();
  run(g, 200, () => { if (through.state === 'loading') calls.add(through.atStation); });
  check(calls.size === 3 && checkReservations(g).length === 0, 'through train serves both companies without losing track continuity');
  exactSave(g, 'cross-company operators and patterns');
  // The shorter west extension joins the start of a longer east line: renumber in route order.
  const h = game();
  const S = [40, 140, 240, 340].map((x) => railStation(h, x));
  for (let i = 0; i < 3; i++) check(connectDouble(h, S[i], S[i + 1], PLAYER, () => {}).ok, 'extension track built');
  const east = h.lines.create('rail'), west = h.lines.create('rail');
  east.stops = outAndBack([S[1].id, S[2].id, S[3].id]); west.stops = [S[0].id, S[1].id];
  h.lines.rebuild();
  const n = joinLines(h, west, east, { notify: false });
  check(typeof n !== 'string' && n.line === east && equal(east.numbers, S.map((s, i) => [s.id, i + 1])), 'a join extending the start renumbers in the complete route order');
  h.lines.rename(east.id, '');
  check(east.joinedName === undefined && east.autoName && east.name === h.lines.autoNameOf(east), 'resetting the automatic name uses the full joined route');
}

console.log('through running with a platform reversal');
{
  const g = game(), net = g.world.net;
  const A = station(g, 60, 128, Math.PI / 2, 12, 1)!, J = station(g, 300, 192, Math.PI / 2, 12, 1)!, B = station(g, 60, 256, Math.PI / 2, 12, 1)!;
  // Both branches enter the back of the same platform. Its front is a buffer stop: through service must
  // reverse at the platform, rather than treat the two independently reachable station pairs as enough.
  for (const st of [A, B]) {
    const a = net.nodes.get(endNode(g, st, 0, true))!, b = net.nodes.get(endNode(g, J, 0, false))!;
    const length = Math.hypot(b.x - a.x, b.z - a.z);
    net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(length) + 1).fill(4), [], 'standard', PLAYER);
  }
  g.onNetworkChanged();
  const left = g.lines.create('rail'), right = g.lines.create('rail');
  left.stops = [A.id, J.id]; right.stops = [B.id, J.id];
  g.lines.rebuild();
  check(canJoinLines(g, left, right).ok, 'a reversal at the shared platform is an acceptable continuation');
  const result = joinLines(g, left, right);
  if (typeof result === 'string') throw new Error(result);
  const t = train(g, depotFor(g, A, J), result.line);
  const seen = new Set<number>();
  let previousState = '', previousStation = -1, previousReversed = t.reversed, reversals = 0;
  run(g, 400, () => {
    if (t.state === 'loading') seen.add(t.atStation);
    if (previousState === 'loading' && previousStation === J.id && t.state !== 'loading' && previousReversed !== t.reversed) reversals++;
    previousState = t.state; previousStation = t.atStation; previousReversed = t.reversed;
  });
  check(seen.size === 3 && reversals >= 2, `through train reaches both branches and reverses at the shared platform (${reversals} reversals)`);
  check(checkReservations(g).length === 0, 'platform reversals retain consistent reservations');
}

console.log('refusals and disconnected platform tracks');
{
  const g = game();
  const A = railStation(g, 60), J = railStation(g, 180), B = railStation(g, 300);
  // Each side reaches a different platform at J; there is no crossover between them.
  check(!!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, J, 0, false), 'rail'), railOpts(), 'west'), 'west track built');
  check(!!build(g, nodeSnap(g, endNode(g, J, 1, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(), 'east'), 'east track built');
  const left = g.lines.create('rail'), right = g.lines.create('rail');
  left.stops = [A.id, J.id]; right.stops = [J.id, B.id];
  g.lines.rebuild();
  const reaches = (a: Station, b: Station) => a.rail!.edges.some((id) => [1, -1].some((dir) => !!findRailRoute(g, railNext(g, g.world.net.edges.get(id)!, dir, PLAYER), b.id, PLAYER, -1)));
  check(reaches(A, J) && reaches(J, B), 'each individual line has a route to its junction platform');
  const before = json(g), broken = canJoinLines(g, left, right), attempt = joinLines(g, left, right);
  check(!broken.ok && broken.junction === J.id && /continuity/.test(broken.reason) && typeof attempt === 'string', 'join refused when station id is shared but the track does not continue between its platforms');
  check(json(g) === before, 'refused join changes no saved state');
  connectStationThroat(g, J.id, PLAYER);
  check(canJoinLines(g, left, right).ok, 'joining becomes possible after the platform tracks are connected');
  const otherKind: Line = g.lines.create('road'); otherKind.stops = [J.id, B.id];
  const kind = canJoinLines(g, left, otherKind);
  check(!kind.ok && /Mode mismatch: rail, road or tram/.test(kind.reason), 'different kinds refused');
  const far = station(g, 300, 64, Math.PI / 2, 12, 1)!;
  const unrelated = g.lines.create('rail'); unrelated.stops = [B.id, far.id];
  const middle = g.lines.create('rail'); middle.stops = outAndBack([A.id, J.id, B.id]);
  const interior = canJoinLines(g, right, middle), notEnds = canJoinLines(g, left, unrelated);
  check(!notEnds.ok && /No shared terminus/.test(notEnds.reason), 'no shared terminus refused');
  unrelated.stops = [A.id];
  check(!canJoinLines(g, left, unrelated).ok && !interior.ok && /overlap/.test(interior.reason), 'missing routes and a shared interior section are refused');
  right.loop = true;
  check(!canJoinLines(g, left, right).ok, 'explicit loop has no terminus to join');
  right.loop = false;
  const dp = depotFor(g, A, J);
  for (const e of g.world.net.edges.values()) if (e.kind === 'rail') e.type = 'electric';
  const t = train(g, dp, left, [M('emu_a')]);
  const eastern = [...g.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.station < 0 && e.depot < 0 && (e.bez.x0 + e.bez.x3) / 2 > J.x + 5);
  const types = eastern.map((e) => e.type);
  check(eastern.length > 0, 'east-side track available for compatibility test');
  eastern.forEach((e) => { e.type = 'standard'; });
  check(lineCompatibility(g, left.id, t.cars) === null, 'electric train is compatible with its original section');
  const incompatible = canJoinLines(g, left, right);
  console.log(`  incompatible preview: ${incompatible.ok ? 'allowed' : incompatible.reason}`);
  check(!incompatible.ok && /track|cannot run/.test(incompatible.reason), 'join refused when an existing train cannot run over the other section');
  eastern.forEach((e, i) => { e.type = types[i]; });
  right.owner = 1; B.owner = 1;
  g.setAccessPolicy(1, 'auto-reject'); g.setAccessPolicy(PLAYER, 'open');
  const denied = canJoinLines(g, left, right);
  check(!denied.ok && /access/.test(denied.reason), 'cross-company join refused without access to both sections');
}

console.log('roads and tram tracks');
for (const kind of ['road', 'tram'] as const) {
  const g = game(), net = g.world.net;
  const nodes = [40, 120, 220, 300].map((x) => net.addNode('road', x, 4, 192));
  const edges = nodes.slice(1).map((b, i) => {
    const a = nodes[i], d = b.x - a.x;
    return net.addEdge('road', a.id, b.id, { x0: a.x, z0: a.z, x1: a.x + d / 3, z1: a.z, x2: b.x - d / 3, z2: b.z, x3: b.x, z3: b.z }, new Float32Array(Math.ceil(d) + 1).fill(4), [], 'road', PLAYER, kind === 'tram' ? { tram: true, tramOwner: PLAYER } : {});
  });
  const S = [70, 170, 270].map((x) => g.stations.get(addBusStop(g, x, 192, PLAYER))!);
  if (S.some((s) => !s)) throw new Error('Could not build road stops');
  const a = g.lines.create(kind), b = g.lines.create(kind);
  a.stops = [S[1].id, S[0].id]; b.stops = [S[2].id, S[1].id];
  g.lines.rebuild();
  if (kind === 'tram') {
    edges[1].tram = false;
    check(!canJoinLines(g, a, b).ok, 'tram join needs usable tram tracks through the junction');
    edges[1].tram = true;
  }
  const preview = canJoinLines(g, a, b);
  check(preview.ok, `${kind}: two connected sections can join`);
  const result = joinLines(g, a, b);
  check(typeof result !== 'string' && result.line === a && equal(lineRoute(a).stations, [...S].reverse().map((s) => s.id)) && linePatterns(a).length === 3, `${kind}: stop lists orient end-to-end and old sections become patterns`);
  g.update(0.25);
  exactSave(g, kind + ' joined line');
}

done();
