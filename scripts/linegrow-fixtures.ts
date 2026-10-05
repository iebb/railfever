// Original 2cfdae3 city layouts, shared by the independent line-growth regressions.
import '../src/game/patterns';
import { Game } from '../src/game/game';
import { AIController } from '../src/game/ai';
import type { Town } from '../src/game/towns';
import type { Station } from '../src/game/stations';
import type { Line } from '../src/game/lines';
import { MODEL_BY_ID } from '../src/game/vehicle-types';
import { bezLine } from '../src/game/geom';
import { outAndBack, linearStops } from '../src/game/lines';
import { stationEnds, nodeSnap, depotAtEnd } from '../src/game/routing';
import { connectStationThroat, finishDoubleTrack } from '../src/game/trackops';
import { autoSignalLine } from '../src/game/signals';
import { planEdge, commitProposal } from '../src/game/construction';
import { outerEnd, planTerminusYard, buildTerminusYard } from '../src/game/ai-grow';
import { Train } from '../src/game/train';

const M = (id: string) => MODEL_BY_ID.get(id)!;
const stat = (ai: AIController, k: string) => (ai.stats as unknown as Record<string, number>)[k] ?? 0;
const runDays = (g: Game, days: number, each?: () => void) => { const end = g.day + days; while (g.day < end) { g.stepTick(); each?.(); } };

/** A flat world with one AI company (no projects of its own; the network task runs when a scenario says). */
function flat(companies = 1): { g: Game; ai: AIController; me: number } {
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    aiConfigs: Array.from({ length: companies }, () => ({ startMoney: 150_000_000, accessPolicy: 'open' as const })) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  // (the network tasks run when a scenario says: runNetworkTask, or g.aiEnabled for the daily work)
  g.aiEnabled = false;
  const ai = g.ais[0];
  for (const c of g.ais) c.state.cooldown = 1e9;
  return { g, ai, me: ai.companyId };
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  const len = Math.hypot(x1 - x0, z1 - z0);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(len) + 1).fill(4), [], 'street', -1);
}
function newTown(g: Game, name: string, x: number, z: number): Town {
  const t: Town = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius: 60, buildings: new Set(), nextGrowthDay: 1e9, hasChurch: false,
    passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 };
  g.towns.list.push(t);
  return t;
}
/**
 * A district of a town: a street grid every 8 units over [x0, x1] x [z - h/2, z + h/2] (rows along x; no street across
 * the railway's strip |dz| < 7 unless `cross`), apartment blocks on lots along the rows outside the strip, `pop` residents.
 * Lots near rail track or depots stay empty (the district grows around the railway).
 */
function district(g: Game, t: Town, x0: number, x1: number, z: number, h: number, pop: number, cross = false, strip = true) {
  const xs: number[] = [];
  for (let x = x0; x <= x1 + 1e-6; x += 8) xs.push(x);
  const zs: number[] = [];
  for (let k = 0; k * 8 <= h + 1e-6; k++) zs.push(z - h / 2 + k * 8 + 4);
  for (const rz of zs) for (let i = 1; i < xs.length; i++) road(g, xs[i - 1], rz, xs[i], rz);
  for (const rx of xs) for (let i = 1; i < zs.length; i++) { if (!cross && zs[i - 1] < z && zs[i] > z) continue; road(g, rx, zs[i - 1], rx, zs[i]); }
  const lots: { x: number; z: number; angle: number }[] = [];
  for (const rz of zs) for (let rx = x0 + 2; rx < x1; rx += 4) {
    if (strip && Math.abs(rz - z) < 7) continue;
    const near = g.world.net.edgesNear(rx - 2.5, rz + 1.1 - 2.5, rx + 2.5, rz + 1.1 + 2.5).some((e) => e.kind === 'rail')
      || g.depots.near(rx, rz + 1.1, 3).length > 0;
    if (near) continue;
    lots.push({ x: rx, z: rz + 1.1, angle: Math.PI });
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    const b = g.world.addBuilding({ townId: t.id, ...p, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i + t.buildings.size, y: 4, built: 0 });
    t.buildings.add(b.id);
  });
  t.pop += pop;
  let x = 0, zz = 0, n = 0;
  for (const id of t.buildings) { const b = g.world.buildings.get(id)!; x += b.x; zz += b.z; n++; }
  if (n) { t.x = x / n; t.z = zz / n; }
  t.radius = Math.max(t.radius, (x1 - x0) * 0.6);
  g.demand.rebuild();
}

