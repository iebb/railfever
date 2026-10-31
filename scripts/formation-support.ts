// Shared terrain cells must keep existing ground formations seated; road junction underpasses need every arm.
// Bundle as formation-support.mjs and run with Node.
import { Game } from '../src/game/game';
import { planEdge, commitProposal } from '../src/game/construction';
import { serialize, deserialize } from '../src/game/save';
import { flatGame, build, free, railOpts, nodeSnap, check, fails } from './stationlib';
import { roadOpts } from './lib';
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
