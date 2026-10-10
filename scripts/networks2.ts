// Connected networks (2.10): lines join only straight through (no reversal or U-turn where they meet; the AI splits its
// older reversing joins), big cities make more inter-city trips per resident (demand.ts BIG_CITY), new railways stop
// beside the company's station in a town, and two lines ending at separate stations of one town get shared platforms
// in staged works (ai-hub.ts) with trains running throughout and an exact replay of a save during the works.
// npx esbuild scripts/networks2.ts --bundle --platform=node --format=esm --outfile=$S/networks2.mjs && node $S/networks2.mjs [section]
import '../src/game/patterns';
import { Game } from '../src/game/game';
import type { AIController } from '../src/game/ai';
import { aiStationSiteGen } from '../src/game/ai';
import type { Station } from '../src/game/stations';
import type { Town } from '../src/game/towns';
import type { Line } from '../src/game/lines';
import { outAndBack } from '../src/game/lines';
import { Train } from '../src/game/train';
import { MODELS } from '../src/game/vehicle-types';
import { serialize, deserialize } from '../src/game/save';
import { canJoinLines, joinLines, lineReversal, lineRoute, addPattern, setVehiclePattern } from '../src/game/patterns';
import { BIG_CITY, plannedSet } from '../src/game/demand';
import { runNetworkTask, stepNetworkTask, networkItem, networkProfile } from '../src/game/ai-network';
import { hubOptions, hubProfile } from '../src/game/ai-hub';
import { nodeSnap, runGen, findRailPair, stationEnds as SE } from '../src/game/routing';
import { bezLine } from '../src/game/geom';
import { fails, check, fmt, build, free, roadOpts, nodeNear, addBusStop, checkReservations } from './lib';
import { station, endNode, depotFor, loco } from './stationlib';

if (!import.meta.url.endsWith('/networks2.mjs')) throw new Error('bundle this test as networks2.mjs');
const only = process.argv[2];
const json = (g: Game) => JSON.stringify(serialize(g));

/**
 * A flat empty game with one AI company whose daily management is off: its network tasks run only as the test says
 * (runNetworkTask, stepNetworkTask), so a line without passengers is not cut meanwhile.
 */
