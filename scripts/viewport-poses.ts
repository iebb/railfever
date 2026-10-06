// Camera-dependent interpolation is derived only; company/ambient operations and saves stay exact.
// Bundle as viewport-poses.mjs and run with Node.
import * as THREE from 'three';
import { flatGame, station, endNode, depotFor, loco, build, free, railOpts, nodeSnap, check, fails } from './stationlib';
import { roadOpts } from './lib';
import { Game } from '../src/game/game';
import { serialize, deserialize } from '../src/game/save';
import { RoadVehicle, makeLaneSeg, connsConflict, type RSeg } from '../src/game/roadvehicle';
import { Train } from '../src/game/train';
import { makeCurve } from '../src/game/network';
import { segIntersect } from '../src/game/geom';
import { VehiclesView } from '../src/render/vehicles-view';
import type { Materials } from '../src/render/materials';

const g = flatGame(256), A = station(g, 48, 128, Math.PI / 2, 12, 2)!, B = station(g, 200, 128, Math.PI / 2, 12, 2)!;
check(!!A && !!B && !!build(g, nodeSnap(g, endNode(g, A, 0, true), 'rail'), nodeSnap(g, endNode(g, B, 0, false), 'rail'), railOpts(), 'paid railway'), 'fixture company railway');
const depot = depotFor(g, A, B), line = g.lines.create('rail'); line.stops = [A.id, B.id];
const train = g.vehicles.buyTrain(depot, loco(), line.id);
check(train instanceof Train, 'fixture company train');
check(!!build(g, free(g, 16, 48), free(g, 240, 48), roadOpts(), 'ambient lane'), 'fixture traffic road');
const road = [...g.world.net.edges.values()].find(e => e.kind === 'road')!;
for (let i = 0; i < 8; i++) {
  const v = new RoadVehicle(g, g.vehicles.nextAmbientId++, null, -1, true, i + 5);
  v.placeAt(makeLaneSeg(g, road, 1), 20 + i * 12); v.speed = 0.5;
  g.vehicles.ambient.push(v);
}
g.aiEnabled = false;
const saved = serialize(g), all = deserialize(saved), viewport = deserialize(saved);
let exact = true;
for (let tick = 0; tick < 96; tick++) {
  const ids = tick % 3 === 0 ? new Set<number>() : new Set([...viewport.vehicles.map.keys(), ...viewport.vehicles.ambient.filter((_, i) => i % 2 === tick % 2).map(v => v.id)]);
  viewport.vehicles.setRenderInterest(ids);
  all.stepTick(); viewport.stepTick();
  if (JSON.stringify(serialize(all)) !== JSON.stringify(serialize(viewport))) { exact = false; break; }
}
check(exact, 'every saved tick is identical as viewport interest changes');
check(all.vehicles.trains()[0].onMap && all.vehicles.trains()[0].hours > 0, 'company train runs and accounts while offscreen');
check(JSON.stringify(serialize(viewport)) === JSON.stringify(serialize(deserialize(serialize(viewport)))), 'render interest is absent from saves');

const cold = deserialize(saved), car = cold.vehicles.ambient[0], current = { x: 0, y: 0, z: 0 }, drawn = { ...current };
cold.vehicles.setRenderInterest(new Set()); cold.update(cold.tickSeconds * 1.5);
car.pointBehind(0, current); cold.vehicles.renderPointBehind(car, 0, drawn);
check(Math.hypot(current.x - drawn.x, current.y - drawn.y, current.z - drawn.z) < 1e-9, 'newly visible cold pose uses committed position without stale interpolation');
const before = { ...current };
cold.vehicles.setRenderInterest(new Set([car.id])); cold.update(cold.tickSeconds);
car.pointBehind(0, current); cold.vehicles.renderPointBehind(car, 0, drawn);
check(Math.hypot(drawn.x - (before.x + current.x) / 2, drawn.y - (before.y + current.y) / 2, drawn.z - (before.z + current.z) / 2) < 1e-6,
  'visible vehicle resumes exact interpolation on its next tick');

const mats = { glass: new THREE.MeshStandardMaterial(), uniforms: { uNight: { value: 0 } } } as unknown as Materials;
const view = new VehiclesView(mats), camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000);
const watched = deserialize(saved); watched.stepTick();
const inspect = watched.vehicles.trains()[0].id;
camera.position.set(1200, 1000, 1200); camera.lookAt(1800, 1000, 1800); camera.updateMatrixWorld();
view.setTrackedVehicleIds([inspect]); view.update(watched, 1 / 60, 1, 1200, camera);
const interest = (watched.vehicles as any).renderInterest as ReadonlySet<number>;
check(interest.size === 1 && interest.has(inspect), 'far viewport retains only the tracked company vehicle');
view.setTrackedVehicleIds([]); view.update(watched, 1 / 60, 1, 1200, camera);
const newlyTracked = watched.vehicles.ambient[0].id;
view.setTrackedVehicleIds([newlyTracked]); watched.stepTick();
check(watched.vehicles.renderPoseCount === 1, 'newly tracked vehicle retains its pose before the next render frame');
view.setTrackedVehicleIds([]); camera.position.set(128, 45, 55); camera.lookAt(128, 3, 48); camera.updateMatrixWorld();
view.update(watched, 1 / 60, 1, 1200, camera);
check((watched.vehicles as any).renderInterest.size > 0, 'close viewport retains visible and audible vehicles');
view.update(watched, 1 / 60, 1);
check((watched.vehicles as any).renderInterest === null, 'no-camera rendering retains original headless capture behavior');
view.update(watched, 1 / 60, 1, 1200, camera); view.dispose();
check((watched.vehicles as any).renderInterest === null, 'disposing a view releases its derived interest policy');
mats.glass.dispose();

const shape = (e: number, pts: number[]): RSeg => ({ kind: 'conn', e, dir: 1, node: 1, from: e + 10, fromDir: 1, curve: makeCurve(new Float32Array(pts)), len: 2, limit: 1, tunnels: [], crossings: [] });
const a = shape(1, [0, 0, 0, 1, 0, 1, 2, 0, 2]), b = shape(2, [0, 0, 2, 1, 0, 1, 2, 0, 0]);
const oracle = (a: RSeg, b: RSeg) => {
  if (a.e === b.e && a.dir === b.dir) return true;
  const pa = a.curve.pts, pb = b.curve.pts, na = a.curve.cum.length, nb = b.curve.cum.length;
  for (let i = 0; i < na - 1; i += 2) for (let j = 0; j < nb - 1; j += 2) {
    const i2 = Math.min(na - 1, i + 2), j2 = Math.min(nb - 1, j + 2);
    if (segIntersect(pa[i * 3], pa[i * 3 + 2], pa[i2 * 3], pa[i2 * 3 + 2], pb[j * 3], pb[j * 3 + 2], pb[j2 * 3], pb[j2 * 3 + 2])) return true;
  }
  return false;
};
for (let i = 0; i < 60; i++) {
  const shift = i / 7;
  b.curve = makeCurve(new Float32Array([shift, 0, 2, shift + 1, 0, 1, shift + 2, 0, 0]));
  check(connsConflict(a, b) === oracle(a, b) && connsConflict(a, b) === oracle(a, b), 'warm/cold connector conflict matches uncached geometry after curve replacement');
}
b.curve.pts = new Float32Array([5, 0, 5, 6, 0, 6, 7, 0, 7]);
check(connsConflict(a, b) === oracle(a, b), 'replaced point arrays invalidate connector conflict memo');
console.log('96 identical viewport ticks, native train accounting, cold entry, followed/audible interest and exact collision memo');
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
