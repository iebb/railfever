// Bundle as save-world-integrity.mjs and run with Node. No long simulation is needed.
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { deserialize, serialize, saveCodec } from '../src/game/save';

const g = Game.create({ size: 128, seed: 7, towns: 3, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 0 });
const codec = saveCodec(), native = serialize(g);
const planes = (a: Float32Array) => {
  const src = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), out = new Uint8Array(src.length);
  for (let i = 0; i < a.length; i++) for (let b = 0; b < 4; b++) out[b * a.length + i] = src[i * 4 + b];
  return codec.base64(out);
};
const trees = new Float32Array(g.world.trees.length * 5);
g.world.trees.forEach((t, i) => {
  trees.set(t ? [t.x, t.z, t.s, t.type, t.tint] : [NaN, 0, 0, 0, 0], i * 5);
});
const legacy = { ...native, version: 2, world: { ...native.world,
  h: planes(g.world.h), lock: codec.base64(g.world.lock), trees: planes(trees) } };
const data = JSON.stringify(serialize(deserialize(legacy)));
assert.equal(data, JSON.stringify(native), 'complete v2 worlds retain every terrain, lock and tree value');
assert.equal(JSON.stringify(serialize(deserialize(native))), JSON.stringify(native), 'v3 remains byte-identical');
const invalid = (world: any, why: RegExp) => assert.throws(() => deserialize({ ...legacy, world: { ...legacy.world, ...world } }), why);
invalid({ h: planes(g.world.h.subarray(1)) }, /Incomplete heightmap/);
invalid({ h: planes(new Float32Array(g.world.h.length + 1)) }, /Incomplete heightmap/);
invalid({ lock: codec.base64(g.world.lock.subarray(1)) }, /Incomplete lock grid/);
invalid({ lock: codec.base64(new Uint8Array(g.world.lock.length + 1)) }, /Incomplete lock grid/);
invalid({ h: codec.base64(new Uint8Array(5)) }, /Invalid float chunk/);
invalid({ trees: planes(new Float32Array(4)) }, /Invalid tree chunk/);
for (const size of [null, NaN, Infinity, -1, 0, 1.5, '128']) invalid({ size }, /Invalid world size/);
assert.throws(() => deserialize({ ...native, world: { ...native.world, treeCount: 1,
  trees: [codec.base64(codec.packFloats(new Float32Array(4)))] } }), /Invalid tree chunk/);
assert.throws(() => deserialize({ ...native, world: { ...native.world, size: 1_000_000 } }), /Incomplete heightmap/,
  'reject mismatched terrain before attempting to allocate a huge declared world');
assert.throws(() => deserialize({ ...native, world: { ...native.world, treeCount: 1_000_000_000 } }), /Incomplete trees/,
  'reject a huge declared tree array before allocation');
assert.throws(() => deserialize({ ...native, world: { ...native.world, treeCount: -1 } }), /Incomplete trees/);
assert.throws(() => deserialize({ ...native, world: { ...native.world, lock: [] } }), /Incomplete lock grid/);
assert.throws(() => deserialize({ ...native, world: { ...native.world, h: null } }), /Invalid world chunks/);
// A short replay confirms validation changes no decisions in either readable format.
const a = deserialize(legacy), b = deserialize(native);
for (let i = 0; i < 8; i++) { a.stepTick(); b.stepTick(); }
assert.equal(JSON.stringify(serialize(a)), JSON.stringify(serialize(b)));
console.log('ALL CHECKS PASSED: v2/v3 exact worlds, rejected truncated/oversized maps and locks, float/tree alignment, invalid sizes and 8-tick replay');