function aiFlat(size = 256): { g: Game; ai: AIController; me: number } {
  const g = Game.create({ size, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990, aiCompanies: 1 });
  const w = g.world;
  for (let z = 0; z <= w.size; z++) for (let x = 0; x <= w.size; x++) w.h[w.vi(x, z)] = 3;
  w.heightsVersion++;
  for (let i = 0; i < w.trees.length; i++) if (w.trees[i]) w.removeTreesNear(w.trees[i]!.x, w.trees[i]!.z, 0.1);
  for (const id of [...w.buildings.keys()]) w.removeBuilding(id);
  g.aiAcquisitions = false;
  g.aiEnabled = false;
  g.vehicles.ambientEnabled = false;
  const ai = g.ais[0], me = ai.companyId;
  g.company(me).economy.money = 200_000_000;
  ai.state.cooldown = 1e9;
  return { g, ai, me };
}
function fixtureTown(g: Game, x: number, z: number, pop = 3000, radius = 50): Town {
  const t: Town = { id: g.towns.list.length, name: 'Town ' + g.towns.list.length, x, z, angle: 0, pop, radius, buildings: new Set(),
    nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  return t;
}
/** A line of the company through these stations with `trains` trains from a depot behind `home`. */
function railLine(g: Game, me: number, stops: Station[], home: Station, toward: Station, trains = 1): Line {
  const l = g.lines.create('rail', me);
  l.stops = outAndBack(stops.map((s) => s.id));
  g.lines.rebuild();
  const dep = depotFor(g, home, toward, me);
  check(dep >= 0, 'fixture: depot for ' + l.name);
  for (let i = 0; i < trains; i++) check(typeof g.vehicles.buyTrain(dep, loco(), l.id) !== 'string', 'fixture: train bought');
  return l;
}
function run(g: Game, days: number, each?: () => void) {
  const end = g.day + days;
  while (g.day < end) { g.update(0.25); each?.(); }
}
/** Calls (station ids) each train makes while the game runs. */
function calls(g: Game, ts: Train[]) {
  const seen = new Map<number, Set<number>>(), prev = new Map<number, string>();
  return {
    tick() { for (const t of ts) { if (t.state === 'loading' && prev.get(t.id) !== 'loading') { const s = seen.get(t.id) ?? new Set(); s.add(t.atStation); seen.set(t.id, s); } prev.set(t.id, t.state); } },
    of(t: Train) { return seen.get(t.id) ?? new Set<number>(); },
  };
}
function exactReplay(g: Game, days: number, label: string) {
  const before = json(g), loaded = deserialize(JSON.parse(before));
  check(json(loaded) === before, `${label}: save round trip`);
  for (let i = 0; i < days * 8; i++) { g.update(0.25); loaded.update(0.25); }
  const a = json(g), b = json(loaded);
  if (a !== b) { let i = 0; while (a[i] === b[i]) i++; console.log(`  ${label}: replay differs at ${i}: ${a.slice(i - 100, i + 100)} | ${b.slice(i - 100, i + 100)}`); }
  check(a === b, `${label}: original and loaded game continue identically for ${days} days`);
  return loaded;
}

// ------------------------------------------------------------------------------------------------ join rules
function joinRules() {
  console.log('join: lines become one only straight through');
  // rail: one station between two lines from opposite sides joins; two branches into the back of one stub platform do not
  {
    const { g, me } = aiFlat();
    const net = g.world.net;
    const A = station(g, 40, 128, Math.PI / 2, 12, 1, me)!, J = station(g, 128, 128, Math.PI / 2, 12, 1, me)!, B = station(g, 216, 128, Math.PI / 2, 12, 1, me)!;
    for (const [p, q] of [[A, J], [J, B]]) {
      const a = net.nodes.get(endNode(g, p, 0, true))!, b = net.nodes.get(endNode(g, q, 0, false))!;
      net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)) + 1).fill(3), [], 'standard', me);
    }
    g.onNetworkChanged();
    const left = g.lines.create('rail', me), right = g.lines.create('rail', me);
    left.stops = [A.id, J.id]; right.stops = [J.id, B.id];
    g.lines.rebuild();
    const ok = canJoinLines(g, left, right);
    check(ok.ok, `rail: straight through a station is a join (${ok.ok ? 'ok' : ok.reason})`);
    const S = station(g, 40, 200, Math.PI / 2, 12, 1, me)!;
    const a = net.nodes.get(endNode(g, S, 0, true))!, b = net.nodes.get(endNode(g, J, 0, false))!;
    net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)) + 1).fill(3), [], 'standard', me);
    g.onNetworkChanged();
    const branch = g.lines.create('rail', me); branch.stops = [S.id, J.id];
    g.lines.rebuild();
    const no = canJoinLines(g, left, branch), before = json(g);
    check(!no.ok && /reverse/.test(no.reason), `rail: two lines entering one platform end are refused (${no.ok ? 'ok' : no.reason})`);
    check(typeof joinLines(g, left, branch) === 'string' && json(g) === before, 'rail: the refused join changes nothing');
  }
  // road: stops on one street join; a stop the bus must leave by turning back along the street it came does not
  {
    const { g, me } = aiFlat();
    const opts = roadOpts(-1, 'street', { town: true, straight: true });
    build(g, free(g, 30, 100), free(g, 230, 100), opts, 'main street');
    build(g, nodeSnap(g, nodeNear(g, 'road', 30, 100)!.id, 'road'), free(g, 30, 170), opts, 'side street');
    const S0 = g.stations.get(addBusStop(g, 80, 100, me))!, J = g.stations.get(addBusStop(g, 160, 100, me))!;
    const S2 = g.stations.get(addBusStop(g, 210, 100, me))!, N = g.stations.get(addBusStop(g, 30, 150, me))!;
    check(!!S0 && !!J && !!S2 && !!N, 'road: fixture stops');
    const a = g.lines.create('road', me), b = g.lines.create('road', me), c = g.lines.create('road', me);
    a.stops = [S0.id, J.id]; b.stops = [J.id, S2.id]; c.stops = [J.id, N.id];
    g.lines.rebuild();
    const ok = canJoinLines(g, a, b), no = canJoinLines(g, a, c);
    check(ok.ok, `road: straight along the street is a connection (${ok.ok ? 'ok' : ok.reason})`);
    check(!no.ok && /U-turn/.test(no.reason), `road: a U-turn back along the street is refused (${no.ok ? 'ok' : no.reason})`);
  }
}

