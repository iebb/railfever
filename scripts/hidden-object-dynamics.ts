// Hidden signal/crossing uploads are deferred; barrier interpolation and reentry remain current.
// Bundle as hidden-object-dynamics.mjs; optionally pass a bundled previous ObjectsView module.
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import * as THREE from 'three';
import { ObjectsView } from '../src/render/objects';
import type { Game } from '../src/game/game';
import type { Materials } from '../src/render/materials';

const baseline = process.argv[2] ? await import(pathToFileURL(process.argv[2]).href) : null;
const make = (View = ObjectsView) => {
  const reservations = new Map<number, number>(), closed = new Set<number>();
  const game = { world: { size: 64, heightAt: () => 0 }, vehicles: {
    getRes: (edge: number) => reservations.get(edge) ?? 0, crossingClosed: closed,
  } } as unknown as Game;
  const mats = { uniforms: { uTreeDist: { value: 0 } }, lamp: new THREE.MeshBasicMaterial(), body: new THREE.MeshBasicMaterial() } as unknown as Materials;
  const view = new View(game, mats) as ObjectsView & Record<string, any>;
  view.outs[0].lamps = [{ x: 16, y: 2, z: 16, edge: 7 }, { x: 18, y: 2, z: 16, edge: 8 }];
  view.outs[0].booms = [
    { crossing: 3, x: 16, y: 1, z: 17, dx: 1, dz: 0, len: 2 },
    { crossing: 3, x: 20, y: 1, z: 17, dx: -1, dz: 0, len: 2 },
  ];
  view.outs[0].xl = [{ crossing: 3, x: 16, y: 2, z: 17, phase: 0 }, { crossing: 3, x: 20, y: 2, z: 17, phase: 1 }];
  const work = { colors: 0, boomUploads: 0 };
  const place = view.placeBooms;
  view.placeBooms = () => { work.boomUploads++; place.call(view); };
  const rebuild = view.rebuildDynamic;
  view.rebuildDynamic = () => {
    rebuild.call(view);
    for (const mesh of [view.lampMesh, view.xlMesh]) if (mesh) {
      const set = mesh.setColorAt.bind(mesh);
      mesh.setColorAt = (i: number, color: THREE.Color) => { work.colors++; set(i, color); };
    }
  };
  const camera = new THREE.PerspectiveCamera(60, 1, .1, 4000);
  const draw = (height: number, dt = 1 / 60) => {
    camera.position.set(18, height, 35); camera.lookAt(18, 0, 18); camera.updateMatrixWorld();
    view.animate(dt, 0, camera);
  };
  const inputs = () => JSON.stringify({ reservations: [...reservations], closed: [...closed] });
  const dispose = () => { view.dispose(); mats.lamp.dispose(); mats.body.dispose(); };
  return { view, work, reservations, closed, draw, inputs, dispose };
};
const fixed = make(), control = baseline && make(baseline.ObjectsView);
fixed.closed.add(3); fixed.reservations.set(8, 22);
if (control) { control.closed.add(3); control.reservations.set(8, 22); }
const inputs = fixed.inputs(); fixed.draw(500);
assert.equal(fixed.work.colors, 0); assert.equal(fixed.work.boomUploads, 0);
assert(!fixed.view.lampMesh.visible && !fixed.view.xlMesh.visible && !fixed.view.boomMesh.visible);
assert.equal(fixed.view.lampMesh.instanceColor, null); assert.equal(fixed.view.xlMesh.instanceColor, null);
assert(fixed.view.boomsDirty, 'first hidden build retains its owed matrices');
assert.equal(fixed.inputs(), inputs, 'hidden first build leaves simulation inputs unchanged');
if (control) control.draw(500);
for (let frame = 0; frame < 180; frame++) {
  if (frame === 60) { fixed.closed.delete(3); if (control) control.closed.delete(3); }
  if (frame === 100) { fixed.closed.add(3); if (control) control.closed.add(3); }
  fixed.draw(500);
  if (control) {
    control.draw(500);
    assert.deepEqual([...fixed.view.boomPos], [...control.view.boomPos], 'every hidden barrier interpolation step remains exact');
    assert.equal(fixed.inputs(), control.inputs(), 'display updates leave authoritative inputs unchanged');
  }
}
const hiddenWork = { old: control && { ...control.work }, fixed: { ...fixed.work } };
assert.equal(fixed.work.colors, 0); assert.equal(fixed.work.boomUploads, 0);
assert.equal(fixed.view.boomPos.get(3), 0, 'hidden barrier reaches its exact closed position');
fixed.reservations.set(7, 11); fixed.draw(40, 0);
assert(fixed.view.lampMesh.visible && fixed.view.xlMesh.visible && fixed.view.boomMesh.visible);
assert.equal(fixed.work.colors, 4); assert.equal(fixed.work.boomUploads, 1);
assert(!fixed.view.boomsDirty, 'reentry flushes pending matrices even when no barrier moves this frame');
if (control) {
  control.reservations.set(7, 11); control.view.sigTimer = 0; control.draw(40, 0);
  assert.deepEqual(Array.from(fixed.view.lampMesh.instanceColor.array), Array.from(control.view.lampMesh.instanceColor.array), 'reentry uses current reservation colors');
  assert.deepEqual(Array.from(fixed.view.xlMesh.instanceColor.array), Array.from(control.view.xlMesh.instanceColor.array), 'reentry uses current crossing blink phase');
  assert.deepEqual(Array.from(fixed.view.boomMesh.instanceMatrix.array), Array.from(control.view.boomMesh.instanceMatrix.array), 'reentry barrier matrices equal continuously updated reference');
}
// A hidden geometry replacement must also retain a pending first placement.
fixed.draw(500); fixed.view.outs[0].booms[0].x = 24; fixed.view.dynDirty = true;
const beforeRebuild = { ...fixed.work }; fixed.draw(500, 0);
assert.equal(fixed.work.colors, beforeRebuild.colors); assert.equal(fixed.work.boomUploads, beforeRebuild.boomUploads);
fixed.draw(40, 0);
assert.equal(fixed.work.boomUploads, beforeRebuild.boomUploads + 1);
assert.equal(fixed.view.boomMesh.instanceMatrix.array[12], 24, 'hidden replacement flushes new geometry on reentry');
fixed.dispose(); if (control) control.dispose();

