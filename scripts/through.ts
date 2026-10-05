import { trackTypeOf } from '../src/game/constants';
import { railPartMode, railModeOf } from '../src/game/stations';
import { lineTable as startupTable, patternOf as startupPattern } from '../src/game/patterns';
import type { Vehicle as StartupVehicle } from '../src/game/vehicle';
// Urban rail between companies (v2.4): a Fukuoka-like through service (company A's metro under a town meets
// company B's electrified suburban line at a junction station; both operators' units run through), track
// compatibility (incompatible trains are refused / get a clear status), JR-style line codes and station numbers,
// a line run by three companies (no duplicate lines, no gridlock), congestion response, the AI's urban railways,
// and a save round trip.
// npx esbuild scripts/through.ts --bundle --platform=node --format=esm --outfile=$S/through.mjs && node $S/through.mjs
import { Game, PLAYER } from '../src/game/game';
import { MODEL_BY_ID, VehicleModel } from '../src/game/vehicle-types';
import { stationEnds, nodeSnap, buildDepotOnLine, buildRailDepot, depotAtEnd } from '../src/game/routing';
import { connectStationThroat } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { lineCompatibility, lineOperators, lineCongestion, Train } from '../src/game/train';
import { outAndBack, colorDistance } from '../src/game/lines';
import { serialize, deserialize } from '../src/game/save';
import type { Station } from '../src/game/stations';
import type { Economy, Category } from '../src/game/economy';
import { fails, check, fmt, build, free, railOpts, checkReservations, connectDouble } from './lib';
import { addPattern, setVehiclePattern } from '../src/game/patterns';

const total = (e: Economy, cat: Category) => e.yearTotals.reduce((s, y) => s + y.v[cat], 0) + e.thisYear[cat];
const M = (id: string) => MODEL_BY_ID.get(id)!;
const runDays = (g: Game, n: number, each?: () => void) => { const d0 = g.day; while (g.day < d0 + n) { g.update(0.25); each?.(); } };

function flatGame(size = 512, ais = 2): Game {
  const g = Game.create({ size, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 1995, aiCompanies: ais });
  g.aiEnabled = false;
  g.world.h.fill(4);
  g.world.heightsVersion++;
  g.economy.money = 1e9;
  for (const c of g.companies) c.economy.money = 1e9;
  return g;
}
const station = (g: Game, x: number, z: number, owner: number, trackType: string, level: 'ground' | 'underground' = 'ground', len?: number): Station => {
  const id = g.stations.nextId;
  const plan = g.stations.planRail(x, z, Math.PI / 2, len ?? (trackType === 'metro' ? 12 : 10), 2, owner, { trackType: trackTypeOf(trackType), mode: railModeOf(trackType), level });
  const err = plan.ok ? g.stations.commitRail(plan, owner) : plan.error;
  if (err) throw new Error(`station at ${x}: ${err}`);
  return g.stations.get(id)!;
};
/** Visits per train (arrivals at a platform). */
function counter(trains: Train[]) {
  const visits = new Map<number, number>(), prev = new Map<number, string>();
  return {
    visits,
    tick() { for (const t of trains) { if (t.state === 'loading' && prev.get(t.id) !== 'loading') visits.set(t.id, (visits.get(t.id) ?? 0) + 1); prev.set(t.id, t.state); } },
  };
}