// ------------------------------------------------------------------------------------------------ split
function splitChecks() {
  console.log('split: the AI splits its line that reverses at a station on the way');
  const { g, ai, me } = aiFlat();
  const net = g.world.net;
  const A = station(g, 60, 90, Math.PI / 2, 12, 1, me)!, J = station(g, 190, 128, Math.PI / 2, 12, 1, me)!, B = station(g, 60, 166, Math.PI / 2, 12, 1, me)!;
  for (const st of [A, B]) {
    const a = net.nodes.get(endNode(g, st, 0, true))!, b = net.nodes.get(endNode(g, J, 0, false))!;
    net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)) + 1).fill(3), [], 'standard', me);
  }
  g.onNetworkChanged();
  // the old join: one line A - J - B, its trains reversing at J
  const l = g.lines.create('rail', me);
  l.stops = outAndBack([A.id, J.id, B.id]);
  g.lines.rebuild();
  const dA = depotFor(g, A, J, me), dB = depotFor(g, B, J, me);
  const tA = g.vehicles.buyTrain(dA, loco(), l.id) as Train, tB = g.vehicles.buyTrain(dB, loco(), l.id) as Train;
  check(tA instanceof Train && tB instanceof Train, 'split: fixture trains');
  // (as joinLines left it: the old services as short turns, A - J and J - B)
  const west = addPattern(g, l.id, 'local', l.stops.map((s) => s !== B.id), 'A-J')!, east = addPattern(g, l.id, 'local', l.stops.map((s) => s !== A.id), 'J-B')!;
  setVehiclePattern(g, tA.id, west.id); setVehiclePattern(g, tB.id, east.id);
  (ai as unknown as { lines: Map<number, unknown> }).lines.set(l.id, { kind: 'rail', towns: [], depot: dA, maxVehicles: 2, opened: 0 });
  run(g, 60);
  const show = () => [tA, tB].map((t) => `${t.name} ${t.state} idx ${t.stopIndex} target ${g.stations.get(t.routeTarget)?.name ?? t.routeTarget} "${t.status}"`).join('; ');
  console.log(`  before: ${show()}`);
  check(lineReversal(g, l) === J.id, 'split: the line reverses at J');
  networkProfile.decisions = {};
  runNetworkTask(ai, 'join');
  const lines = g.lines.all().filter((x) => x.owner === me && x.kind === 'rail');
  console.log(`  join task: ${Object.entries(networkProfile.decisions).map(([k, v]) => `${k} ${v}`).join(', ')}; ${ai.log.slice(-2).join(' | ')}`);
  const routes = lines.map((x) => lineRoute(x).stations.slice().sort((p, q) => p - q).join(','));
  console.log(`  lines: ${lines.map((x) => `${x.name} [${lineRoute(x).stations.map((s) => g.stations.get(s)?.name).join(' - ')}] ${x.vehicles.length} trains`).join('; ')}`);
  check(lines.length === 2 && routes.includes([A.id, J.id].sort((p, q) => p - q).join(',')) && routes.includes([J.id, B.id].sort((p, q) => p - q).join(',')), 'split: two lines meeting at J');
  check(lines.every((x) => x.vehicles.length === 1) && tA.lineId !== tB.lineId, 'split: each train keeps running on its half');
  check(!!(ai as unknown as { lines: Map<number, unknown> }).lines.get(lines.find((x) => x.id !== l.id)!.id), 'split: the new line is managed like the old one');
  console.log(`  after: ${show()}`);
  const c = calls(g, [tA, tB]);
  run(g, 240, () => c.tick());
  console.log(`  later: ${show()}`);
  check(c.of(tA).size === 2 && c.of(tB).size === 2, `split: both trains serve both stations of their line (${[...c.of(tA)]}/${[...c.of(tB)]})`);
  check(checkReservations(g).length === 0, 'split: reservations consistent');
  runNetworkTask(ai, 'join');
  check(g.lines.all().filter((x) => x.owner === me).length === 2, 'split: no join back');
  exactReplay(g, 40, 'split');
}

