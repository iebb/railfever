// World replacement must release per-world render resources, while keeping shared materials alive.
// Bundle as render-lifecycle.mjs and run with Node (no browser or GPU required).
import * as THREE from 'three';
import { Game } from '../src/game/game';
import { World } from '../src/game/world';
import { Renderer } from '../src/render/renderer';
import { VehiclesView } from '../src/render/vehicles-view';
import type { Materials } from '../src/render/materials';
import { check, fails } from './lib';

const shared = new THREE.MeshStandardMaterial();
const mats = {
  glass: shared, world: shared, worldDepth: shared, worldFar: shared, glow: shared,
  tree: shared, treeFar: shared, uniforms: { uNight: { value: 0 }, uTreeDist: { value: 0 } },
} as unknown as Materials;
// Exercise the real setGame path; the application-wide canvas, camera and labels need no DOM here.
const renderer = Object.assign(Object.create(Renderer.prototype), {
  mats, worldGroup: new THREE.Group(), vehicles: new VehiclesView(mats),
  labels: { clear() {} }, controls: { setWorld() {} },
  shadowKey: new Float64Array(9), shadowKeyFar: new Float64Array(9),
}) as Renderer;
const game = new Game({ size: 32, seed: 5, towns: 0, hilliness: 'flat', water: 'low', startYear: 1990 }, new World(32));
game.world.h.fill(3);
let sharedDisposals = 0;
shared.addEventListener('dispose', () => { sharedDisposals++; });
let resourcesReleased = 0;

renderer.setGame(game); // startup also supports having no previous world
for (let cycle = 0; cycle < 3; cycle++) {
  const overlay = renderer.overlay, terrain = renderer.terrain;
  overlay.setMarker('start', { x: 8, y: 3, z: 8 });
  overlay.setDisc({ x: 8, z: 8, r: 4, y: 3 });
  overlay.setLinePath(1, [new Float32Array([4, 3, 4, 16, 3, 16])]);
  overlay.setSegments('selection', [{ x0: 2, z0: 2, x1: 16, z1: 16 }]);
  overlay.setTrackLayers([{ pts: [new Float32Array([4, 3, 8, 16, 3, 8])], color: 0xffffff, width: 4 }]);

  const owned = new Set<THREE.BufferGeometry | THREE.Material | THREE.Texture>();
  const collect = (root: THREE.Object3D) => root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (mesh.geometry) owned.add(mesh.geometry);
    if (mesh.material) for (const mat of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) owned.add(mat);
    if (mesh.customDepthMaterial) owned.add(mesh.customDepthMaterial);
  });
  collect(overlay.group);
  collect(terrain.group);
  owned.add(terrain.heightTex);
  const disposed = new Map([...owned].map(resource => [resource, 0]));
  for (const resource of owned) resource.addEventListener('dispose', () => disposed.set(resource, disposed.get(resource)! + 1));

  renderer.setGame(game);
  check(renderer.overlay !== overlay && renderer.terrain !== terrain, `cycle ${cycle}: replacement renders use new world resources`);
  check(overlay.group.children.length === 0, `cycle ${cycle}: old tool and map layers are detached`);
  check([...disposed.values()].every(count => count === 1), `cycle ${cycle}: every old terrain and displayed overlay resource is disposed exactly once`);
  check(sharedDisposals === 0, `cycle ${cycle}: world replacement preserves shared application materials`);
  resourcesReleased += [...disposed.values()].filter(count => count === 1).length;
}
renderer.terrain.dispose(); renderer.objects.dispose(); renderer.overlay.dispose(); renderer.vehicles.dispose();
shared.dispose();
console.log(`${resourcesReleased} observed resource disposals across 3 populated-overlay world replacements`);
console.log(fails.length ? `${fails.length} FAILURES` : 'ALL CHECKS PASSED');
process.exitCode = fails.length ? 1 : 0;
