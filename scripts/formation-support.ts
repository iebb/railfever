// Shared terrain cells must keep existing ground formations seated; road junction underpasses need every arm.
// Bundle as formation-support.mjs and run with Node.
import { Game } from '../src/game/game';
import { planEdge, commitProposal } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';
import { flatGame, build, free, railOpts, nodeSnap, station, endNode, check, fails } from './stationlib';
import { roadOpts, placeStationPair } from './lib';
import { terrainFit } from './terrainfit';
import { previewDemolition } from '../src/game/terraform';

// Exact first damaging railway from terrain-fit seed 5, construction step 1: a double-track cutting
// beside a town street end. A priced retaining wall cannot give their shared grid corners two heights.
{
  const g = Game.create({ size: 256, seed: 5, towns: 4, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  g.economy.money = 1e9;
  const before = JSON.stringify(serialize(g)), net = g.world.net;
  const counters = [net.version, net.nextNode, net.nextEdge, g.world.heightsVersion];
  const p = planEdge(g, free(g, 20.065146536813764, 198.16647517345916), free(g, 6, 220.26101749707085), railOpts(0, 2));
  check(!p.ok && p.errors.includes('Too close to road at another height'), 'refuse the original unsupported cutting beside the street');
  check(commitProposal(g, p) !== null, 'refused proposal cannot be committed');
  check(JSON.stringify(serialize(g)) === before, 'refusal preserves terrain, buildings, money, network and saved simulation state');
  check(JSON.stringify(counters) === JSON.stringify([net.version, net.nextNode, net.nextEdge, g.world.heightsVersion]), 'survey/refusal preserves network allocators and terrain versions');
  const fit = terrainFit(g);
  check(fit.covered === 0 && fit.floating === 0 && fit.station === 0, 'street and railway formations remain seated after refusal');
}

// Seed 11: a legal uphill departure shares distant grid corners with its level station.
// The actual rail widths remain seated even though the core's highest sample exceeds a corner's height.
{
  const g = Game.create({ size: 384, seed: 11, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 });
  g.aiEnabled = false; g.economy.money = 80_000_000;
  const quiet = new Set(g.towns.list.filter(t => t.pop < 500).map(t => t.id));
  const pair = placeStationPair(g, 60, 150, 0, quiet);
  check(pair?.TA.name === 'Oldbury Cross' && pair.TB.name === 'Greenhurst', 'native seed-11 graded station pair retains its original sites');
  if (pair) {
    const quote = (world: Game) => {
      const node = world.world.net.nearestNode(289.21402002923054, 143.13228494153756, 0.01, 'rail')!;
      return planEdge(world, nodeSnap(world, node.id, 'rail'), free(world, 269.80163428836755, 147.9446938859165), railOpts());
    };
    const before = JSON.stringify(serialize(g)), baseline = terrainFit(g), proposal = quote(g);
    check(proposal.ok && proposal.stats.maxGrade > 0.06, 'a legal steep departure is accepted using actual rail support');
    check(JSON.stringify(serialize(g)) === before, 'exact rail-support survey preserves the complete live save');
    const loaded = deserialize(JSON.parse(before)), cold = quote(loaded);
    check(JSON.stringify(proposal) === JSON.stringify(cold) && JSON.stringify(serialize(loaded)) === before,
      'cold support survey returns identical geometry and prices without state mutation');
    const cash = g.economy.money;
    check(commitProposal(g, proposal) === null && cash - g.economy.money === proposal.cost,
      'supported graded departure commits at its full native price');
    const fit = terrainFit(g);
    check(fit.station === baseline.station && fit.covered === baseline.covered && fit.floating === baseline.floating
      && JSON.stringify(fit.examples) === JSON.stringify(baseline.examples), 'graded departure adds no unsupported or covered rail and road surfaces');
    check(commitProposal(loaded, cold) === null && JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)),
      'cold graded-departure construction preserves exact saved state');
    let exact = true;
    for (let tick = 0; tick < 40; tick++) {
      g.stepTick(); loaded.stepTick();
      if (JSON.stringify(serialize(g)) !== JSON.stringify(serialize(loaded))) { exact = false; break; }
    }
    check(exact, 'graded-departure state continues exactly after loading');
  }
}