// ------------------------------------------------------------------------------------------------ big cities
function bigCityChecks() {
  console.log('big cities: more inter-city trips per resident than small towns');
  const f = (p: number) => BIG_CITY.factor(p);
  check(f(0) === 1 && f(1000) < 1.01 && f(2000) < 1.01 && f(3000) < 1.03, `small towns about unchanged (${fmt(f(1000), 3)} at 1,000, ${fmt(f(3000), 3)} at 3,000)`);
  check(f(5000) > 1.2 && f(8000) > 1.5 && f(8000) < 2 && f(1e6) <= BIG_CITY.max, `big cities more (${fmt(f(5000), 2)} at 5,000, ${fmt(f(8000), 2)} at 8,000)`);
  let smooth = true;
  for (let p = 0; p < 20000; p += 50) { const a = f(p), b = f(p + 50); if (b < a || b - a > 0.02) smooth = false; }
  check(smooth, 'the factor rises smoothly with size');
  for (const seed of [1, 2]) {
    const g = Game.create({ size: 768, seed, towns: 13, hilliness: 'hilly', water: 'medium', startYear: 1950, aiCompanies: 0 });
    const D = g.demand; if (!D.regions.length) D.rebuild();
    const R = D.regions, n = R.length, towns = g.towns.list;
    const res = (t: number) => R.filter((r) => r.town === t).reduce((s, r) => s + r.pop, 0);
    const byTown = (t: number) => { let ic = 0; for (let r = 0; r < n; r++) if (R[r].town === t) for (let q = 0; q < n; q++) ic += D.trips(r, q, 'intercity'); return ic; };
    const sorted = towns.map((t) => t.id).sort((a, b) => res(b) - res(a));
    const big = sorted.slice(0, 2), small = sorted.filter((t) => res(t) < 1500).slice(0, 3);
    // (two small towns as far apart as the two big ones, for the railway comparison)
    const dist = (a: number, b: number) => Math.hypot(towns[a].x - towns[b].x, towns[a].z - towns[b].z), dBig = dist(big[0], big[1]);
    const smalls = sorted.filter((t) => res(t) < 1500);
    let pairS: number[] = [];
    for (const a of smalls) for (const b of smalls) if (a < b && dist(a, b) > 120 && (!pairS.length || Math.abs(dist(a, b) - dBig) < Math.abs(dist(pairS[0], pairS[1]) - dBig))) pairS = [a, b];
    const now = sorted.map((t) => byTown(t) / Math.max(1, res(t)));
    const exp = BIG_CITY.exp;
    BIG_CITY.exp = 0; D.rebuild();
    const base = sorted.map((t) => byTown(t) / Math.max(1, res(t)));
    BIG_CITY.exp = exp; D.rebuild();
    const ratio = (i: number) => now[i] / Math.max(1e-9, base[i]);
    const bigR = [0, 1].map(ratio), smallR = small.map((t) => ratio(sorted.indexOf(t)));
    console.log(`  seed ${seed}: inter-city trips per resident, now / without: big ${big.map((t, i) => `${towns[t].name} ${Math.round(res(t))} x${fmt(bigR[i], 2)}`).join(', ')}; small ${small.map((t, i) => `${towns[t].name} ${Math.round(res(t))} x${fmt(smallR[i], 3)}`).join(', ')}`);
    const mean = smallR.reduce((a, x) => a + x, 0) / smallR.length;
    check(bigR[0] >= 1.03 && bigR[0] > Math.max(...smallR) && mean <= 1.04 && Math.max(...smallR) <= 1.06, `seed ${seed}: the biggest city gains most, small towns little (mean x${fmt(mean, 3)})`);
    check(now[0] > base[0] && now[0] / Math.max(...small.map((t) => now[sorted.indexOf(t)])) > base[0] / Math.max(...small.map((t) => base[sorted.indexOf(t)])), `seed ${seed}: the biggest city's inter-city rate per resident rises against the small towns'`);
    // a railway between the two biggest towns earns more; one between two small towns about the same
    const forecast = (pair: Town[]) => {
      // (long platforms: the queue a stop holds between trains does not cap the forecast)
      const pr = findRailPair(g, pair[0], pair[1], { tracks: 4, length: 24, owner: 0, front: 22 });
      if (!pr) return null;
      const pts = [pr.a, pr.b];
      return () => D.forecastLine(pts, 'mainline', 70, 40, 0, undefined, undefined, 'rail', plannedSet(g, pts)).revenue;
    };
    const fb = forecast(big.map((t) => towns[t])), fs = pairS.length ? forecast(pairS.map((t) => towns[t])) : null;
    if (fb && fs) {
      const nb = fb(), ns = fs();
      BIG_CITY.exp = 0; D.rebuild();
      const ob = fb(), os = fs();
      BIG_CITY.exp = exp; D.rebuild();
      console.log(`  seed ${seed}: rail forecast big pair ${Math.round(ob / 1000)}k -> ${Math.round(nb / 1000)}k, small pair ${Math.round(os / 1000)}k -> ${Math.round(ns / 1000)}k`);
      check(nb >= ob * 1.03 && ns <= os * 1.02 && ns >= os * 0.99 && os > 0, `seed ${seed}: the big-city railway earns more, the small-town one about the same`);
    } else console.log(`  seed ${seed}: no station pair for the forecast comparison`);
  }
}

