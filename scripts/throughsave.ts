// The AI's through service (a city railway joined to a main line that ends beside its depot end), saved and loaded:
// the city railway is a finished project before the through service is planned; the through service is a follow-up
// job saved with the company (its cursor) and built within one work unit or not at all. A game saved at every tick
// from the city railway's completion to after the through service loads exactly, and goes on exactly as the original.
// Also: the join point is the exact edge of our own depot ramp (not another track at that spot), work that splits
// older track never takes its halves for its own (abandoning leaves them), and a through service whose wiring
// cannot be paid for leaves the city railway and the main line as they were.
// Bundle as throughsave.mjs (esbuild --bundle --platform=node --format=esm) and run with node.
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { Train, lineCompatibility } from '../src/game/train';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import type { Line } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack } from '../src/game/lines';
import { stationEnds, nodeSnap, buildDepotOnLine } from '../src/game/routing';
import { connectStationThroat } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { planEdge, commitProposal, findSnap } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';
import { check, fails, build, railOpts } from './lib';

if (!process.argv[1]?.endsWith('throughsave.mjs')) throw new Error('bundle this test as throughsave.mjs');
const T0 = performance.now();
const M = (id: string) => MODEL_BY_ID.get(id)!;
type AnyAI = AIController & Record<string, any>;

/** A flat map: a dense 8,000-person city, a small town 200 m west, our main line from it ending beside the city. */
function scenario() {
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: [{ startMoney: 100_000_000, accessPolicy: 'open' as const }] });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  const road = (x0: number, z0: number, x1: number, z1: number) => {
    const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
    const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
    net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(4), [], 'street', -1);
  };
  const town = (name: string, x: number, z: number, pop: number, width: number, height: number): Town => {
    const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop, radius: Math.max(width, height) * 0.6, buildings: new Set(),
      nextGrowthDay: 1e9, hasChurch: false, passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 } as Town;
    g.towns.list.push(t);
    const xs = Array.from({ length: Math.floor(width / 8) + 1 }, (_, i) => x - width / 2 + i * 8);
    const zs = Array.from({ length: Math.floor(height / 8) + 1 }, (_, i) => z - height / 2 + i * 8 + 4);
    for (const rz of zs) for (let i = 1; i < xs.length; i++) road(xs[i - 1], rz, xs[i], rz);
    for (const rx of xs) for (let i = 1; i < zs.length; i++) { if (zs[i - 1] < z && zs[i] > z) continue; road(rx, zs[i - 1], rx, zs[i]); }
    const lots: { x: number; z: number; angle: number }[] = [];
    for (const rz of zs) for (let rx = x - width / 2 + 2; rx < x + width / 2; rx += 4) if (Math.abs(rz - z) >= 7) lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
    let remaining = pop;
    lots.forEach((p, i) => {
      const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
      t.buildings.add(g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 }).id);
    });
    g.demand.rebuild(); return t;
  };
  const station = (x: number, z: number, townId: number): Station => {
    const id = g.stations.nextId, p = g.stations.planRail(x, z, Math.PI / 2, 12, 2, 1, { style: 'none' });
    const error = p.ok ? g.stations.commitRail(p, 1) : p.error;
    if (error) throw new Error(`station ${x},${z}: ${error}`);
    const st = g.stations.get(id)!; st.townId = townId; return st;
  };
  const C = town('Dense City', 256, 256, 8000, 120, 64), W = town('West Town', 20, 256, 2000, 48, 48);
  const far = station(54, 256, W.id), J = station(115, 272, C.id);
  const ea = stationEnds(g, far)[0].front, eb = stationEnds(g, J)[0].back, e0 = g.world.net.nextEdge;
  if (!build(g, nodeSnap(g, ea, 'rail'), nodeSnap(g, eb, 'rail'), railOpts(1))) throw new Error('main line build');
  for (const s of [far, J]) connectStationThroat(g, s.id, 1);
  let dep = -1;
  for (const e of [...g.world.net.edges.values()].filter((q) => q.id >= e0 && q.owner === 1 && q.station < 0 && q.depot < 0 && q.len > 15)) { dep = buildDepotOnLine(g, e.id, e.len * 0.3, 1); if (dep >= 0) break; }
  if (dep < 0) throw new Error('main line depot');
  const main: Line = g.lines.create('rail', 1); main.stops = outAndBack([far.id, J.id]); autoSignalLine(g, main.id, 1);
  if (!(g.vehicles.buyTrain(dep, [M('diesel_b'), M('coach_ic'), M('coach_ic')], main.id) instanceof Train)) throw new Error('main line train');
  (g.ais[0] as AnyAI).adoptLines();
  const geometry = new Map([...g.world.net.edges.values()].filter((e) => e.owner === 1 && e.kind === 'rail').map((e) => [e.id, JSON.stringify({ bez: e.bez, prof: [...e.prof], a: e.a, b: e.b })]));
  return { g, ai: g.ais[0] as AnyAI, C, J, main, geometry };
}
const opened = (ai: AnyAI) => ai.stats.urban > 0;