// Seed-5's native first profitable opening: its tunnel portal cutting misses the side street's axis,
// but reaches the street's bank. Every affected side arm needs a priced support before excavation.
{
  const g = Game.create({ size: 384, seed: 5, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1950, aiCompanies: 2 });
  g.aiEnabled = false; g.company(1).economy.money = 1e8;
  const st = station(g, 102.06736792903394, 233.30575226806104, 1.116883383580246, 10, 2, 1,
    { level: 'underground', fixedY: 1.5318828582763673, style: 'none', depth: 2.4 });
  check(!!st, 'native seed-5 underground station commits before its approach');
  if (st) {
    g.flushNetworkChanges(); g.stations.recomputeCatchment(); g.lines.flushCatchment();
    const quote = (world: Game) => planEdge(world, nodeSnap(world, endNode(world, world.stations.get(st.id)!, 1, true), 'rail'),
      free(world, 124.53582337504682, 244.26789210800717), railOpts(1, 1, { designGrade: 0.035, heightOffset: -0.503645100065027 }));
    const snapshot = JSON.stringify(serialize(g)), baseline = terrainFit(g), p = quote(g);
    const roads = [166, 209, 239, 240];
    check(p.ok && roads.every(id => p.roadBridges?.some(q => q.edge === id)) && (p.stats.costSplit?.bridges ?? 0) > 0,
      'portal cutting quotes paid supports on the actual undermined street and all affected side arms');
    check(JSON.stringify(serialize(g)) === snapshot, 'portal support survey preserves the entire live save');
    const loaded = deserialize(JSON.parse(snapshot)), cold = quote(loaded);
    check(JSON.stringify(p) === JSON.stringify(cold) && JSON.stringify(serialize(loaded)) === snapshot,
      'cold portal survey preserves native geometry, support intervals, prices and saved state');
    const blocked = deserialize(JSON.parse(snapshot));
    blocked.world.net.edges.get(239)!.depot = 7;
    const blockedBefore = JSON.stringify(serialize(blocked)), refusal = quote(blocked);
    check(!refusal.ok && refusal.errors.includes('Road facility blocks underpass bridge window'), 'portal support refuses a facility on a required side arm');
    check(commitProposal(blocked, refusal) !== null && JSON.stringify(serialize(blocked)) === blockedBefore,
      'blocked portal construction preserves roads, terrain, money and saved allocators');
    const end = free(g, 115.71227352760565, 239.5540822006755);
    const bore = planEdge(g, nodeSnap(g, endNode(g, st, 1, true), 'rail'), end,
      railOpts(1, 1, { designGrade: 0.035, heightOffset: 1.8802162408828735 - end.y }));
    check(bore.ok && bore.tracks.every(t => t.sections.some(s => s.type === 'tunnel' && s.s0 === 0 && s.s1 >= t.len))
      && !bore.roadBridges?.length, 'a fully covered tunnel keeps the native street bank without unnecessary bridge works');
    const cash = g.company(1).economy.money;
    check(commitProposal(g, p) === null && cash - g.company(1).economy.money === p.cost,
      'native portal construction pays its complete quoted structure and track cost');
    const fit = terrainFit(g), streetFit = terrainFit(g, roads.map(id => g.world.net.edges.get(id)!));
    check(fit.station === baseline.station && fit.covered === baseline.covered && fit.floating === baseline.floating
      && JSON.stringify(fit.examples) === JSON.stringify(baseline.examples) && streetFit.covered === 0 && streetFit.floating === 0,
      'the completed native portal and all supported street widths add zero terrain misfits');
    check(commitProposal(loaded, cold) === null && JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)),
      'cold portal construction charges identical costs and creates identical roads, terrain and IDs');
    let exact = true;
    for (let tick = 0; tick < 40; tick++) {
      g.stepTick(); loaded.stepTick();
      if (JSON.stringify(serialize(g)) !== JSON.stringify(serialize(loaded))) { exact = false; break; }
    }
    check(exact, 'native ticks after portal support construction replay exactly');
  }
}

// A support window wholly inside one road never traverses a neighbouring arm. The starting edge itself
// must also reject facility conversion, even when the cutting misses the road's axis.
{
  const g = flatGame(128, 3, x => 4 - Math.max(0, Math.min(20, x - 40)) * 0.1), net = g.world.net;
  check(!!build(g, free(g, 10, 66), free(g, 118, 66), roadOpts(0, 'street'), 'portal-side road'), 'fixture long portal-side road');
  const road = [...net.edges.values()].find(e => e.kind === 'road')!;
  const a = net.addNode('rail', 40, 1.6, 64, 1, 0), b = net.addNode('rail', 70, 2, 64, -1, 0);
  const quote = () => planEdge(g, nodeSnap(g, a.id, 'rail'), nodeSnap(g, b.id, 'rail'), railOpts(0, 1, { designGrade: 0.035 }));
  const clear = quote(), window = clear.roadBridges?.[0];
  check(clear.ok && clear.crossings.length === 0 && clear.roadBridges?.length === 1 && window?.edge === road.id
    && window.s0 > 0 && window.s1 < road.len, 'portal bank support starts and ends inside its sole affected road');
  for (const field of ['depot', 'station'] as const) {
    road[field] = 7;
    const before = JSON.stringify(serialize(g)), blocked = quote();
    check(!blocked.ok && blocked.errors.includes('Road facility blocks underpass bridge window'), `initial affected ${field} road refuses its own support window`);
    check(commitProposal(g, blocked) !== null && JSON.stringify(serialize(g)) === before, `initial ${field} refusal preserves all native state`);
    road[field] = -1;
  }
  check(commitProposal(g, clear) === null, 'the same portal bank support commits when its starting road is clear');
  const fit = terrainFit(g);
  check(fit.station === 0 && fit.covered === 0 && fit.floating === 0, 'supported starting road and portal cutting remain physically seated');
}