// ------------------------------------------------------------------------------------------------ new line beside our station
function preferStationChecks() {
  console.log('site: a new railway into a town stops beside our station there when it connects');
  const fixture = (x: number, z: number, angle: number) => {
    const { g, me } = aiFlat();
    const T = fixtureTown(g, 128, 128, 2500, 40);
    const opts = roadOpts(-1, 'street', { town: true, straight: true });
    build(g, free(g, 60, 140), free(g, 200, 140), opts, 'street');
    build(g, free(g, 60, 100), free(g, 200, 100), opts, 'street 2');
    const X = station(g, x, z, angle, 12, 2, me);
    if (X) X.townId = T.id;
    return { g, me, T, X };
  };
  // our station north-east of the centre, beside the way to the new line's other town (north)
  {
    const [x, z, angle] = [150, 84, 0];
    const { g, me, T, X } = fixture(x, z, angle);
    check(!!X, 'site: our station in town');
    if (!X) return;
    const toward = { x: 128, z: 0 };
    const base = { tracks: 2, length: 12, owner: me, front: 22, back: 22, quick: true };
    const plain = runGen(aiStationSiteGen(g, T, toward, base));
    const linked = runGen(aiStationSiteGen(g, T, toward, { ...base, network: new Map([[X.id, 60]]) }));
    const d = (p: { x: number; z: number } | null) => p ? Math.round(Math.hypot(p.x - X.x, p.z - X.z)) : -1;
    console.log(`  our station at ${x},${z}: the usual site ${d(plain)} u from it (links ${plain?.links.map((s) => s.id).join(',') || '-'}), valuing the connection ${d(linked)} u (links ${linked?.links.map((s) => s.id).join(',') || '-'})`);
    check(!!plain && !plain.links.some((s) => s.id === X.id), 'site: the usual best site is not beside our station');
    check(!!linked && linked.links.some((s) => s.id === X.id), 'site: valuing the connection, the new station is beside ours (linked: one interchange)');
    check(!!plain && !!linked && linked.cost < plain.cost + 60 * 20000, 'site: for at most the connection\'s value more');
  }
}

