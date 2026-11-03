// A synchronous station survey may retain immutable planned rail cores, never a safety decision or world view.
import { formationSupportError, FormationCorePreparation, previewDemolition } from '../src/game/terraform';
import { bezLine } from '../src/game/geom';
import { stationPose } from '../src/game/station-geometry';
import { serialize, deserialize } from '../src/game/save';
import { planEdge } from '../src/game/construction';
import { flatGame, check, done } from './stationlib';
import { build, free, roadOpts, checkReservations } from './lib';

function need(v: unknown, message: string): asserts v { if (!v) throw new Error(message); }
const g = flatGame(128), plan = g.stations.planRail(60, 60, Math.PI / 2, 10, 2, 0, { fixedY: 2.7, style: 'none' });
need(plan.ok, plan.error ?? 'native station survey');
const rails = plan.layout.trackOffsets.map(off => {
  const a = stationPose(plan, off, -plan.length / 2), b = stationPose(plan, off, plan.length / 2);
  return { kind: 'rail' as const, type: plan.trackType, bez: bezLine(a.x, a.z, b.x, b.z),
    prof: new Float32Array(Math.max(2, Math.ceil(plan.length) + 1)).fill(plan.y), sections: [] };
});
const core = new FormationCorePreparation(); let cases = 0, same = true;
const compare = (world = g.world, roads: Parameters<typeof formationSupportError>[1] = [],
  ignore: ReadonlySet<number> = new Set(), bridges: Parameters<typeof formationSupportError>[3] = [], terrain?: ReadonlyMap<number, number>) => {
  const a = new Map(), b = new Map(), inputs = [...rails, ...roads];
  const expected = formationSupportError(world, inputs, ignore, bridges, terrain, a);
  const actual = formationSupportError(world, inputs, ignore, bridges, terrain, b, core);
  cases++; same &&= expected === actual && JSON.stringify([...a]) === JSON.stringify([...b]);
  return actual;
};
const initial = JSON.stringify(serialize(g)), before = compare(), first = core.read(g.world.size, rails);
need(first, 'native core is prepared lazily by the first survey');
compare();
check(core.read(g.world.size, rails) === first, 'identical ordered native rail descriptors reuse exactly one readonly core map');
check(JSON.stringify(serialize(g)) === initial, 'warm formation preparation and safety reads preserve the complete saved world');

// Each road candidate retains its own geometry, joins, prospective grading and full-width support check.
for (const z of [56, 58, 62, 64]) for (const x of [45, 60, 75]) {
  const p = planEdge(g, free(g, x, z), free(g, x + 15, z + 3), roadOpts(0, 'street'));
  compare(g.world, p.tracks.map(t => ({ ...t, kind: 'road' as const, type: p.opts.type })));
}
check(same && cases === 14, 'all native road alternatives retain uncached support answers and conflict intervals');
need(build(g, free(g, 20, 62), free(g, 110, 62), roadOpts(0, 'street'), 'retained road'), 'native paid retained road');
const after = compare();
check(before !== after && after !== null, 'new native retained road invalidates the safety answer while the immutable core remains reusable');
check(core.read(g.world.size, rails) === first, 'retained network changes do not rebuild terrain-independent planned geometry');

const road = [...g.world.net.edges.values()].find(e => e.kind === 'road')!;
compare(g.world, [], new Set([road.id]));
compare(g.world, [], new Set(), [{ edge: road.id, s0: 0, s1: road.len }]);
for (const y of [2.4, 3.4]) {
  const terrain = new Map<number, number>();
  for (let z = 57; z <= 64; z++) for (let x = 53; x <= 67; x++) terrain.set(g.world.vi(x, z), y);
  compare(g.world, [], new Set(), [], terrain);
}
const house = g.world.addBuilding({ townId: -1, x: 61, z: 61, angle: 0, w: 1, d: 1, type: 4, floors: 1, pop: 5, seed: 7, y: 3, built: 0 });
compare(g.world); compare(previewDemolition(g.world, [house.id]));
g.world.setVertex(60, 60, 2.5); compare(g.world);
check(same, 'changed native terrain, demolition locks, ignored edges, bridge intervals and projected heights all recompute exact safety decisions');

const altered = rails.map(p => ({ ...p, prof: new Float32Array(p.prof).fill(3.1) }));
check(core.read(g.world.size, altered) === undefined, 'different native rail descriptor identities cannot reuse stale cores');
const reversed = [...rails].reverse();
check(core.read(g.world.size, reversed) === undefined, 'descriptor order is part of immutable core identity');
const other = flatGame(160);
check(core.read(other.world.size, rails) === undefined, 'a different native world size cannot reuse another terrain stride');
const a = formationSupportError(other.world, rails), b = formationSupportError(other.world, rails, undefined, undefined, undefined, undefined, core);
check(a === b && !!core.read(other.world.size, rails), 'the new native world size rebuilds its own exact core');

// Accepted native facilities still commit and resume exactly after quoted access/support preparation.
const f = flatGame(128); f.aiEnabled = false;
need(build(f, free(f, 15, 82), free(f, 115, 82), roadOpts(0, 'street'), 'access street'), 'native access street');
const p = f.stations.planRail(60, 70, Math.PI / 2, 10, 2, 0), cold = deserialize(serialize(f));
check(p.ok && JSON.stringify(p) === JSON.stringify(cold.stations.planRail(60, 70, Math.PI / 2, 10, 2, 0)), 'native full station/access quotes remain exact on cold construction');
need(!f.stations.commitRail(p, 0), 'native supported station commits');
need(!cold.stations.commitRail(cold.stations.planRail(60, 70, Math.PI / 2, 10, 2, 0), 0), 'native cold station commits');
let exact = JSON.stringify(serialize(f)) === JSON.stringify(serialize(cold));
for (let tick = 0; tick < 128; tick++) { f.stepTick(); cold.stepTick(); exact &&= JSON.stringify(serialize(f)) === JSON.stringify(serialize(cold)); }
check(exact && !checkReservations(f).length && !checkReservations(cold).length, 'native prepared construction retains exact commit/replay and reservations');
console.log('native formation preparation cases', cases);
done();