/** A ground light-rail city line of `owner` along z = `z` with stations at `xs`, double track, signals and trains. */
function cityLine(g: Game, owner: number, xs: number[], z: number, depotAt: 'west' | 'east', yard: 'tail' | 'old', trains = 2): { line: Line; sts: Station[]; depot: number } {
  const type = 'lightrail', PL = 7, net = g.world.net;
  const sts: Station[] = [];
  for (const x of xs) {
    const id = g.stations.nextId, p = g.stations.planRail(x, z, Math.PI / 2, PL, 2, owner, { trackType: type, level: 'ground', style: 'none' });
    const err = p.ok ? g.stations.commitRail(p, owner) : p.error;
    if (err) throw new Error(`station at ${x}: ${err}`);
    sts.push(g.stations.get(id)!);
  }
  const e0 = net.nextEdge;
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = stationEnds(g, sts[i]).map((e) => e.front), b = stationEnds(g, sts[i + 1]).map((e) => e.back);
    const pj = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), { kind: 'rail', type, tracks: 2, heightOffset: 0, crossing: 'level', owner });
    if (!pj.ok || commitProposal(g, pj)) throw new Error(`track ${i}: ${pj.errors[0]}`);
  }
  const doubles = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id);
  const at = depotAt === 'west' ? sts[0] : sts[sts.length - 1], N = depotAt === 'west' ? sts[1] : sts[sts.length - 2];
  let depot = -1;
  if (yard === 'tail') {
    const y = planTerminusYard(g, owner, at, outerEnd(at, N), null, () => true);
    if (!y) throw new Error('no yard site');
    depot = buildTerminusYard(g, owner, y, () => true);
  } else {
    // the 2.7 layout: a ramp straight on from the first track, the other track joined to it
    const end = outerEnd(at, N), heads = stationEnds(g, at).map((e) => e[end]);
    const n0 = net.nodes.get(heads[0])!, sg = end === 'front' ? 1 : -1;
    const pj = planEdge(g, nodeSnap(g, heads[0], 'rail'), { kind: 'free', x: n0.x + 12 * sg, z: n0.z, y: 4 }, { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner });
    if (!pj.ok || commitProposal(g, pj)) throw new Error('old ramp: ' + pj.errors[0]);
    const endNode = net.nearestNode(n0.x + 12 * sg, n0.z, 0.1, 'rail', (n) => n.edges.length === 1)!;
    depot = depotAtEnd(g, endNode.id, owner);
    connectStationThroat(g, at.id, owner);
  }
  if (depot < 0) throw new Error('no depot');
  finishDoubleTrack(g, doubles, owner);
  const line = g.lines.create('rail', owner);
  line.stops = outAndBack(sts.map((s) => s.id));
  g.lines.rebuild();
  autoSignalLine(g, line.id, owner);
  for (let i = 0; i < trains; i++) { const t = g.vehicles.buyTrain(depot, [M('lrv_b')], line.id); if (!(t instanceof Train)) throw new Error(String(t)); }
  // (an AI company takes the line on as its own: AIController.adoptLines)
  (g.aiOf(owner) as unknown as { adoptLines(): void } | undefined)?.adoptLines();
  return { line, sts, depot };
}

function linePath(l: Line): number[] { return linearStops(l.stops) ?? []; }