// ------------------------------------------------------------------------------------------------ hub works
function hubFixture() {
  const { g, ai, me } = aiFlat();
  const T = fixtureTown(g, 128, 128, 3000, 50);
  const opts = roadOpts(-1, 'street', { town: true, straight: true });
  // streets: an east-west and a north-south street through the centre (access for the stations)
  build(g, free(g, 60, 150), free(g, 200, 150), opts, 'street EW');
  build(g, free(g, 110, 60), free(g, 110, 210), opts, 'street NS');
  // line 0 from the west into A (its free end east), line 1 from the south into B (its free end north)
  const A = station(g, 88, 120, Math.PI / 2, 12, 1, me)!, P = station(g, 30, 120, Math.PI / 2, 12, 1, me)!;
  const B = station(g, 150, 172, 0, 12, 1, me)!, Q = station(g, 150, 226, 0, 12, 1, me)!;
  check(!!A && !!P && !!B && !!Q, 'hub: fixture stations');
  A.townId = B.townId = T.id; P.townId = Q.townId = -1;
  const net = g.world.net, lay = (p: number, q: number) => {
    const a = net.nodes.get(p)!, b = net.nodes.get(q)!;
    net.addEdge('rail', a.id, b.id, bezLine(a.x, a.z, b.x, b.z), new Float32Array(Math.ceil(Math.hypot(b.x - a.x, b.z - a.z)) + 1).fill(3), [], 'standard', me);
  };
  lay(endNode(g, P, 0, true), endNode(g, A, 0, false));
  lay(endNode(g, B, 0, true), endNode(g, Q, 0, false));
  g.onNetworkChanged();
  const l0 = railLine(g, me, [P, A], P, A), l1 = railLine(g, me, [B, Q], Q, B);
  const managed = (ai as unknown as { lines: Map<number, unknown> }).lines;
  for (const l of [l0, l1]) managed.set(l.id, { kind: 'rail', towns: [T.id], depot: (g.vehicles.get(l.vehicles[0]) as Train).depotId, maxVehicles: 4, opened: 0 });
  return { g, ai, me, T, A, B, P, Q, l0, l1 };
}