// A distant corner shared by two formation cores need not lie under either carriageway. Interpolation
// can seat this road safely, although flattening every shared vertex to the road's height is impossible.
{
  const g = flatGame(128), net = g.world.net;
  check(!!build(g, free(g, 12, 66), free(g, 116, 66), roadOpts(), 'parallel road'), 'fixture parallel road');
  const a = net.addNode('rail', 12, 2.6, 64), b = net.addNode('rail', 116, 2.6, 64);
  const p = planEdge(g, nodeSnap(g, a.id, 'rail'), nodeSnap(g, b.id, 'rail'), railOpts(0, 1, { straight: true }));
  check(p.ok, `interpolated road support permits the nearby cutting: ${p.errors.join(', ')}`);
  check(commitProposal(g, p) === null, 'supported nearby cutting commits');
  const fit = terrainFit(g);
  check(fit.covered === 0 && fit.floating === 0, 'actual road and rail widths stay seated despite shared distant corners');
}

// Minimized seed-61 opening failure: a depot's dead-end grading reaches the access street behind its shed.
// The ordinary building rectangle is clear; only the complete stub formation reveals the unsupported road.
{
  const g = flatGame(128, 3.4), net = g.world.net;
  check(!!build(g, free(g, 64.24391328973646, 61.21519428449045), free(g, 56.2670778312495, 62.41537130749497), roadOpts(0, 'street'), 'yard access street'), 'fixture yard access');
  const angle = 0.03962754411391082, fx = Math.sin(angle), fz = Math.cos(angle);
  const exit = net.addNode('rail', 64 + fx * 2.15, 3, 64 + fz * 2.15, fx, fz);
  const far = net.addNode('rail', exit.x + fx * 24, 3, exit.z + fz * 24, -fx, -fz);
  check(!!build(g, nodeSnap(g, exit.id, 'rail'), nodeSnap(g, far.id, 'rail'), railOpts(), 'yard approach'), 'fixture yard approach');
  const before = JSON.stringify(serialize(g));
  const plan = g.depots.plan('rail', 64, 64, angle, 0);
  check(!plan.ok && plan.error === 'Too close to road at another height', 'depot siting refuses the access-road cutting');
  check(g.depots.commit('rail', plan, 0) !== null && JSON.stringify(serialize(g)) === before, 'depot refusal preserves cash, terrain, roads and allocators');
  const safe = g.depots.plan('rail', far.x, far.z, angle, 0);
  check(safe.ok && g.depots.commit('rail', safe, 0) === null, 'the other free end remains a valid native depot site');
  const fit = terrainFit(g);
  check(fit.covered === 0 && fit.floating === 0, 'completed safe depot keeps its access road and approach seated');
}

// Forecast the actual clearance of a legitimate occupied depot site, including overlapping lot lock margins.
{
  const g = flatGame(128), w = g.world;
  const house = (x: number) => w.addBuilding({ townId: -1, x, z: 64, angle: 0, w: 2, d: 2, type: 0, floors: 1, pop: 0, seed: 1, y: 3, built: 0 });
  const removed = house(64), retained = house(66.5), before = JSON.stringify(serialize(g));
  const view = previewDemolition(w, [removed.id]), after = deserialize(serialize(g));
  after.world.removeBuilding(removed.id);
  check(w.lock.every((_, k) => view.lock[k] === after.world.lock[k]), 'sparse demolition lock forecast matches actual clearance, including retained neighbours');
  check(view.buildingsNear(64, 64, 4).every(b => b.id !== removed.id) && view.buildingsNear(64, 64, 4).some(b => b.id === retained.id)
    && JSON.stringify(serialize(g)) === before, 'clearance forecast preserves the live buildings, locks and saved state');
  const plan = g.depots.plan('rail', 64, 64, 0, 0, { snap: false, y: 3 });
  check(plan.ok && plan.demolish.includes(removed.id) && !plan.demolish.includes(retained.id) && plan.cost > 90_000, 'legitimate depot proposal prices only its required demolition');
  check(g.depots.commit('rail', plan, 0) === null && !w.buildings.has(removed.id) && w.buildings.has(retained.id)
    && terrainFit(g).covered === 0 && terrainFit(g).floating === 0, 'paid depot clearance keeps the neighbouring lot and seated physical formation');
}