// ------------------------------------------------------------------ 1. Fukuoka: metro A + suburban B, through running
{
  console.log('through service');
  const g = flatGame(512, 2);
  const A = 1, B = 2, Z = 256;
  // A: five underground metro stations, a ramp up to the junction J (A's, at ground level); B: on from J.
  // Single track between two-track stations (trains pass at every station), as the AI builds them.
  const Ms = [60, 100, 140, 180, 220].map((x) => station(g, x, Z, A, 'metro', 'underground'));
  const J = station(g, 300, Z, A, 'electric');
  const S1 = station(g, 380, Z, B, 'electric'), S2 = station(g, 460, Z, B, 'electric');
  const end = (st: Station, front: boolean) => stationEnds(g, st).map((e) => (front ? e.front : e.back));
  let ok = true;
  for (let i = 0; i + 1 < Ms.length; i++) ok = !!build(g, nodeSnap(g, end(Ms[i], true)[0], 'rail'), nodeSnap(g, end(Ms[i + 1], false)[0], 'rail'), railOpts(A, 1, { type: 'electric', level: 'underground', levelDepth: Ms[i].rail!.depth }), 'metro') && ok;
  // the ramp (metro track, from the tunnel up to ground level) into the junction, then B's electric line
  ok = !!build(g, nodeSnap(g, end(Ms[4], true)[0], 'rail'), nodeSnap(g, end(J, false)[0], 'rail'), railOpts(A, 1, { type: 'electric' }), 'ramp') && ok;
  ok = !!build(g, nodeSnap(g, end(J, true)[0], 'rail'), nodeSnap(g, end(S1, false)[0], 'rail'), railOpts(B, 1, { type: 'electric' }), 'J-S1') && ok;
  ok = !!build(g, nodeSnap(g, end(S1, true)[0], 'rail'), nodeSnap(g, end(S2, false)[0], 'rail'), railOpts(B, 1, { type: 'electric' }), 'S1-S2') && ok;
  check(ok, 'metro, ramp, junction and suburban line built');
  // depots: A's beyond the first metro station (a ramp up), B's beyond S2
  const net = g.world.net;
  // (the ramp climbs to the surface beyond the first metro station; the depot sits at its end)
  const rampUp = build(g, nodeSnap(g, end(Ms[0], false)[0], 'rail'), free(g, 8, Z), railOpts(A, 1, { type: 'electric' }), 'depot ramp');
  const topA = rampUp ? [...net.nodes.values()].filter((n) => n.kind === 'rail' && n.edges.length === 1 && n.x < 20).sort((p, q) => p.x - q.x)[0] : null;
  const dA = topA ? depotAtEnd(g, topA.id, A) : -1;
  if (dA < 0) console.log(`  depot A: ramp ${!!rampUp}, end node ${topA ? `${fmt(topA.x)},${fmt(topA.z)} y ${fmt(topA.y)} ground ${fmt(g.world.heightAt(topA.x, topA.z))}` : 'none'}`);
  const tail = build(g, nodeSnap(g, end(S2, true)[0], 'rail'), free(g, 495, Z), railOpts(B, 1, { type: 'electric' }), 'depot track');
  const topB = tail ? net.nearestNode(495, Z, 0.3, 'rail') : null;
  const dB = topB ? depotAtEnd(g, topB.id, B) : -1;
  // every station's second track joins the line at both ends
  let joined = 0;
  for (const st of [...Ms, J, S1, S2]) joined += connectStationThroat(g, st.id, st.owner).connected;
  console.log(`  throats: ${joined} turnouts`);
  check(dA >= 0 && dB >= 0, `depots of both companies (${dA}, ${dB})`);
  // mutual through running: A's metro trains on to S2, B's commuter trains on into the metro
  const la = g.lines.create('rail', A), lb = g.lines.create('rail', B);
  la.stops = outAndBack([...Ms.map((s) => s.id), J.id, S1.id, S2.id]);
  lb.stops = outAndBack([S2.id, S1.id, J.id, ...[...Ms].reverse().map((s) => s.id)]);
  g.lines.rebuild();
  const sa = autoSignalLine(g, la.id, A), sb = autoSignalLine(g, lb.id, B);
  console.log(`  signals: ${sa.placed} + ${sb.placed}${sa.warnings.length ? ' (' + sa.warnings[0] + ')' : ''}`);
  const ops = lineOperators(g, la.id);
  console.log(`  ${la.name} operators: ${ops.map((o) => `${g.company(o.owner).name} ${fmt(o.share * 100, 0)}%`).join(', ')}`);
  check(ops.length === 2 && ops.some((o) => o.owner === B && o.share > 0.2), 'lineOperators: the through line runs on both companies\' track');
  // compatibility: metro and light-rail track are rails like any other (only electric traction needs wire), so
  // diesel, metro and commuter stock all suit the electrified through lines
  check(lineCompatibility(g, la.id, [M('diesel_b'), M('coach_ic')]) === null, 'a diesel train may run on the metro through line: ' + lineCompatibility(g, la.id, [M('diesel_b'), M('coach_ic')]));
  check(lineCompatibility(g, la.id, [M('metro_b')]) === null && lineCompatibility(g, lb.id, [M('emu_b')]) === null, 'metro and commuter units suit the through lines');
  const trains: Train[] = [];
  for (const [d, l, m] of [[dA, la, 'metro_b'], [dA, la, 'metro_b'], [dB, lb, 'emu_b'], [dB, lb, 'emu_b']] as [number, typeof la, string][]) {
    const t = g.vehicles.buyTrain(d, [M(m)], l.id);
    if (t instanceof Train) trains.push(t); else console.log('  buy: ' + t);
  }
  check(trains.length === 4, 'two units of each company bought');
  const pa0 = total(g.company(A).economy, 'trackFees'), pb0 = total(g.company(B).economy, 'trackFees');
  const c = counter(trains);
  let maxStuck = 0;
  runDays(g, 720, () => { c.tick(); for (const t of trains) maxStuck = Math.max(maxStuck, t.stuckTime); });
  const visits = trains.map((t) => c.visits.get(t.id) ?? 0);
  const paidA = pa0 - total(g.company(A).economy, 'trackFees'), paidB = pb0 - total(g.company(B).economy, 'trackFees');
  console.log(`  2 years: visits ${visits.join('/')}, longest stand ${fmt(maxStuck, 0)} s; fees A paid ${fmt(paidA, 0)}, B paid ${fmt(paidB, 0)}; ${trains.map((t) => t.status).join(' | ')}`);
  check(visits.every((v) => v >= 10), 'every unit keeps running through (no deadlock over two years)');
  check(paidA > 0 && paidB > 0, 'fees flow both ways (each runs on the other\'s track and stations)');
  const errs = checkReservations(g);
  check(errs.length === 0, 'reservations consistent ' + errs.slice(0, 2).join('; '));
  // numbering: A's route letters on A's stations, B's letter on its own stations of the same route
  g.lines.inheritRoute(lb.id, la.id);
  const codeA = g.lines.stationCode(la.id, Ms[0].id), codeS2 = g.lines.stationCode(lb.id, S2.id), codeJ = g.lines.stationCodes(J.id);
  console.log(`  numbering: ${g.lines.lineCode(la.id)} / ${g.lines.lineCode(lb.id)}: ${Ms[0].name} ${codeA}, J ${codeJ.join(' ')}, S2 ${codeS2}`);
  check(/^[A-Z][A-Z0-9]+01$/.test(codeA) && codeS2.startsWith(g.company(B).code!) && codeS2.slice(1, -2) === codeA.slice(1, -2), 'through service: B\'s stations continue A\'s route letter with B\'s company letter');
  // a diesel train on the metro line runs like any other rail stock
  const dsl = g.vehicles.buyTrain(dB, [M('diesel_b'), M('coach_ic')], la.id);
  if (dsl instanceof Train) { runDays(g, 12); console.log(`  diesel on the metro line: ${dsl.status}`); check(dsl.state !== 'noroute', 'the diesel train finds a route on the metro line'); }
  // save round trip
  const json = JSON.stringify(serialize(g));
  check(JSON.stringify(serialize(deserialize(JSON.parse(json)))) === json, 'save round trip exact');
}