const firstVisible = make(); firstVisible.closed.add(3); firstVisible.reservations.set(8, 22);
firstVisible.draw(40);
assert(firstVisible.view.lampMesh.instanceColor && firstVisible.view.xlMesh.instanceColor);
assert.equal(firstVisible.work.boomUploads, 1, 'first visible build places barriers once after interpolation');
if (baseline) {
  const visibleReference = make(baseline.ObjectsView); visibleReference.closed.add(3); visibleReference.reservations.set(8, 22); visibleReference.draw(40);
  for (const key of ['lampMesh', 'xlMesh']) assert.deepEqual(Array.from(firstVisible.view[key].instanceColor.array), Array.from(visibleReference.view[key].instanceColor.array));
  assert.deepEqual(Array.from(firstVisible.view.boomMesh.instanceMatrix.array), Array.from(visibleReference.view.boomMesh.instanceMatrix.array), 'first visible buffers match native reference exactly');
  visibleReference.dispose();
}
const placed = firstVisible.work.boomUploads; firstVisible.draw(40);
assert(firstVisible.work.boomUploads > placed, 'visible movement still refreshes barrier matrices');
firstVisible.dispose();
console.log('PASS hidden first build, 180 exact barrier steps, current signal/blink reentry, pending geometry replacement and first visible build');
console.log(JSON.stringify({ hiddenWork, scope: 'actual ObjectsView animation and native Three instance buffers; operation counts, not browser FPS' }));
