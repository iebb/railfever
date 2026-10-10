// Independent subway regressions: job replay, cross-slope cover, collision order, fleet funding and view work.
import { Game, TICKS_PER_DAY } from '../src/game/game';
import { AIController } from '../src/game/ai';
import { URBAN_PAYBACK, discountedPayback } from '../src/game/constants';
import { planEdge, commitProposal, SUBWAY_COVER, type Proposal, type BuildOptions } from '../src/game/construction';
import { subwayOpts } from '../src/game/subway';
import { bezLine, arcTable, bezPoint, bezDeriv, tAtS } from '../src/game/geom';
import { profAt } from '../src/game/network';
import { serialize, deserialize } from '../src/game/save';
import { Overlay } from '../src/render/overlay';
import type { Town } from '../src/game/towns';
import type { Station, StationPlan } from '../src/game/stations';
import { linearStops } from '../src/game/lines';
import { outerEnd, terminusOf } from '../src/game/ai-grow';
import { saveNetwork, loadNetwork, scheduleNetworkTask, networkProfile } from '../src/game/ai-network';
import { Train } from '../src/game/train';
import { check, fails, checkReservations } from './lib';
if (!process.argv[1]?.endsWith('subway-regression.mjs')) throw new Error('bundle as subway-regression.mjs');
function flatGame(ais = 0): Game {
  const g = Game.create({ size: 512, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 2000,
    ...(ais ? { aiConfigs: Array.from({ length: ais }, () => ({ startMoney: 100_000_000, accessPolicy: 'open' as const })) } : {}) });
  g.world.h.fill(4); g.world.heightsVersion++; g.aiAcquisitions = false;
  g.economy.money = 2e9;
  for (const ai of g.ais) ai.state.cooldown = 1e9;
  return g;
}
function road(g: Game, x0: number, z0: number, x1: number, z1: number) {
  const net = g.world.net, a = net.nearestNode(x0, z0, 0.01, 'road') ?? net.addNode('road', x0, 4, z0, 0, 0, -1);
  const b = net.nearestNode(x1, z1, 0.01, 'road') ?? net.addNode('road', x1, 4, z1, 0, 0, -1);
  net.addEdge('road', a.id, b.id, bezLine(x0, z0, x1, z1), new Float32Array(Math.ceil(Math.hypot(x1 - x0, z1 - z0)) + 1).fill(4), [], 'street', -1);
}
function newTown(g: Game, name: string, x: number, z: number, radius: number): Town {
  const t = { id: g.towns.list.length, name, x, z, angle: 0, pop: 0, radius, buildings: new Set<number>(), nextGrowthDay: 1e9, hasChurch: false,
    passGenMonth: 0, passTransMonth: 0, passGenLast: 0, passTransLast: 0, served: 0 } as unknown as Town;
  g.towns.list.push(t);
  return t;
}
/**
 * A dense quarter: 8-storey blocks of flats on a street grid turned by `rot` (no street runs along its axis), every
 * block built up around a courtyard, `size` units across, `pop` residents.
 */
function denseQuarter(g: Game, name: string, cx: number, cz: number, pop: number, size: number, rot: number, existing?: Town): Town {
  const t = existing ?? newTown(g, name, cx, cz, size * 0.6);
  const c = Math.cos(rot), s = Math.sin(rot), half = size / 2, step = 8;
  const P = (u: number, v: number) => ({ x: cx + u * c - v * s, z: cz + u * s + v * c });
  for (let v = -half; v <= half; v += step) for (let u = -half; u + step <= half; u += step) { const a = P(u, v), b = P(u + step, v); road(g, a.x, a.z, b.x, b.z); }
  for (let u = -half; u <= half; u += step) for (let v = -half; v + step <= half; v += step) { const a = P(u, v), b = P(u, v + step); road(g, a.x, a.z, b.x, b.z); }
  const lots: { x: number; z: number }[] = [];
  for (let v = -half; v < half; v += step) for (let u = -half; u < half; u += step) for (const du of [1.6, 3.2, 4.8, 6.4]) for (const dv of [1.6, 3.2, 4.8, 6.4]) {
    if (du > 1.7 && du < 6.3 && dv > 1.7 && dv < 6.3) continue;
    const p = P(u + du, v + dv);
    if (Math.hypot(p.x - cx, p.z - cz) <= half) lots.push(p);
  }
  let remaining = pop;
  lots.forEach((p, i) => {
    const count = Math.ceil(remaining / (lots.length - i)); remaining -= count;
    t.buildings.add(g.world.addBuilding({ townId: t.id, x: p.x, z: p.z, angle: rot, w: 1.4, d: 1.4, type: 4, floors: 8, pop: count, seed: i, y: 4, built: 0 }).id);
  });
  t.pop += pop;
  g.demand.rebuild();
  return t;
}