// ------------------------------------------------------------------ 2. codes and colours
{
  console.log('codes');
  const g = flatGame(256, 6);
  const codes = g.companies.map((c) => c.code);
  console.log(`  companies: ${g.companies.map((c) => `${c.name} ${c.code}`).join(', ')}`);
  check(new Set(codes).size === codes.length && codes.every((x) => !!x), 'every company has its own letter');
  const lines = Array.from({ length: 30 }, (_, i) => g.lines.create(i % 3 ? 'road' : 'rail', i % 2));
  const cols = lines.map((l) => l.color);
  let minD = Infinity;
  for (let i = 0; i < cols.length; i++) for (let j = i + 1; j < cols.length; j++) minD = Math.min(minD, colorDistance(cols[i], cols[j]));
  console.log(`  30 lines: ${new Set(cols).size} colours, closest pair delta E ${fmt(minD, 1)}`);
  check(new Set(cols).size === 30 && minD > 8, 'every line its own, distinct colour');
}

// ------------------------------------------------------------------ 3. one line, three companies
{
  console.log('shared line');
  const g = flatGame(512, 3);
  const Z = 256;
  // (each operator owns a station of the line: a company running services on a line owns one of its stations)
  const owners = [PLAYER, 1, 2, PLAYER];
  const S = [80, 200, 320, 440].map((x, i) => station(g, x, Z, owners[i], 'standard'));
  const net = g.world.net;
  const end = (st: Station, front: boolean) => stationEnds(g, st).map((e) => (front ? e.front : e.back));
  let ok = true;
  for (let i = 0; i + 1 < S.length; i++) ok = !!build(g, nodeSnap(g, end(S[i], true)[0], 'rail'), nodeSnap(g, end(S[i + 1], false)[0], 'rail'), railOpts(PLAYER), 'line') && ok;
  // The player owns the approach tracks and funds these shared-station turnouts. AI builders may not split
  // player rail, even with access; using the station's AI owner here would leave its second platform disconnected.
  for (const st of S) connectStationThroat(g, st.id, PLAYER);
  check(ok, 'single-track line with passing places at the stations');
  const line = g.lines.create('rail', PLAYER);
  line.stops = outAndBack(S.map((s) => s.id));
  g.lines.setPartnerPolicy(line.id, 'open');
  autoSignalLine(g, line.id, PLAYER);
  const deps: number[] = [];
  for (const owner of [PLAYER, 1, 2]) {
    if (owner !== PLAYER) check(g.lines.join(line.id, owner) === null, `company ${owner} joins the line`);
    let d = -1;
    for (const e of [...net.edges.values()].filter((x) => x.kind === 'rail' && x.station < 0 && x.depot < 0 && x.len > 20)) for (const f of [0.3, 0.5, 0.7]) if (d < 0) d = buildDepotOnLine(g, e.id, e.len * f, owner);
    deps.push(d);
  }
  const trains = deps.map((d) => g.vehicles.buyTrain(d, [M('diesel_b'), M('coach_ic')], line.id)).filter((t): t is Train => t instanceof Train);
  check(trains.length === 3 && new Set(trains.map((t) => t.owner)).size === 3 && g.lines.all().filter((l) => l.kind === 'rail').length === 1, 'three operators, one line (no duplicate)');
  // a fourth company owns no station of the line: it may neither join nor buy trains for it
  const j3 = g.lines.join(line.id, 3);
  let d3 = -1;
  for (const e of [...net.edges.values()].filter((x) => x.kind === 'rail' && x.station < 0 && x.depot < 0 && x.len > 20)) for (const f of [0.4, 0.6]) if (d3 < 0) d3 = buildDepotOnLine(g, e.id, e.len * f, 3);
  g.lines.invite(line.id, 3);
  const b3 = d3 >= 0 ? g.vehicles.buyTrain(d3, [M('diesel_b'), M('coach_ic')], line.id) : 'no depot';
  console.log(`  company 3 (no station): join "${j3}", train "${typeof b3 === 'string' ? b3 : 'bought'}"`);
  check(j3 !== null && typeof b3 === 'string' && !g.lines.canOperate(line, 3), 'a company without a station of the line cannot run trains on it');
  startFleet(g, trains);
  const c = counter(trains);
  runDays(g, 360, () => c.tick());
  const v = trains.map((t) => c.visits.get(t.id) ?? 0);
  const inc = [PLAYER, 1, 2].map((o) => total(g.company(o).economy, 'income'));
  console.log(`  a year: visits ${v.join('/')}, income ${inc.map((x) => fmt(x / 1000, 0) + 'k').join(' / ')}; congestion ${lineCongestion(g, line.id).level}`);
  check(v.every((x) => x >= 4) && checkReservations(g).length === 0, 'no gridlock: every operator\'s train keeps serving the line');
}