function presholm(depotAt: 'west' | 'east', yard: 'tail' | 'old', trains: number, grow: number, companies = 1) {
  const { g, ai, me } = flat(companies);
  const t = newTown(g, 'Presholm', 220, 256);
  district(g, t, 150, 270, 256, 64, 7000);
  const { line, sts, depot } = cityLine(g, me, [158, 183, 208, 233, 258], 256, depotAt, yard, trains);
  runDays(g, 30);
  if (grow) district(g, t, 270, 342, 256, 64, grow);
  runDays(g, 5);
  return { g, ai, me, t, line, sts, depot };
}
function mainCityLine(g: Game, owner: number, xs: number[], z: number, depotAt: 'west' | 'east', yard: 'tail' | 'old', trains = 2): { line: Line; sts: Station[]; depot: number } {
  const type = 'standard', PL = 24, net = g.world.net;
  const sts: Station[] = [];
  for (const x of xs) {
    const id = g.stations.nextId, p = g.stations.planRail(x, z, Math.PI / 2, PL, 2, owner, { trackType: type, level: 'ground', style: 'none' });
    const err = p.ok ? g.stations.commitRail(p, owner) : p.error;
    if (err) throw new Error(`station at ${x}: ${err}`);
    sts.push(g.stations.get(id)!);
  }
  const e0 = net.nextEdge;
  for (let i = 0; i + 1 < sts.length; i++) {
    const a = stationEnds(g, sts[i]).map((e) => e.front), b = stationEnds(g, sts[i + 1]).map((e) => e.back);
    const pj = planEdge(g, nodeSnap(g, a[0], 'rail'), nodeSnap(g, b[0], 'rail'), { kind: 'rail', type, tracks: 2, heightOffset: 0, crossing: 'level', owner });
    if (!pj.ok || commitProposal(g, pj)) throw new Error(`track ${i}: ${pj.errors[0]}`);
  }
  const doubles = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.station < 0).map((e) => e.id);
  const at = depotAt === 'west' ? sts[0] : sts[sts.length - 1], N = depotAt === 'west' ? sts[1] : sts[sts.length - 2];
  let depot = -1;
  if (yard === 'tail') {
    const y = planTerminusYard(g, owner, at, outerEnd(at, N), null, () => true);
    if (!y) throw new Error('no yard site');
    depot = buildTerminusYard(g, owner, y, () => true);
  } else {
    // the 2.7 layout: a ramp straight on from the first track, the other track joined to it
    const end = outerEnd(at, N), heads = stationEnds(g, at).map((e) => e[end]);
    const n0 = net.nodes.get(heads[0])!, sg = end === 'front' ? 1 : -1;
    const pj = planEdge(g, nodeSnap(g, heads[0], 'rail'), { kind: 'free', x: n0.x + 12 * sg, z: n0.z, y: 4 }, { kind: 'rail', type, tracks: 1, heightOffset: 0, crossing: 'auto', owner });
    if (!pj.ok || commitProposal(g, pj)) throw new Error('old ramp: ' + pj.errors[0]);
    const endNode = net.nearestNode(n0.x + 12 * sg, n0.z, 0.1, 'rail', (n) => n.edges.length === 1)!;
    depot = depotAtEnd(g, endNode.id, owner);
    connectStationThroat(g, at.id, owner);
  }
  if (depot < 0) throw new Error('no depot');
  finishDoubleTrack(g, doubles, owner);
  const line = g.lines.create('rail', owner);
  line.stops = outAndBack(sts.map((s) => s.id));
  g.lines.rebuild();
  autoSignalLine(g, line.id, owner);
  for (let i = 0; i < trains; i++) { const t = g.vehicles.buyTrain(depot, [M('diesel_b'), M('coach_ic'), M('coach_ic')], line.id); if (!(t instanceof Train)) throw new Error(String(t)); }
  // (an AI company takes the line on as its own: AIController.adoptLines)
  (g.aiOf(owner) as unknown as { adoptLines(): void } | undefined)?.adoptLines();
  return { line, sts, depot };
}


export { flat, newTown, district, cityLine, mainCityLine, presholm, runDays, linePath, M, stat };