const saved = (g: Game) => JSON.stringify(serialize(g));
const only = process.argv[2];
const run = (name: string) => !only || only === name;
// #3: every bore, across its full width, including fixed endpoints.
if (run('geometry')) {
  const g = flatGame(), w = g.world;
  for (let z = 121; z <= w.size; z++) for (let x = 100; x <= 150; x++) w.h[w.vi(x, z)] = -6;
  w.heightsVersion++;
  const p = planEdge(g, { kind: 'free', x: 102, z: 120, y: 0 }, { kind: 'free', x: 148, z: 120, y: 0 }, subwayOpts('lightrail', 2, 0, 2.2));
  let cover = Infinity;
  for (const tp of p.tracks) {
    const tab = arcTable(tp.bez), q = { x: 0, z: 0 };
    for (let k = 0; k <= Math.ceil(tp.len / 0.25); k++) {
      const s = Math.min(tp.len, k * 0.25), t = tAtS(tab, s);
      bezPoint(tp.bez, t, q);
      const d = bezDeriv(tp.bez, t), l = Math.hypot(d.x, d.z) || 1;
      for (const off of [-0.32, -0.16, 0, 0.16, 0.32]) cover = Math.min(cover, w.heightAt(q.x - d.z / l * off, q.z + d.x / l * off) - profAt(tp.prof, tp.len, s));
    }
  }
  check(!p.ok || cover >= SUBWAY_COVER - 1e-5, `#3 cross-slope subway covers every bore (accepted ${p.ok}, least cover ${cover.toFixed(3)})`);
  if (p.ok && cover >= SUBWAY_COVER - 1e-5) check(!commitProposal(g, p), 'safe cross-slope proposal commits');
  {
    const h = flatGame(), net = h.world.net;
    const end = (x: number, z: number, y: number, before: boolean) => {
      const a = net.addNode('rail', x - (before ? 10 : 0), y, z, 1, 0, 0), b = net.addNode('rail', x + (before ? 0 : 10), y, z, 1, 0, 0);
      net.addEdge('rail', a.id, b.id, bezLine(a.x, z, b.x, z), new Float32Array(11).fill(y), [{ s0: 0, s1: 10, type: 'tunnel' }], 'lightrail', 0);
      return before ? b : a;
    };
    const a = [end(80, 119.51, 1.8, true), end(80, 120.49, 3.5, true)], b = [end(110, 119.51, 1.8, false), end(110, 120.49, 3.5, false)];
    const q = planEdge(h, { ...a[0], kind: 'node', node: a[0].id, group: a.map((n) => n.id) },
      { ...b[0], kind: 'node', node: b[0].id, group: b.map((n) => n.id).reverse() }, subwayOpts('lightrail', 2, 0, 2.2));
    check(!q.ok, '#3 strict cover checks the actual height of every snapped bore end');
  }
  // #4: the 0.05-unit overlap is refused in both orders, and an actually separated pair is accepted.
  for (const depth of [3.55, 3.7, 4]) for (const first of ['depot', 'station']) {
    const h = flatGame();
    const depot = () => h.depots.plan('rail', 128, 128, Math.PI / 2, 0, { level: 'underground', depth: 2.2, snap: false });
    const station = () => h.stations.planRail(128, 128, 0, 7, 2, 0, { trackType: 'lightrail', level: 'underground', depth, style: 'none' });
    let accepted: boolean;
    if (first === 'depot') { check(!h.depots.commit('rail', depot(), 0), 'fixture depot'); accepted = station().ok; }
    else { check(!h.stations.commitRail(station(), 0), 'fixture station'); accepted = depot().ok; }
    check(accepted === (depth >= 3.7), `#4 station depth ${depth}, ${first} first: actual volumes agree (accepted ${accepted})`);
  }
  // A growth preview through a cavern that will move must ignore both its track and its volume.
  {
    const h = flatGame(), net = h.world.net, id = h.depots.nextId;
    const depot = h.depots.plan('rail', 180, 180, Math.PI / 2, 0, { level: 'underground', depth: 2.2, snap: false });
    check(depot.ok && !h.depots.commit('rail', depot, 0), 'ignored cavern fixture builds');
    const d = h.depots.get(id)!;
    const preview = (ignore?: BuildOptions['ignore']) => net.withTemporaryNodes('rail', [
      { x: 174, y: d.y, z: 180, dx: 1, dz: 0 }, { x: 186, y: d.y, z: 180, dx: -1, dz: 0 },
    ], 0, (nodes) => planEdge(h, { ...nodes[0], kind: 'node', node: nodes[0].id }, { ...nodes[1], kind: 'node', node: nodes[1].id },
      { ...subwayOpts('lightrail', 1, 0, 2.2), ...(ignore ? { ignore } : {}) }));
    check(!preview().ok, 'growth preview refuses an existing cavern at the same depth');
    check(!preview({ edges: new Set([d.edge]) }).ok, 'ignoring a cavern track still checks the cavern volume');
    check(preview({ edges: new Set([d.edge]), depots: new Set([d.id]) }).ok, 'growth preview ignores a relocated cavern and its tunnel track together');
  }
  // #6: count station visits, independent of machine timing, and verify cache invalidation/purity.
  const h = flatGame(), overlay = new Overlay(h), count = 1000;
  for (let i = 0; i < count; i++) {
    const x = 10 + i % 40 * 5, z = 10 + Math.floor(i / 40) * 5;
    h.stations.map.set(i, { id: i, x, z, rail: { x, z, y: 1.8, length: 7, tracks: 2, through: 0, throughMode: 'middle', platformStyle: 'side', level: 'underground', angle: 0, depth: 2.2 } } as Station);
  }
  let visits = 0;
  const values = h.stations.map.values.bind(h.stations.map);
  h.stations.map.values = function* () { for (const st of values()) { visits++; yield st; } } as typeof h.stations.map.values;
  overlay.setUnderground(true);
  check(visits <= 2 * count, `#6 view rebuild visits stations linearly (${visits} for ${count})`);
  const v0 = visits; overlay.setUnderground(true);
  check(visits === v0, 'unchanged underground view reuses geometry');
  h.networkVersion++; overlay.setUnderground(true);
  check(visits - v0 <= 2 * count, 'changed underground view generates boxes once');
  overlay.dispose();
}
// #2: obtain the options from the real AI preview, then stress them with the validator's shallow valley.
if (run('links')) {
  const g = flatGame(1), T = denseQuarter(g, 'Valley City', 256, 256, 14000, 120, Math.PI / 4), ai = g.ais[0], net = g.world.net;
  let observed: BuildOptions | undefined;
  const preview = net.withTemporaryNodes.bind(net);
  net.withTemporaryNodes = (kind, pts, owner, build) => preview(kind, pts, owner, (nodes) => {
    const result = build(nodes);
    const proposal = result as Proposal | null;
    if (pts.length === 4 && proposal?.opts?.level === 'underground') observed = { ...proposal.opts };
    return result;
  });
  g.aiEnabled = true; ai.startProject('lightrail', [T.id]);
  let ticks = 0;
  while (!observed && ai.busy && ticks++ < 50000) g.stepTick();
  check(!!observed, 'fixture reaches an actual underground AI link preview');
  if (observed) {
    const h = flatGame(), w = h.world, n = w.net;
    for (let z = 0; z <= w.size; z++) for (let x = 108; x <= 122; x++) w.h[w.vi(x, z)] = 1.1;
    w.heightsVersion++;
    const house = w.addBuilding({ townId: -1, x: 115, z: 120, angle: 0, w: 1.4, d: 1.4, type: 1, floors: 2, pop: 20, seed: 1, y: 1.1, built: 0 });
    const a = n.addNode('rail', 100, 1.8, 120, 1, 0, 1), b = n.addNode('rail', 130, 1.8, 120, -1, 0, 1);
    const p = planEdge(h, { kind: 'node', x: a.x, y: a.y, z: a.z, node: a.id }, { kind: 'node', x: b.x, y: b.y, z: b.z, node: b.id }, observed);
    check(!p.ok || (p.demolish.length === 0 && p.tracks.every((t) => t.sections.length === 1 && t.sections[0].type === 'tunnel' && t.sections[0].s1 >= t.len - 0.01)),
      `#2 actual preview options refuse a surfaced valley link (accepted ${p.ok}, demolition ${p.demolish.includes(house.id)})`);
  }
  let plannedPlatforms = 0;
  while (ai.busy && ticks++ < 50000) {
    const task = (ai as unknown as { urbanTask: { stage: string; plans: StationPlan[] } | null }).urbanTask;
    if (task?.stage === 'stations') plannedPlatforms = task.plans.length;
    if (plannedPlatforms && g.stations.map.size >= plannedPlatforms) break;
    g.stepTick();
  }
  const stations = [...g.stations.map.values()].filter((s) => s.owner === 1 && s.rail);
  check(plannedPlatforms >= 3 && stations.length === plannedPlatforms, 'fixture reaches construction with all planned platforms');
  if (plannedPlatforms >= 3 && stations.length === plannedPlatforms) {
    const a = stations[0], b = stations[1], cx = (a.x + b.x) / 2, cz = (a.z + b.z) / 2;
    const angle = a.rail!.angle, ux = Math.sin(angle), uz = Math.cos(angle), gap = Math.hypot(a.x - b.x, a.z - b.z) - a.rail!.length;
    for (let z = Math.floor(cz - gap); z <= Math.ceil(cz + gap); z++) for (let x = Math.floor(cx - gap); x <= Math.ceil(cx + gap); x++) {
      if (Math.abs((x - cx) * ux + (z - cz) * uz) < gap / 2 - 2 && Math.abs((x - cx) * uz - (z - cz) * ux) < 4) g.world.h[g.world.vi(x, z)] = 1.1;
    }
    g.world.heightsVersion++;
    const house = g.world.addBuilding({ townId: -1, x: cx, z: cz, angle, w: 0.4, d: 0.4, type: 1, floors: 2, pop: 1, seed: 9, y: 1.1, built: 0 });
    let surfaced = false;
    while (ai.busy && ticks++ < 60000) {
      const from = net.nextEdge; g.stepTick();
      for (let id = from; id < net.nextEdge; id++) {
        const e = net.edges.get(id);
        if (e?.owner === 1 && e.kind === 'rail' && e.station < 0 && e.depot < 0 && !(e.sections.length === 1 && e.sections[0].type === 'tunnel' && e.sections[0].s0 < 0.01 && e.sections[0].s1 >= e.len - 0.01)) surfaced = true;
      }
    }
    check(!surfaced && g.world.buildings.has(house.id), `#2 real AI construction stays underground after a valley appears (surfaced ${surfaced}, house kept ${g.world.buildings.has(house.id)})`);
  }
}
// #1: save during planning and partial construction, retaining the station and money already spent.
if (run('jobs')) {
  const g = flatGame(1), T = denseQuarter(g, 'Replay City', 256, 256, 14000, 120, Math.PI / 4), ai = g.ais[0];
  g.aiEnabled = true; ai.startProject('lightrail', [T.id]);
  const copies: { tick: number; game: Game }[] = [];
  let last = '', ticks = 0;
  while (ai.busy && ticks++ < 50000) {
    g.stepTick();
    const project = (ai as unknown as { project: { stations: number[]; edges: number[]; depots: number[]; line: number } | null }).project;
    const key = project ? `${project.stations.length}:${project.edges.length}:${project.depots.length}:${project.line}` : 'finished';
    if (g.tick === 8 || (project?.stations.length && key !== last) || key === 'finished') {
      const data = saved(g), loaded = deserialize(JSON.parse(data));
      const restored = saved(loaded);
      if (data !== restored) { let at = 0; while (data[at] === restored[at]) at++; console.log('round-trip difference', data.slice(at - 90, at + 160), restored.slice(at - 90, at + 160)); }
      check(data === restored, `#1 in-flight round trip at tick ${g.tick} (${key})`);
      if (copies.length < 20) copies.push({ tick: g.tick, game: loaded });
    }
    last = key;
  }
  check(ai.stats.urban === 1 && copies.length >= 8, `replay fixture opens a railway (${copies.length} saved work units)`);
  const target = g.tick + 80 * TICKS_PER_DAY;
  while (g.tick < target) g.stepTick();
  const reference = saved(g);
  for (const copy of copies) {
    while (copy.game.tick < target) copy.game.stepTick();
    check(saved(copy.game) === reference, `#1 save at tick ${copy.tick} replays to ${target} exactly`);
  }
}
// Subway + linegrow: the real saved urban job opens a line with its cavern on a siding beside it (2.11; 2.10 opened a
// tail/cavern terminus), then the saved daily growth task carries its line on from a free terminus through a dense new
// district.
if (run('growth')) {
  const g = flatGame(1), T = denseQuarter(g, 'Growing Subway', 256, 256, 8000, 120, Math.PI / 4), ai = g.ais[0];
  const checkpoints = (label: string) => {
    const copies: { key: string; data: string }[] = [], seen = new Set<string>();
    return {
      copies,
      capture(key: string) {
        if (seen.has(key)) return;
        seen.add(key);
        const data = saved(g), loaded = deserialize(JSON.parse(data));
        check(saved(loaded) === data, `${label}: ${key} round-trips exactly`);
        copies.push({ key, data });
      },
      replay() {
        const target = g.tick, reference = saved(g);
        for (const copy of copies) {
          const loaded = deserialize(JSON.parse(copy.data));
          while (loaded.tick < target) loaded.stepTick();
          const actual = saved(loaded);
          if (actual !== reference) {
            let i = 0; while (actual[i] === reference[i]) i++;
            console.log(`  ${label} ${copy.key} mismatch at ${i}: ${reference.slice(i - 60, i + 120)} vs ${actual.slice(i - 60, i + 120)}`);
          }
          check(actual === reference, `${label}: ${copy.key} replays exactly through completion`);
        }
      },
    };
  };
  const urban = checkpoints('subway opening');
  // A dense district supports the opening and later growth at the real economic gate.
  g.aiEnabled = true;
  check(ai.startProject('metro', [T.id]), 'growth: underground city project starts');
  let ticks = 0;
  while (ai.busy && ticks++ < 60000) {
    g.stepTick();
    const task = (ai as unknown as { urbanTask: { stage: string; fork?: number; at: number } | null }).urbanTask;
    if (task && ['yardUnder', 'yardSide', 'evaluate', 'approve', 'buildTail', 'buildYard', 'throat', 'finish', 'sideDepot', 'fleet'].includes(task.stage))
      urban.capture(task.stage === 'fleet' ? `fleet:${task.at}` : task.stage);
  }
  // (2.11, the user's depot rule: no depot on the way on beyond a terminus. The opening plans its cavern siding beside
  // the line ('yardSide') and builds it after directional running ('sideDepot'); 2.10 built a tail and a cavern beyond a
  // terminus in 'buildTail' and 'buildYard'. The saves still cross the depot's planning and its build.)
  check(ai.stats.urban === 1 && urban.copies.some((c) => c.key === 'yardSide') && urban.copies.some((c) => c.key === 'sideDepot'),
    'growth: saved opening crosses both the cavern planning and the cavern build boundaries');
  console.log(`  opening: ${urban.copies.map((c) => c.key).join(', ')}; ${ai.log.slice(-2).join(' | ')}`);
  urban.replay();
  g.aiEnabled = false;
  ai.state.cooldown = 1e9;
  const line = g.lines.all().find((l) => l.owner === ai.companyId && l.kind === 'rail');
  const path = line ? linearStops(line.stops) ?? [] : [];
  const ends = path.length >= 2 ? [[0, 1], [path.length - 1, path.length - 2]].map(([i, j]) => {
    const st = g.stations.get(path[i])!, neighbour = g.stations.get(path[j])!;
    return { st, index: i, te: terminusOf(g, st, outerEnd(st, neighbour), ai.companyId)! };
  }) : [];
  const oldDepot = line?.vehicles.length ? (g.vehicles.get(line.vehicles[0]) as Train).depotId : -1, cavern = g.depots.get(oldDepot);
  // (the line grows from the terminus farther from its cavern)
  const yard = cavern ? [...ends].sort((a, b) => Math.hypot(b.st.x - cavern.x, b.st.z - cavern.z) - Math.hypot(a.st.x - cavern.x, a.st.z - cavern.z))[0] : undefined;
  check(!!line && path.every((id) => g.stations.get(id)?.rail?.level === 'underground'), 'growth: AI opens an underground city line');
  // (2.11: both termini are free ends and the cavern stands on a siding beside the line; 2.10: a level four-unit tail
  // at one terminus with the cavern branch turned aside)
  check(!!yard && ends.length === 2 && ends.every((e) => e.te.kind === 'free' && !e.te.depots.length),
    'growth: both termini are free ends, no depot beyond either');
  if (line && yard && cavern) {
    const net = g.world.net;
    check(cavern.level === 'underground', 'growth: the siding ends in a cavern');
    check(ends.every((e) => e.te.kind === 'tail' || e.te.kind === 'free'), 'growth: both initial termini remain extendable');
    const allTunnel = (ids: number[]) => ids.every((id) => {
      const e = net.edges.get(id);
      return !!e && e.sections.length === 1 && e.sections[0].type === 'tunnel' && e.sections[0].s0 < 0.01 && e.sections[0].s1 >= e.len - 0.01;
    });
    // the cavern's siding: from the depot track to its junction with the line
    const siding: number[] = [];
    for (let id = cavern.edge, node = -1, k = 0; k < 16; k++) {
      const e = net.edges.get(id);
      if (!e || e.station >= 0) break;
      siding.push(id);
      node = node < 0 ? ((net.nodes.get(e.a)?.edges.length ?? 0) === 1 ? e.b : e.a) : (e.a === node ? e.b : e.a);
      const next = net.nodes.get(node)?.edges.filter((x) => x !== id) ?? [];
      if (next.length !== 1) break;
      id = next[0];
    }
    const lead = siding.filter((id) => net.edges.get(id)!.depot < 0);
    check(lead.length > 0 && allTunnel(lead), `growth: the cavern siding has no portals (${lead.length} edges)`);
    // Serve the original district's demand before asking where to build: the growth fix compares
    // a new district with buying trains on the current route, and that alternative must be satisfied.
    const cars = (g.vehicles.get(line.vehicles[0]) as Train).cars;
    for (let i = line.vehicles.length; i < 6; i++) check(g.vehicles.buyTrain(oldDepot, [...cars], line.id) instanceof Train, 'growth: initial district fleet funded');
    const info = (ai as unknown as { lines: Map<number, { maxVehicles: number }> }).lines.get(line.id)!;
    info.maxVehicles = 20;
    const settled = g.tick + 30 * TICKS_PER_DAY;
    while (g.tick < settled) g.stepTick();
    const { ux, uz } = yard.te;
    denseQuarter(g, T.name, yard.st.x + ux * 50, yard.st.z + uz * 50, 40000, 32, Math.atan2(uz, ux) + Math.PI / 4, T);
    // Growing town boundaries include the new district, as they do during ordinary town growth.
    T.radius = Math.max(T.radius, Math.hypot(yard.st.x + ux * 50 - T.x, yard.st.z + uz * 50 - T.z) + 32 * 0.6);
    const buildings = [...g.world.buildings.keys()], e0 = net.nextEdge;
    scheduleNetworkTask(ai, 'extend', 0);
    const state = saveNetwork(g);
    for (const [, company] of state.companies) { company.next = company.next.map(([task]) => [task, g.day + 1e9]); company.job = null; company.care = company.care.filter(([key]) => key !== 'grow' + line.id); }
    loadNetwork(g, state);
    scheduleNetworkTask(ai, 'extend', 0);
    const growing = checkpoints('subway extension');
    g.aiEnabled = true;
    const extended = () => (ai.stats as unknown as { netExtended?: number }).netExtended ?? 0;
    const limit = g.day + 300;
    let reviewed = false;
    while (!extended() && g.day < limit) {
      g.stepTick();
      const job = saveNetwork(g).companies.find(([id]) => id === ai.companyId)?.[1].job;
      if (job?.task === 'extend') reviewed = true;
      if (reviewed && !job) break;
      const cursor = job?.task === 'extend' ? job.items?.[job.cursor]?.grow : undefined;
      if (cursor) {
        const key = cursor.made ? `build:${cursor.at}:${cursor.made.stations.length}:${cursor.made.links.length}`
          : cursor.at <= 2 ? `survey/value:${cursor.at}` : cursor.best ? 'valued winner' : '';
        if (key) growing.capture(key);
      }
    }
    const after = linearStops(line.stops) ?? [], added = after.filter((id) => !path.includes(id));
    console.log(`  growth: ${path.length} -> ${after.length} stations; ${ai.log.slice(-3).join(' | ')}`);
    console.log('  growth decisions: ' + JSON.stringify(Object.fromEntries(Object.entries(networkProfile.decisions).filter(([key]) => key.startsWith('extend.')))));
    check(extended() === 1 && added.length > 0, 'growth: the daily network task extends the subway through the new district');
    check(added.every((id) => g.stations.get(id)?.rail?.level === 'underground'), 'growth: every added station stays underground');
    const running = [...net.edges.values()].filter((e) => e.id >= e0 && e.kind === 'rail' && e.owner === ai.companyId).map((e) => e.id);
    check(running.length > 0 && allTunnel(running), 'growth: every new link, tail and cavern stays in tunnel without portals');
    check(buildings.every((id) => g.world.buildings.has(id)), 'growth: buildings over the extension survive');
    // (2.11: the cavern beside the line stays where it is, nothing stands beyond the terminus the line runs on from;
    // 2.10 moved the cavern out of the running line to the new end)
    check(!!g.depots.get(oldDepot) && line.vehicles.every((id) => (g.vehicles.get(id) as Train).depotId === oldDepot),
      'growth: the cavern beside the line stays, every train at home there');
    const last = g.stations.get(after[yard.index === 0 ? 0 : after.length - 1])!, next = g.stations.get(after[yard.index === 0 ? 1 : after.length - 2])!;
    const terminus = terminusOf(g, last, outerEnd(last, next), ai.companyId);
    check(terminus?.kind === 'free' && !terminus.depots.length, `growth: the new terminus is a free end (${terminus?.kind})`);
    check(growing.copies.some((c) => c.key.startsWith('build:') && !c.key.endsWith(':0')), 'growth: replay checkpoints include built links');
    const served = new Set<number>(), target = g.tick + 160 * TICKS_PER_DAY;
    while (g.tick < target) {
      g.stepTick();
      for (const id of line.vehicles) { const t = g.vehicles.get(id) as Train; if (t.state === 'loading') served.add(t.atStation); }
    }
    check(after.every((id) => served.has(id)), 'growth: trains from the cavern beside the line call at every old and new station');
    check(checkReservations(g).length === 0, 'growth: reservations remain consistent');
    growing.replay();
    console.log(`  exact replay: ${urban.copies.length} opening checkpoints and ${growing.copies.length} growth checkpoints`);
  }
}
// #1b: independent standalone access repair, saved before and between its bounded work units.
if (run('repair')) {
  const g = flatGame(1), ai = g.ais[0];
  const p = g.stations.planRail(128, 128, 0, 10, 2, 1);
  check(p.ok && !g.stations.commitRail(p, 1), 'repair fixture station');
  const st = g.stations.all()[0], fc = g.stations.forecourt(st)!;
  road(g, fc.x - 6, fc.z - 25, fc.x - 6, fc.z + 25); g.stations.refreshAccess(true);
  check(!g.stations.hasAccess(st), 'fixture forecourt is initially isolated');
  g.aiEnabled = true; ai.daily();
  const copies: { tick: number; game: Game }[] = [];
  let ticks = 0;
  while (ai.busy && ticks++ < 400) {
    if (g.tick % 5 === 0 && copies.length < 12) {
      const data = saved(g), h = deserialize(JSON.parse(data));
      check(saved(h) === data, `#1b repair round trip at tick ${g.tick}`);
      copies.push({ tick: g.tick, game: h });
    }
    g.stepTick();
  }
  check(g.stations.hasAccess(st) && copies.length >= 2, `repair completes (${copies.length} checkpoints)`);
  const target = g.tick + 2 * TICKS_PER_DAY;
  while (g.tick < target) g.stepTick();
  const reference = saved(g);
  for (const c of copies) { while (c.game.tick < target) c.game.stepTick(); check(saved(c.game) === reference, `#1b repair saved at ${c.tick} replays exactly`); }
}
// #5: autonomous, capital-constrained selector; a service must buy the fleet it actually forecast.
if (run('funding')) for (const startMoney of [5_000_000, 100_000_000]) {
  const g = flatGame(1), T = denseQuarter(g, 'Natural Selector', 256, 256, startMoney === 5_000_000 ? 8000 : 14000, 120, Math.PI / 4), ai = g.ais[0];
  const eco = g.company(1).economy; eco.money = startMoney;
  ai.state.cooldown = 0; ai.config = { ...ai.config, focus: { rail: 2.5, road: 0.1, tram: 0.1 } };
  let approved: { total: number; net: number; fleet: number } | undefined, approvedMode: 'metro' | 'lightrail' = 'metro';
  const internals = ai as unknown as { urbanEconomics: (...args: unknown[]) => typeof approved };
  const economics = internals.urbanEconomics.bind(ai);
  internals.urbanEconomics = (...args) => { const r = economics(...args); if (args[5] !== undefined) { approved = r; approvedMode = args[1] as typeof approvedMode; } return r; };
  const failures: string[] = [], buy = g.vehicles.buyTrain.bind(g.vehicles);
  g.vehicles.buyTrain = (...args) => { const r = buy(...args); if (typeof r === 'string') failures.push(r); return r; };
  g.aiEnabled = true;
  while (g.day < 360 && !ai.stats.urban) g.stepTick();
  while (ai.busy && g.day < 720) g.stepTick();
  const line = g.lines.all().find((l) => l.owner === 1 && l.kind === 'rail');
  check(!line || (!!approved && line.vehicles.length >= approved.fleet && failures.length === 0), `#5 full forecast fleet funded at $${startMoney / 1e6}M (${line?.vehicles.length ?? 0}/${approved?.fleet ?? 0}, failures ${failures.join('; ')})`);
  // The investment gate discounts operating surplus at the actual borrowing rate. Deducting loan
  // interest again from that surplus would charge it twice. Assert the full discounted capital gate
  // on the funded opening, rather than fields from the older undiscounted quote.
  if (line && eco.loan > 0 && approved) {
    const horizon = URBAN_PAYBACK[approvedMode], presentYears = discountedPayback(horizon, eco.interestRate);
    check(presentYears < horizon && approved.net * presentYears >= approved.total,
      '#5 loan-funded railway repays its full capital at the actual borrowing rate');
  }
  if (startMoney === 100_000_000) check(!!line, 'profitable, well-funded subway still opens');
  console.log(`  selector: cash ${eco.money.toFixed(0)}, loan ${eco.loan}, forecast ${JSON.stringify(approved)}, ${ai.log.slice(-2).join(' | ')}`);
}
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
