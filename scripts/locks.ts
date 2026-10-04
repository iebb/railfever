// Building-lock ownership after demolition (bundle with esbuild, run with node).
// npx esbuild scripts/locks.ts --bundle --platform=node --format=esm --outfile=$S/locks.mjs && node $S/locks.mjs
import { civilLocks } from './section-structurelib';
import assert from 'node:assert/strict';
import { Game } from '../src/game/game';
import { bulldoze } from '../src/game/build-ops';
import { LOCK } from '../src/game/terraform';
import { World, pointInRect, type Building } from '../src/game/world';

/** Enumerate the integer terrain vertices in a building's oriented rectangle and margin. */
function vertices(w: World, b: Building): number[] {
  const hw = b.w / 2 + 0.6, hd = b.d / 2 + 0.6, r = Math.hypot(hw, hd);
  const out: number[] = [];
  for (let z = Math.max(0, Math.floor(b.z - r)); z <= Math.min(w.size, Math.ceil(b.z + r)); z++)
    for (let x = Math.max(0, Math.floor(b.x - r)); x <= Math.min(w.size, Math.ceil(b.x + r)); x++)
      if (pointInRect(x, z, b.x, b.z, b.angle, hw, hd)) out.push(w.vi(x, z));
  return out;
}

function otherLocksUnchanged(w: World, before: Uint8Array) {
  for (let k = 0; k < w.lock.length; k++)
    assert.equal(w.lock[k] & ~LOCK.building, before[k] & ~LOCK.building, `other lock bits changed at vertex ${k}`);
}

const options = { size: 384, seed: 7, towns: 10, hilliness: 'hilly', water: 'medium', startYear: 1980 } as const;
const g = Game.create(options), w = g.world;
const coverage = new Map<number, Building[]>();
for (const b of w.buildings.values()) for (const k of vertices(w, b)) {
  const owners = coverage.get(k);
  if (owners) owners.push(b); else coverage.set(k, [b]);
}

// Find an actual adjacent pair sharing margin vertices outside both walls.
let pair: [Building, Building] | undefined;
for (const [k, owners] of coverage) {
  const x = k % (w.size + 1), z = Math.floor(k / (w.size + 1));
  const neighbours = owners.filter((b) => b.floors > 0 && !pointInRect(x, z, b.x, b.z, b.angle, b.w / 2, b.d / 2));
  if (neighbours.length >= 2) { pair = [neighbours[0], neighbours[1]]; break; }
}
assert.ok(pair, 'seed 7 must have adjacent buildings with overlapping margins');
const [removed, standing] = pair;
const removedVertices = vertices(w, removed), standingVertices = new Set(vertices(w, standing));
const shared = removedVertices.filter((k) => standingVertices.has(k));
const exclusive = removedVertices.filter((k) => coverage.get(k)!.length === 1);
assert.ok(shared.length > 0, 'the neighbouring buildings must share terrain vertices');
assert.ok(exclusive.length > 0, 'the removed building must also own some vertices exclusively');
for (const k of [...shared, ...exclusive]) assert.ok(w.lock[k] & LOCK.building, `vertex ${k} must start building-locked`);

// Overlap network and building bits on both shared and exclusively owned vertices.
for (const k of [...shared, ...exclusive]) w.lock[k] |= LOCK.formation | LOCK.rail;
const before = w.lock.slice();
w.removeBuilding(removed.id); // Deliberately bypass Towns: ownership belongs in World.
assert.ok(!w.buildings.has(removed.id) && w.buildings.has(standing.id), 'only the requested building is removed');
for (const k of shared) assert.ok(w.lock[k] & LOCK.building, `shared vertex ${k} lost its building lock`);
for (const k of exclusive) assert.equal(w.lock[k] & LOCK.building, 0, `exclusive vertex ${k} kept a stale building lock`);
for (let k = 0; k < w.lock.length; k++) {
  const expected = coverage.get(k)?.some((b) => b.id !== removed.id) ? LOCK.building : 0;
  assert.equal(w.lock[k] & LOCK.building, expected, `building ownership mismatch at vertex ${k}`);
}
otherLocksUnchanged(w, before);
console.log(`seed 7: removed building ${removed.id}, neighbour ${standing.id}; ${shared.length} shared locks preserved, ${exclusive.length} exclusive locks cleared; network bits unchanged`);