// ------------------------------------------------------------------ 1. saved at every tick around the through service
{
  console.log('the through service, saved at every tick from the city railway\'s completion to after it');
  const { g, ai, geometry } = scenario();
  g.aiEnabled = true; AIController.forceBuild = true;
  ai.startProject('metro', [0]);
  let ticks = 0;
  while ((!opened(ai) || ai.project) && ai.busy && ticks++ < 200000) g.stepTick();
  check(opened(ai) && !ai.project && !!ai.state.through, `the city railway is a finished project when the through service is planned (${ai.log.slice(-1)[0] ?? ''})`);
  const saves: { tick: number; through: boolean; data: string }[] = [];
  let after = 0, roundTripErrors = 0;
  while (after < 3 && ticks++ < 200000) {
    const data = JSON.stringify(serialize(g));
    if (JSON.stringify(serialize(deserialize(JSON.parse(data)))) !== data) { roundTripErrors++; if (roundTripErrors === 1) console.log(`  round trip differs at tick ${g.tick}`); }
    saves.push({ tick: g.tick, through: !!ai.state.through, data });
    g.stepTick();
    if (!ai.busy) after++;
  }
  AIController.forceBuild = false;
  const during = saves.filter((s) => s.through);
  console.log(`  ${saves.length} saves (${during.length} while the through job was pending): ${ai.log.filter((l: string) => /through service/.test(l)).join(' | ')}`);
  check(roundTripErrors === 0 && during.length >= 1, `every save during and after the through job loads exactly (${saves.length - roundTripErrors}/${saves.length}, ${during.length} with the job pending)`);
  check(ai.stats.through === 1, `the through service opens (${ai.stats.through})`);
  // the loaded games go on exactly as the original: 30 days in step (every save with the job pending, the last few after)
  const replays = [...during.filter((_, i) => i % Math.max(1, Math.ceil(during.length / 12)) === 0), ...saves.slice(-2)]
    .map((s) => ({ tick: s.tick, g: deserialize(JSON.parse(s.data)) }));
  const end = g.day + 30;
  while (g.day < end) { g.stepTick(); for (const r of replays) while (r.g.tick < g.tick) r.g.stepTick(); }
  const ref = JSON.stringify(serialize(g));
  const differ = replays.filter((r) => JSON.stringify(serialize(r.g)) !== ref).map((r) => r.tick);
  check(!differ.length, `games saved at ${replays.length} ticks around the through service replay 30 days exactly (${differ.length ? 'differ: ' + differ.join(',') : 'identical'})`);
  const t = [...g.vehicles.trains()].find((v) => v.cars[0]?.id.startsWith('emu_'));
  check(!!t && lineCompatibility(g, t.lineId!, t.cars) === null, 'the through unit runs its whole route');
  check([...geometry].every(([id, geo]) => { const e = g.world.net.edges.get(id); return !!e && JSON.stringify({ bez: e.bez, prof: [...e.prof], a: e.a, b: e.b }) === geo; }), 'the main line keeps all its track');
  const cityStations = [...g.stations.map.values()].filter((s) => s.rail?.trackType === 'metro').length;
  check(cityStations === 5, `the city railway keeps its five stations (${cityStations})`);
}