// ------------------------------------------------------------------ 3b. short-turn pattern on directional double track
{
  console.log('short turn on double track');
  const g = flatGame(768, 1);
  const Z = 384;
  const S = [120, 320, 520].map((x) => station(g, x, Z, PLAYER, 'standard', 'ground', 12));
  const d1 = connectDouble(g, S[0], S[1], PLAYER, () => {}), d2 = connectDouble(g, S[1], S[2], PLAYER, () => {});
  console.log(`  double track: ${d1.ok && d2.ok ? 'ok' : 'failed'}, crossovers ${d1.crossovers}+${d2.crossovers}, signals ${d1.signals}+${d2.signals}`);
  const line = g.lines.create('rail', PLAYER);
  line.stops = outAndBack(S.map((x) => x.id));
  // the short-turn pattern: A - B and back (its trains turn at the middle station)
  const turn = addPattern(g, line.id, 'local', line.stops.map((sid) => sid !== S[2].id), 'Short turn');
  // (the depot behind the first station: trains leave it into the platforms)
  const dep = buildRailDepot(g, S[0], PLAYER, { x: 1, z: 0 });
  const trains = [0, 1].map(() => g.vehicles.buyTrain(dep, [M('diesel_b'), M('coach_ic')], line.id)).filter((t): t is Train => t instanceof Train);
  if (turn && trains[1]) setVehiclePattern(g, trains[1].id, turn.id);
  check(d1.ok && d2.ok && !!turn && trains.length === 2, 'double track A - B - C, a line with a short-turn pattern, two trains');
  const c = counter(trains);
  let noroute = 0;
  runDays(g, 360, () => { c.tick(); for (const t of trains) if (t.state === 'noroute') noroute++; });
  const v = trains.map((t) => c.visits.get(t.id) ?? 0);
  console.log(`  a year: visits all-stops ${v[0]}, short turn ${v[1]}; noroute ticks ${noroute}; ${trains.map((t) => t.status).join(' | ')}`);
  check(v[1] >= 4 && noroute < 20, 'the short-turn train turns at the middle station (no noroute)');
  check(v[0] >= 3, 'the all-stops train keeps running');
  check(checkReservations(g).length === 0, 'reservations consistent');
}

