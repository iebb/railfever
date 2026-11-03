// Cross-city jobs retain their native site, paid tunnel works and each operator's accounting across cold loads.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { Train } from '../src/game/train';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import type { Line } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack, linearStops } from '../src/game/lines';
import { stationEnds, nodeSnap, buildDepotOnLine } from '../src/game/routing';
import { connectStationThroat } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { serialize, deserialize } from '../src/game/save';
import { build, railOpts, checkReservations } from './lib';

const M = (id: string) => MODEL_BY_ID.get(id)!;
const accessAI = (ai: AIController) => ai as AIController & Record<string, any>;
function flat(ais: number, size = 512) {
  const g = Game.create({ size, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: Array.from({ length: ais }, () => ({ startMoney: 100_000_000, accessPolicy: 'open' as const })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  return g;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
/**
 * Dense apartment neighbourhoods on a connected pedestrian grid; reserve the centre railway alignment (no buildings
 * on it). `crossStreets`: the grid's streets cross the alignment as well, as a real grid's do (else it is a free strip
 * that a street-level line could take without a single crossing street).
 */
function town(g: Game, name: string, x: number, z: number, pop: number, width = 120, height = 64, crossStreets = false, strip = 7): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6,
    buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0,
    passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
  const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) {
    if (!crossStreets && zs[i - 1] < z && zs[i] > z) continue;
    road(g, rx, zs[i - 1], rx, zs[i]);
  }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) {
    // platforms and their entrances can be built without clearing the town (`strip`: by the lot's own position, 1.1 north
    // of its street; the usual 7 keeps exactly the rows beside the axis clear)
    if (Math.abs(rz + 1.1 - z) < strip) continue;
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  g.demand.rebuild(); return t;
}
function station(g: Game, x: number, z: number, owner: number, townId: number): Station {
  const id = g.stations.nextId, p = g.stations.planRail(x, z, Math.PI / 2, 12, 2, owner, { style: 'none' });
  const error = p.ok ? g.stations.commitRail(p, owner) : p.error;
  if (error) throw new Error(`station ${x},${z}: ${error}`);
  const st = g.stations.get(id)!; st.townId = townId; return st;
}
function mainLine(g: Game, a: Station, b: Station, owner: number): Line {
  const ea = stationEnds(g, a)[0].front, eb = stationEnds(g, b)[0].back;
  const e0 = g.world.net.nextEdge;
  if (!build(g, nodeSnap(g, ea, 'rail'), nodeSnap(g, eb, 'rail'), railOpts(owner))) throw new Error('main line build');
  for (const s of [a, b]) connectStationThroat(g, s.id, owner);
  const es = [...g.world.net.edges.values()].filter((e) => e.id >= e0 && e.owner === owner && e.station < 0 && e.depot < 0 && e.len > 15);
  let dep = -1;
  for (const e of es) { dep = buildDepotOnLine(g, e.id, e.len * 0.3, owner); if (dep >= 0) break; }
  if (dep < 0) throw new Error('main line depot');
  const l = g.lines.create('rail', owner); l.stops = outAndBack([a.id, b.id]); autoSignalLine(g, l.id, owner);
  const train = g.vehicles.buyTrain(dep, [M('diesel_b'), M('coach_ic'), M('coach_ic')], l.id);
  if (!(train instanceof Train)) throw new Error(train);
  accessAI(g.aiOf(owner)!).adoptLines(); return l;
}

function fixture(cooperative = true) {
  const g = flat(cooperative ? 2 : 1, 768), z = 384;
  const X = town(g, 'West Town', 110, z, 12000, 64, 48);
  const C = town(g, 'Grand City', 384, z, 16000, 208, 64, false, 4);
  const Y = town(g, 'East Town', 658, z, 12000, 64, 48);
  const second = cooperative ? 2 : 1;
  const west = station(g, X.x, z, 1, X.id), a = station(g, 296, z, 1, C.id);
  const b = station(g, 472, z, second, C.id), east = station(g, Y.x, z, second, Y.id);
  const l1 = mainLine(g, west, a, 1), l2 = mainLine(g, b, east, second);
  return { g, C, west, a, b, east, l1, l2 };
}
const oraclePath = process.argv.find(s => s.startsWith('--oracle='))?.slice(9);
const oracle: { deserialize: typeof deserialize; serialize: typeof serialize } | undefined = oraclePath
  ? await import(pathToFileURL(oraclePath).href) : undefined;
const json = (g: Game) => JSON.stringify(serialize(g));
function originalState(text: string) {
  const value = JSON.parse(text);
  for (const ai of value.ais) if (ai.state.crossCity) { delete ai.state.crossCity; delete ai.state.splitPieces; }
  return JSON.stringify(value);
}
function equal(a: string, b: string, label: string) {
  if (a === b) return;
  let at = 0; while (a[at] === b[at] && at < a.length && at < b.length) at++;
  assert.fail(`${label}: first mismatch at ${at}: ${a.slice(Math.max(0, at - 100), at + 200)} vs ${b.slice(Math.max(0, at - 100), at + 200)}`);
}
function run(cooperative: boolean) {
  const f = fixture(cooperative), g = f.g, ai = accessAI(g.ais[0]), label = cooperative ? 'cooperative' : 'private';
  const pair = ai.crossCityPair(f.C);
  assert(pair, 'native facing termini offer a cross-city opportunity');
  assert(ai.crossCityEconomics(f.C, ...pair).viable, 'native economic approval without forceBuild');
  const old = oracle?.deserialize(JSON.parse(json(g))), oldAI = old?.ais[0];
  assert(ai.startProject('crosscity', [f.C.id])); if (oldAI) assert(oldAI.startProject('crosscity', [f.C.id]));
  let cold = deserialize(JSON.parse(json(g)));
  equal(json(cold), json(g), `${label}: save before first work`);
  assert(cold.ais[0].busy);
  const stages = new Set<string>(), retained: { game: Game; until: number; stage: string }[] = [];
  let tick = 0;
  for (; (ai.busy || retained.length) && tick < 5000; tick++) {
    g.stepTick(); cold.stepTick(); old?.stepTick();
    const current = json(g);
    equal(json(cold), current, `${label}: cold fixed tick ${tick}`);
    if (old) equal(originalState(current), originalState(JSON.stringify(oracle!.serialize(old))), `${label}: original fixed tick ${tick}`);
    for (let at = retained.length - 1; at >= 0; at--) {
      const branch = retained[at]; branch.game.stepTick();
      equal(json(branch.game), current, `${label}: retained cold ${branch.stage}/${tick}`);
      if (tick >= branch.until) retained.splice(at, 1);
    }
    const task = ai.crossCityTask, stage = task ? task.stage + (task.stage === 'chain' ? `:${task.at}:${task.link?.chain.phase}` : '') : undefined;
    if (stage && !stages.has(stage)) {
      stages.add(stage); retained.push({ game: deserialize(JSON.parse(current)), until: tick + 128, stage });
    }
    cold = deserialize(JSON.parse(current)); equal(json(cold), current, `${label}: immediate roundtrip ${tick}`);
  }
  assert(!ai.busy && tick < 5000, `${label}: native construction terminates`);
  assert(ai.log.every((line: string) => !line.includes('error:')), `${label}: no AI exception`);
  const centre = g.stations.all().find(s => s.townId === f.C.id && s.rail?.level === 'underground');
  const line = g.lines.get(f.l1.id), path = line && linearStops(line.stops);
  assert(centre && path?.length === 5 && path.includes(centre.id), `${label}: paid centre joins both actual lines`);
  assert(!g.lines.map.has(f.l2.id) && g.lines.get(f.l2.id) === line, `${label}: absorbed timetable resolves to the surviving native line`);
  assert.equal(line!.vehicles.length, 2, `${label}: both original trains are retained`);
  if (cooperative) assert(line!.operators?.includes(2) && g.ais[1].stats.crossCity === 1, 'both operators share the actual paid link');
  assert.equal(checkReservations(g).length, 0);
  assert.equal(ai.crossCityTask, null);
  console.log(`${label}: ${tick} fixed ticks, ${stages.size} saved stages, ${g.world.net.edges.size} native edges, joint services ${line!.operators?.join('/') ?? '-'}; ALL CHECKS PASSED`);
}
function buyoutAudit(expectCleanup: boolean) {
  const f = fixture(true), g = f.g, ai = accessAI(g.ais[0]);
  // A funded player uses the normal buyout API; transport costs and both AI budgets are unchanged.
  g.economy.money = 1_000_000_000;
  const old = oracle?.deserialize(JSON.parse(json(g))), oldAI = old?.ais[0];
  assert(ai.startProject('crosscity', [f.C.id])); if (oldAI) assert(oldAI.startProject('crosscity', [f.C.id]));
  let tick = 0;
  const paidForeignTunnel = () => ai.project?.edges.some((id: number) => { const e = g.world.net.edges.get(id); return e?.owner === 2 && e.station < 0 && e.depot < 0 && e.sections.some(s => s.type === 'tunnel'); });
  while (!paidForeignTunnel() && ai.busy && tick++ < 1000) {
    g.stepTick(); old?.stepTick();
    if (old) equal(originalState(json(g)), originalState(JSON.stringify(oracle!.serialize(old))), `buyout original prefix ${tick}`);
  }
  assert(paidForeignTunnel() && ai.project?.joint?.spent[1] > 0, 'both operators have paid actual tunnel work before takeover');
  const paidEdges = [...ai.project.edges] as number[], station = ai.project.stations[0];
  const cold = deserialize(JSON.parse(json(g)));
  assert.equal(g.buyCompany(0, 2), null, 'native funded acquisition succeeds');
  assert.equal(cold.buyCompany(0, 2), null, 'cold native acquisition succeeds');
  if (old) assert.equal(old.buyCompany(0, 2), null);
  equal(json(cold), json(g), 'takeover live/cold equality');
  assert(g.company(2).defunct && !g.aiOf(2), 'acquired operating company retires');
  console.log(JSON.stringify({ tick, activeAfterTakeover: ai.busy, jointAfterTakeover: ai.project?.joint,
    originalActiveAfterTakeover: oldAI?.busy, originalJointAfterTakeover: (oldAI as any)?.project?.joint,
    retainedPaidEdges: paidEdges.filter(id => g.world.net.edges.has(id)), retainedCentre: !!g.stations.get(station) }));
  if (expectCleanup) {
    assert(!ai.busy && !ai.project && !g.stations.get(station), 'takeover cancels joint construction before retiring its investor');
    assert(paidEdges.every(id => !g.world.net.edges.has(id)), 'unfinished joint tunnel is removed before ownership transfer');
    if (oldAI) assert(oldAI.busy && (oldAI as any).project?.joint?.partner === 2, 'original native takeover reproduces an active job with a retired investor');
    assert(g.stations.get(f.west.id)?.rail && g.stations.get(f.east.id)?.rail, 'both established running services survive');
    assert.equal(checkReservations(g).length, 0);
    for (let i = 0; i < 128; i++) { g.stepTick(); cold.stepTick(); equal(json(g), json(cold), `takeover cold continuation ${i}`); }
    console.log('ALL CHECKS PASSED: native paid-joint takeover and128 fixed-tick replay');
  }
}
if (process.argv.includes('--buyout-audit')) buyoutAudit(false);
else if (process.argv.includes('--buyout')) buyoutAudit(true);
else if (process.argv.includes('--private')) run(false);
else if (process.argv.includes('--cooperative')) run(true);
else { run(true); run(false); buyoutAudit(true); }