// ------------------------------------------------------------------ 2. wiring that cannot be paid: nothing is built
{
  console.log('a through service whose wiring cannot be paid for');
  const { g, ai, J, main, geometry } = scenario();
  g.aiEnabled = true; AIController.forceBuild = true;
  ai.startProject('metro', [0]);
  let ticks = 0;
  while ((!opened(ai) || ai.project) && ai.busy && ticks++ < 200000) g.stepTick();
  // no money and no credit left for the connector, wire and unit
  const eco = g.company(1).economy;
  eco.money = 0; eco.loan = eco.maxLoan;
  const edges0 = g.world.net.edges.size, lines0 = g.lines.all().map((l) => `${l.id}:${l.stops.join(',')}`).join('|');
  while (ai.busy && ticks++ < 200000) g.stepTick();
  AIController.forceBuild = false;
  check(ai.stats.through === 0 && /not enough money/.test(ai.log.join('\n')), `no through service without the money for it (${ai.log.slice(-1)[0]})`);
  check(g.world.net.edges.size === edges0 && g.lines.all().map((l) => `${l.id}:${l.stops.join(',')}`).join('|') === lines0, 'no connector, wire or line left behind: the city railway and the main line as they were');
  check(lineCompatibility(g, main.id, [M('diesel_b'), M('coach_ic')]) === null && !!J.rail, 'the main line still runs its own trains');
  check([...geometry].every(([id]) => g.world.net.edges.has(id)), 'the main line keeps all its track');
}

// ------------------------------------------------------------------ 3. the exact ramp edge; split older track is not ours
{
  console.log('the join point: our ramp, not a track crossing above it; older track split by works stays');
  const g = Game.create({ size: 256, seed: 3, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000, aiCompanies: 1 });
  g.aiEnabled = false; g.world.h.fill(4); g.world.heightsVersion++;
  for (const c of g.companies) c.economy.money = 1e9;
  const net = g.world.net;
  const edge = (x0: number, z0: number, x1: number, z1: number, y: number, type: string) => {
    const a = net.nearestNode(x0, z0, 0.01, 'rail', (n) => n.y === y) ?? net.addNode('rail', x0, y, z0, 0, 0, 1);
    const b = net.nearestNode(x1, z1, 0.01, 'rail', (n) => n.y === y) ?? net.addNode('rail', x1, y, z1, 0, 0, 1);
    return net.addEdge('rail', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(y), [], type, 1);
  };
  const crossing = edge(110, 50, 110, 150, 8, 'electric');
  const stub = edge(95, 100, 100, 100, 4, 'metro'); stub.depot = 1;
  const ramp = edge(100, 100, 130, 100, 4, 'metro');
  g.depots.map.set(1, { id: 1, kind: 'rail', owner: 1, node: stub.b, edge: stub.id, x: 95, z: 100, y: 4, angle: 0 });
  const ai = g.ais[0] as AnyAI;
  const at = ai.rampJoin(1);
  const resnap = findSnap(g, 'rail', at.x, at.z, 0.3);
  console.log(`  join edge ${at?.edge} (the ramp ${ramp.id}; a re-snap at that spot would take edge ${resnap.kind === 'edge' ? resnap.edge : resnap.kind})`);
  check(at?.edge === ramp.id && Math.abs(at.y - 4) < 1e-6, 'the join point is on our ramp, at its height');
  // a project whose works split older own track: abandoning it removes its own track only
  const approach = edge(50, 70, 80, 70, 8, 'electric');
  ai.project = { kind: 'metro', towns: [], stations: [], edges: [], depots: [], line: -1, started: 0 };
  const e0 = net.nextEdge;
  const plan = planEdge(g, nodeSnap(g, approach.b, 'rail'), resnap, { kind: 'rail', type: 'metro', tracks: 1, heightOffset: 0, crossing: 'auto', owner: 1 });
  check(plan.ok && !commitProposal(g, plan), `works that split the older crossing (${plan.errors?.join('; ') ?? 'ok'})`);
  ai.track(e0);
  const pieces = [...net.edges.values()].filter((e) => e.type === 'electric' && e.id >= e0).map((e) => e.id);
  const laid = ai.project.edges.length;
  ai.abandon(ai.project);
  check(pieces.length >= 2 && pieces.every((id: number) => net.edges.has(id)) && laid > 0, `abandoning the works removes their own ${laid} edges and leaves the ${pieces.length} halves of the older crossing`);
}

console.log(`(${((performance.now() - T0) / 1000).toFixed(1)} s)`);
console.log(fails.length ? `\n${fails.length} FAILURES` : '\nALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
