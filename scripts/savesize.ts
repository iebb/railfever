// Bundle as savesize.mjs, then node savesize.mjs [512 768 1024 1536]. No browser/server required.
import assert from 'node:assert/strict';
import { Worker as NodeWorker } from 'node:worker_threads';
import { resolveObjectURL } from 'node:buffer';
import { gzipSync } from 'node:zlib';
import { Game } from '../src/game/game';
import { captureSave, encodeSnapshot, serialize, deserialize, saveToSlot, loadFromSlot, exportToFile, importFromText, saveStats } from '../src/game/save';
import { getSave, storageMode } from '../src/game/storage';

// Exercise the actual inline worker source, structured-clone messages and transfers under Node.
const workers: BrowserWorker[] = [];
let postMs = 0;
class BrowserWorker {
  onmessage: ((e: { data: any }) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  ready: Promise<NodeWorker>;
  constructor(url: string) {
    const blob = resolveObjectURL(url)!;
    this.ready = blob.text().then((source) => {
      const worker = new NodeWorker(`const {parentPort} = require('node:worker_threads'); global.self = global; self.postMessage = (data, transfer) => parentPort.postMessage(data, transfer); ${source}; parentPort.on('message', data => self.onmessage({data}));`, { eval: true });
      worker.on('message', (data) => this.onmessage?.({ data }));
      worker.on('error', (e) => this.onerror?.(e));
      return worker;
    });
    workers.push(this);
  }
  postMessage(data: any, transfer: ArrayBuffer[]) {
    void this.ready.then((w) => { const t = performance.now(); w.postMessage(data, transfer); postMs += performance.now() - t; });
  }
  terminate() { void this.ready.then((w) => w.terminate()); }
}
if (!process.argv.includes('--no-worker')) (globalThis as any).Worker = BrowserWorker;
if (process.argv.includes('--no-compression')) (globalThis as any).CompressionStream = undefined;
const baseline = {
  512: [53.71, 5.04, 2.816, 1.286], 768: [99.57, 12.43, 6.673, 2.964],
  1024: [174.28, 24.43, 11.659, 5.190], 1536: [380.44, 41.30, 24.775, 11.254],
}; // Original v2.5 measured here before changing save.ts (seed 7, same maps).
const bytes = (x: Uint8Array | string) => typeof x === 'string' ? x.length : x.byteLength;
const sizes = process.argv.slice(2).filter((s) => /^\d+$/.test(s)).map(Number);
try {
  for (const size of sizes.length ? sizes : [512, 768, 1024, 1536]) {
    const towns = Math.max(3, Math.min(40, Math.round(3.2 * (size / 384) ** 2)));
    const g = Game.create({ size, seed: 7, towns, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 1 });
    const years = Number(process.argv.find((s) => s.startsWith('--years='))?.slice(8) ?? 0);
    if (years) { while (g.year < g.options.startYear + years) g.update(0.25); console.log(`aged ${size} map to ${g.dateString()}: ${g.world.net.edges.size} edges, ${g.world.buildings.size} buildings, ${g.vehicles.all().length} vehicles`); }
    postMs = 0;
    const cold = captureSave(g), coldMs = saveStats.lastSnapshotMs;
    const coldRec = await encodeSnapshot(cold), coldEncodeMs = saveStats.lastEncodeMs, coldPostMs = postMs;
    const initialParts = coldRec.parts!.reduce((n, p) => n + bytes(p.data), 0);
    const encoded = saveStats.encodedChunks, copied = saveStats.copiedChunks;
    const warm: number[] = [], posts: number[] = [];
    for (let i = 0; i < 5; i++) {
      postMs = 0;
      const snap = captureSave(g); warm.push(saveStats.lastSnapshotMs);
      assert(snap.chunks.every((c, j) => c === cold.chunks[j]), 'unchanged snapshots reuse every immutable chunk');
      await encodeSnapshot(snap); posts.push(postMs + saveStats.lastPostMs);
    }
    assert.equal(saveStats.encodedChunks, encoded, 'unchanged chunks never re-encode');
    assert.equal(saveStats.copiedChunks, copied, 'unchanged chunks never copy');
    const saved = saveToSlot(g, 'size-test', 'Size test');
    // Save must capture at the call, not at the end of the async encoding/compression/storage.
    const oldTick = g.tick, oldMoney = g.economy.money;
    g.tick += 3; g.economy.money += 123;
    await saved;
    const loaded = await loadFromSlot('size-test');
    assert.equal(loaded.tick, oldTick); assert.equal(loaded.economy.money, oldMoney);
    g.tick = oldTick; g.economy.money = oldMoney;
    const json = JSON.stringify(serialize(g));
    assert.equal(JSON.stringify(serialize(loaded)), json, 'stored save round trip');
    assert.equal(JSON.stringify(serialize(deserialize(JSON.parse(json)))), json, 'single JSON round trip');
    const file = await exportToFile(g);
    assert.equal(JSON.stringify(serialize(await importFromText(await file.text()))), json, 'single-file export/import round trip');
    const rec = (await getSave('size-test'))!;
    const storedMB = (bytes(rec.data) + rec.parts!.reduce((n, p) => n + bytes(p.data), 0)) / 1e6;
    // Local edits invalidate one linear height chunk, one lock chunk and one tree-id chunk.
    const before = captureSave(g), v = g.world.h[0];
    g.world.setVertex(0, 0, v + 1);
    g.world.lock[0] ^= 4;
    const tree = g.world.trees.find((t) => !!t)!;
    g.world.removeTreesNear(tree.x, tree.z, 0.001);
    const after = captureSave(g);
    const editedSnapshotMs = saveStats.lastSnapshotMs;
    assert.equal(after.chunks.filter((c, i) => c !== before.chunks[i]).length, 3, 'one edit per kind copies exactly three chunks');
    const beforeEncoded = saveStats.encodedChunks;
    postMs = 0;
    await encodeSnapshot(after);
    const editedMainMs = editedSnapshotMs + postMs + saveStats.lastPostMs;
    assert.equal(saveStats.encodedChunks - beforeEncoded, 3, 'only changed chunks encode');
    const beforeBulk = captureSave(g), k = Math.min(100000, g.world.h.length - 1);
    g.world.h[k] += 1; g.world.heightsVersion++;
    const afterBulk = captureSave(g);
    assert.equal(afterBulk.chunks.filter((c, i) => c !== beforeBulk.chunks[i]).length, 1, 'bulk writer version fallback finds only the changed chunk');
    // build-ops.ts has a legacy deletion path that bypasses removeTreesNear. Its markObj hook
    // must work even though the id is already absent from treeGrid, and renderer sets were cleared.
    const directId = g.world.trees.findIndex((t) => !!t), directTree = g.world.trees[directId]!;
    g.world.trees[directId] = null; g.world.freeTrees.push(directId); g.world.treeGrid.remove(directId);
    g.world.markObj(directTree.x, directTree.z); g.world.dirtyObj.clear();
    const afterDirect = captureSave(g);
    assert.equal(afterDirect.chunks.filter((c, i) => c !== afterBulk.chunks[i]).length, 1, 'legacy direct tree deletion invalidates its saved chunk');
    const maxWarmMs = Math.max(...warm.map((ms, i) => ms + posts[i]));
    if (!process.argv.includes('--no-worker')) {
      assert(maxWarmMs < (size === 1536 ? 40 : 16), 'autosave main-thread capture + posting meets budget');
      assert(editedMainMs < (size === 1536 ? 40 : 16), `edited autosave meets budget: ${editedSnapshotMs.toFixed(2)} snapshot + ${(postMs + saveStats.lastPostMs).toFixed(2)} posting`);
    }
    console.log(JSON.stringify({ size, towns, before: baseline[size as keyof typeof baseline], coldSnapshotMs: +coldMs.toFixed(2), coldPostMs: +coldPostMs.toFixed(2), coldEncodeMs: +coldEncodeMs.toFixed(2), warmSnapshotMs: warm.map((n) => +n.toFixed(2)), warmMainMaxMs: +maxWarmMs.toFixed(2), editedMainMs: +editedMainMs.toFixed(2), storedMB: +storedMB.toFixed(3), dynamicKB: +(bytes(rec.data) / 1000).toFixed(1), exportMB: +(file.size / 1e6).toFixed(3), v3JsonMB: +(json.length / 1e6).toFixed(3), v3JsonGzipMB: +(gzipSync(json).length / 1e6).toFixed(3), unchangedEncodedChunks: saveStats.encodedChunks - beforeEncoded - 3, initialChunkMB: +(initialParts / 1e6).toFixed(3), storage: storageMode() }));
  }
  console.log('ALL CHECKS PASSED: lossless round trips, tick snapshots, chunk reuse, local and bulk invalidation, memory export');
} finally { for (const w of workers) w.terminate(); }