// ------------------------------------------------------------------ 4. the AI builds urban rail in a big town
{
  console.log('AI urban rail');
  const g = Game.create({ size: 640, seed: 21, towns: 14, hilliness: 'flat', water: 'low', startYear: 1990, aiConfigs: [{ startMoney: 60_000_000, focus: { rail: 2, road: 0.3, tram: 1.5 } }, { startMoney: 60_000_000, focus: { rail: 2, road: 0.3, tram: 1.5 } }] });
  g.aiAcquisitions = false;
  const big = [...g.towns.list].sort((a, b) => b.pop - a.pop).slice(0, 3);
  console.log(`  biggest towns: ${big.map((t) => `${t.name} ${t.pop}`).join(', ')}`);
  const t0 = performance.now();
  while (g.day < 720) g.update(0.25);
  const st = g.ais.map((a) => a.stats);
  const urbanLines = g.lines.all().filter((l) => l.kind === 'rail' && l.owner > 0 && l.stops.some((sid) => { const s2 = g.stations.get(sid); return !!s2?.rail && railPartMode(s2.rail) !== 'mainline'; }));
  console.log(`  2 years (${fmt((performance.now() - t0) / 1000, 0)} s): urban lines ${urbanLines.map((l) => `${l.name} (${new Set(l.stops).size} stations)`).join(', ') || 'none'}; stats urban ${st.map((x) => x.urban).join('/')}, through ${st.map((x) => x.through).join('/')}; ${g.ais.map((a) => a.log.filter((x) => /metro|light rail|city railway|through/.test(x)).slice(-3).join(' | ')).join(' || ')}`);
  check(urbanLines.length >= 1, 'the AI opened an urban railway (metro or light rail)');
}

console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;

/** Finish staged dispatch before measuring a full operating period; bound and check the startup too. */
function startFleet(g: Game, vs: StartupVehicle[], maxWaitDays = Infinity) {
  const cycles = vs.map((v) => {
    const l = v.line;
    return l ? startupTable(g, l).pats.find((p) => p.pid === (startupPattern(l, v.pattern)?.id ?? 0))?.cycle ?? 0 : 0;
  });
  const budget = 2 * Math.max(...cycles);
  const deadline = g.tick + Math.ceil(budget / g.tickSeconds), waiting = new Map<number, number>();
  let worstWait = 0, blockedHold = false;
  while (g.tick < deadline && vs.some((v) => v.opLastSt < 0)) {
    g.stepTick();
    for (const v of vs) {
      if (v.state === 'waiting' || v.state === 'noroute') {
        const start = waiting.get(v.id) ?? g.day; waiting.set(v.id, start);
        worstWait = Math.max(worstWait, g.day - start);
      } else waiting.delete(v.id);
      blockedHold ||= v.status === 'Holding for even spacing' && g.vehicles.spacingBlocked(v);
    }
  }
  check(vs.every((v) => v.opLastSt >= 0), 'the whole fleet starts serving within two estimated cycles');
  check(worstWait < maxWaitDays && !blockedHold, 'startup preserves path-wait and platform safety limits');
}