// A cutting crossing a road junction can work when every branch has a complete bridge and its approaches.
{
  const g = flatGame(128), net = g.world.net;
  check(!!build(g, free(g, 64, 12), free(g, 64, 116), roadOpts(), 'junction trunk'), 'fixture trunk');
  const trunk = [...net.edges.values()].find(e => e.kind === 'road')!;
  const junction = net.splitEdge(trunk.id, trunk.len / 2)!.node;
  check(!!build(g, nodeSnap(g, junction.id, 'road'), free(g, 116, 64), roadOpts(), 'junction arm'), 'fixture junction arm');
  const a = net.addNode('rail', 12, 2, 38), b = net.addNode('rail', 116, 2, 90);
  const p = planEdge(g, nodeSnap(g, a.id, 'rail'), nodeSnap(g, b.id, 'rail'), railOpts(0, 1, { crossing: 'under', straight: true }));
  check(p.ok, `junction underpass has complete supports: ${p.errors.join(', ')}`);
  const roads = [...net.edges.values()].filter(e => e.kind === 'road');
  check(roads.every(e => p.roadBridges?.some(q => q.edge === e.id)), 'bridge quote includes every junction arm');
  const arm = roads.find(e => e.a === junction.id && net.nodes.get(e.b)!.x > 100)!;
  arm.depot = 7; // A road facility on any required arm makes this bridge window unavailable.
  const blockedBefore = JSON.stringify(serialize(g));
  const blocked = planEdge(g, nodeSnap(g, a.id, 'rail'), nodeSnap(g, b.id, 'rail'), railOpts(0, 1, { crossing: 'under', straight: true }));
  check(!blocked.ok && blocked.errors.includes('Road facility blocks underpass bridge window'), 'junction traversal refuses a facility on a required arm');
  check(commitProposal(g, blocked) !== null && JSON.stringify(serialize(g)) === blockedBefore, 'facility refusal makes no simulation or terrain changes');
  arm.depot = -1;
  check(commitProposal(g, p) === null, 'supported junction underpass commits');
  check(roads.every(e => e.sections.some(s => s.type === 'bridge')), 'every quoted arm receives its physical bridge');
  const fit = terrainFit(g);
  check(fit.covered === 0 && fit.floating === 0, 'junction approach terrain fits the completed railway and road bridges');
  const loaded = deserialize(serialize(g));
  check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), 'junction support structures round trip through saves');
  for (let tick = 0; tick < 16; tick++) { g.stepTick(); loaded.stepTick(); }
  check(JSON.stringify(serialize(loaded)) === JSON.stringify(serialize(g)), 'supported junction state replays exactly after load');
}

// Auto may use an at-grade alternative, but an explicit underpass cannot leave a road end over the cutting.
{
  const g = flatGame(128), net = g.world.net;
  check(!!build(g, free(g, 64, 60), free(g, 64, 80), roadOpts(), 'short road'), 'fixture road end');
  const a = net.addNode('rail', 12, 2, 64), b = net.addNode('rail', 116, 2, 64);
  const before = JSON.stringify(serialize(g));
  const under = planEdge(g, nodeSnap(g, a.id, 'rail'), nodeSnap(g, b.id, 'rail'), railOpts(0, 1, { crossing: 'under', straight: true }));
  check(!under.ok && under.errors.includes('Road end blocks underpass bridge window'), 'explicit underpass refuses an unsupported road end');
  check(commitProposal(g, under) !== null && JSON.stringify(serialize(g)) === before, 'road-end refusal is atomic');
  const auto = planEdge(g, nodeSnap(g, a.id, 'rail'), nodeSnap(g, b.id, 'rail'), railOpts(0, 1, { straight: true }));
  check(auto.ok && auto.crossings.some(c => c.mode === 'level'), `auto selects a feasible level crossing: ${auto.errors.join(', ')}`);
  check(commitProposal(g, auto) === null, 'auto level alternative commits');
  const fit = terrainFit(g);
  check(fit.covered === 0 && fit.floating === 0, 'automatic alternative keeps road and rail approaches seated');
}
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