function hubChecks() {
  console.log('hub: two lines with separate stations in one town get shared platforms in staged works');
  {
    // without demand between the lines the works do not pay
    const { g, ai } = hubFixture();
    run(g, 20);
    hubOptions.force = false;
    networkProfile.decisions = {};
    for (let d = 0; d < 20 && stepNetworkTask(ai, 'hub'); d++) run(g, 1);
    console.log(`  unforced: ${Object.entries(networkProfile.decisions).filter(([k]) => k.startsWith('hub')).map(([k, v]) => `${k} ${v}`).join(', ')}; best score ${Math.round(hubProfile.best)}`);
    check(g.stations.all().filter((s) => s.rail).length === 4, 'hub: nothing built where the shared station does not pay');
  }
  {
    // with journeys between the lines' other towns (one change of trains at the shared station) it pays
    const { g, ai, P, Q } = hubFixture();
    run(g, 20);
    hubOptions.force = false;
    networkProfile.decisions = {}; hubProfile.best = -Infinity;
    const T1 = fixtureTown(g, P.x, P.z, 1000, 10), T2 = fixtureTown(g, Q.x, Q.z, 1000, 10);
    P.townId = T1.id; Q.townId = T2.id;
    const produced = 12;
    g.demand.regions = [T1, T2].map((t, id) => ({ id, town: t.id, kind: 'town' as const, x: t.x, z: t.z, r: 10, pop: 400, jobs: 0, produced, attracted: produced }));
    g.demand.od = Float32Array.from([0, 1, 1, 0]); g.demand.ld = new Float32Array(4);
    let stage: string | null = null;
    for (let i = 0; i < 20 && (stepNetworkTask(ai, 'hub') || networkItem(ai)?.hub); i++) { stage = networkItem(ai)?.hub?.stage ?? null; if (stage === 'branch') break; }
    console.log(`  ${produced * 2} trips a month between the lines' far towns: stage ${stage}; best score ${Math.round(hubProfile.best)}`);
    check(stage === 'branch' && g.stations.all().filter((s) => s.rail).length === 5, 'hub: where the journeys between the lines pay for it, the shared platforms are built');
  }
  const { g, ai, me, A, B, P, Q, l0, l1 } = hubFixture();
  hubOptions.force = true;
  const trains = [...l0.vehicles, ...l1.vehicles].map((id) => g.vehicles.get(id) as Train);
  const c = calls(g, trains);
  run(g, 150, () => c.tick());
  check(trains.every((t) => c.of(t).size === 2), `hub: trains run before the works (${trains.map((t) => [...c.of(t)].join('/')).join(' ')})`);
  const stations0 = new Set(g.stations.all().map((s) => s.id));
  let saved = false, stages: string[] = [], replayed: Game | null = null;
  const stageOf = (x: Game) => networkItem(x.ais[0])?.hub?.stage ?? null;
  // one work unit a day, as the planner gives a prepared item; a save during the works continues identically
  const during = calls(g, trains);
  for (let d = 0; d < 400; d++) {
    // (works waiting for trains are put aside by the planner and resumed by the next hub task)
    const going = stepNetworkTask(ai, 'hub') || !!networkItem(ai)?.hub;
    const s = stageOf(g);
    if (s === 'branch' || s === 'throat' || s === 'switch') during.tick();
    if (s && stages[stages.length - 1] !== s) stages.push(s);
    if (!saved && s === 'switch') {
      saved = true;
      const loaded = deserialize(JSON.parse(json(g)));
      check(json(loaded) === json(g), 'hub: save round trip during the works');
      for (let k = 0; k < 30; k++) { run(g, 1, () => c.tick()); run(loaded, 1); stepNetworkTask(ai, 'hub'); stepNetworkTask(loaded.ais[0], 'hub'); }
      const a = json(g), b = json(loaded);
      if (a !== b) { let i = 0; while (a[i] === b[i]) i++; console.log(`  hub replay differs at ${i}: ${a.slice(i - 100, i + 100)} | ${b.slice(i - 100, i + 100)}`); }
      check(a === b, 'hub: a game saved during the works continues identically (30 days of works and trains)');
      replayed = loaded;
    }
    if (!going) break;
    run(g, 1, () => c.tick());
  }
  console.log(`  stages ${stages.join(' > ')}; ${ai.log.slice(-4).join(' | ')}${hubProfile.why ? '; last branch plan: ' + hubProfile.why : ''}`);
  for (const X of [A, B]) if (g.stations.get(X.id)) console.log(`  ${X.name} remains: lines ${g.lines.linesAt(X.id).map((l) => l.name).join(',') || '-'}; trains ${trains.map((t) => `${t.name} ${t.state} at ${t.atStation} target ${t.routeTarget} "${t.status}" segs ${t.segs.map((x) => x.e).join(',')}`).join(' | ')}; edges ${X.rail?.edges.join(',')}`);
  const fresh = g.stations.all().filter((s) => !stations0.has(s.id) && s.rail);
  const S = fresh[0];
  check(fresh.length === 1 && !!S, 'hub: new shared platforms built');
  check(!!S && g.lines.get(l0.id)!.stops.includes(S.id) && g.lines.get(l1.id)!.stops.includes(S.id), 'hub: both lines stop at the new platforms');
  check(!g.stations.get(A.id) && !g.stations.get(B.id), 'hub: the old platforms are taken up');
  const near = (x: number, z: number) => [...g.world.net.edges.values()].filter((e) => e.kind === 'rail' && e.owner === me && [e.a, e.b].some((n) => { const q = g.world.net.nodes.get(n)!; return Math.hypot(q.x - x, q.z - z) < 4; })).length;
  check(near(A.x, A.z) === 0 && near(B.x, B.z) === 0, 'hub: and their track stubs');
  check(!!S && SE(g, S).every((e) => [e.front, e.back].some((n) => (g.world.net.nodes.get(n)?.edges.length ?? 0) > 1)), 'hub: both platform tracks connected');
  check(trains.every((t) => during.of(t).size > 0), `hub: trains kept running during the works (${trains.map((t) => during.of(t).size).join('/')} calls)`);
  check(stages.includes('branch') && stages.includes('switch') && stages.includes('remove'), 'hub: works ran in stages');
  check(saved, 'hub: a save was made during the works');
  const after = calls(g, trains);
  run(g, 200, () => after.tick());
  check(!!S && trains.every((t) => after.of(t).has(S.id) && (after.of(t).has(P.id) || after.of(t).has(Q.id))), `hub: trains run after the works (${trains.map((t) => [...after.of(t)].join('/')).join(' ')})`);
  check(checkReservations(g).length === 0, 'hub: reservations consistent');
  hubOptions.force = false;
  void me; void replayed;
}

const sections: Record<string, () => void> = { join: joinRules, split: splitChecks, big: bigCityChecks, site: preferStationChecks, hub: hubChecks };
for (const [k, f] of Object.entries(sections)) if (!only || only === k) f();
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