// Bulldoze the surrounding block, including every building that covered a shared vertex.
const block = [...new Set(shared.flatMap((k) => coverage.get(k)!))];
const x0 = Math.min(...block.map((b) => b.x)) - 1, z0 = Math.min(...block.map((b) => b.z)) - 1;
const x1 = Math.max(...block.map((b) => b.x)) + 1, z1 = Math.max(...block.map((b) => b.z)) + 1;
g.economy.money = 1e9;
const result = bulldoze(g, x0, z0, x1, z1, 0, false);
assert.equal(result.error, null, 'block bulldozing must succeed');
for (const b of block) assert.ok(!w.buildings.has(b.id), `block building ${b.id} survived demolition`);
for (const k of shared) assert.equal(w.lock[k] & LOCK.building, 0, `bulldozed block vertex ${k} kept a building lock`);
console.log(`seed 7: block bulldozed; all ${shared.length} formerly shared building locks cleared`);

// Small controlled blocks exercise rotated margins, world borders and removal order.
function blockTest(label: string, lots: { x: number; z: number; angle: number; w: number; d: number }[], order: number[]) {
  const game = new Game({ ...options, size: 32, towns: 0 }), world = game.world;
  const buildings = lots.map((lot) => world.addBuilding({ ...lot, townId: -1, type: 0, floors: 1, pop: 0, seed: 1, y: 0, built: 0 }));
  const covered = new Set(buildings.flatMap((b) => vertices(world, b)));
  assert.ok([...covered].some((k) => buildings.filter((b) => vertices(world, b).includes(k)).length > 1), `${label}: margins must share vertices`);
  for (const k of covered) world.lock[k] |= LOCK.formation | LOCK.rail;
  const locks = world.lock.slice();
  for (const j of order) {
    world.removeBuilding(buildings[j].id);
    for (const k of covered) {
      const x = k % (world.size + 1), z = Math.floor(k / (world.size + 1));
      const owned = [...world.buildings.values()].some((b) => pointInRect(x, z, b.x, b.z, b.angle, b.w / 2 + 0.6, b.d / 2 + 0.6));
      assert.equal(world.lock[k] & LOCK.building, owned ? LOCK.building : 0, `${label}: ownership mismatch at ${x},${z}`);
    }
    otherLocksUnchanged(world, locks);
  }
  const remaining = [...world.buildings.values()];
  if (remaining.length) {
    const res = bulldoze(game, 0, 0, world.size, world.size, 0, false);
    assert.equal(res.error, null, `${label}: block bulldozing must succeed`);
  }
  assert.equal(world.buildings.size, 0, `${label}: all buildings removed`);
  for (const k of covered) assert.equal(world.lock[k], locks[k] & ~LOCK.building, `${label}: demolition must leave only network locks`);
  const final = world.lock.slice();
  world.removeBuilding(buildings[order[0]].id);
  world.removeBuilding(-1);
  assert.deepEqual(world.lock, final, `${label}: repeated or missing removals must be harmless`);
  console.log(`${label}: removal order, block clearing and network-lock preservation passed`);
}

const lots = [
  { x: 10, z: 10, angle: 0, w: 1, d: 1 },
  { x: 12, z: 10, angle: Math.PI / 4, w: 1, d: 1 },
  { x: 11, z: 11.1, angle: -Math.PI / 4, w: 1, d: 1 },
];
blockTest('rotated margins', lots, [0, 1]);
blockTest('reverse removal', lots, [2, 1, 0]);
blockTest('world border', lots.map((b) => ({ ...b, x: b.x - 10, z: b.z - 10 })), [0]);
civilLocks();
console.log('ALL CHECKS PASSED');
