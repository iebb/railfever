// Bundle as storage.mjs with --external:fake-indexeddb; install fake-indexeddb in the scratch output
// directory, then run there. Exercises real transactional IndexedDB semantics without a browser.
import assert from 'node:assert/strict';
import { indexedDB, IDBObjectStore } from 'fake-indexeddb';
import { putSave, getSave, deleteSave, putSaveOnce, storageMode } from '../src/game/storage';
import { Game } from '../src/game/game';
(globalThis as any).indexedDB = indexedDB;

// Upgrade an existing v1 database, retaining its original single-record save.
await new Promise<void>((resolve, reject) => {
  const req = indexedDB.open('railfever', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('saves', { keyPath: 'slot' });
  req.onsuccess = () => {
    const t = req.result.transaction('saves', 'readwrite');
    t.objectStore('saves').put({ slot: 'legacy', data: 'raw:{broken', meta: { slot: 'legacy' } });
    t.oncomplete = () => { req.result.close(); resolve(); };
  };
  req.onerror = () => reject(req.error);
});
const { slotsReady, saveToSlot, loadFromSlot, backupSlot, listSlots, serialize } = await import('../src/game/save');
await slotsReady;
assert.equal(storageMode(), 'persistent');
assert.equal((await getSave('legacy'))!.data, 'raw:{broken');
const part = async (key: string) => {
  const db = await new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open('railfever', 2); req.onsuccess = () => resolve(req.result as unknown as IDBDatabase); req.onerror = () => reject(req.error);
  });
  return await new Promise((resolve, reject) => {
    const t = db.transaction('parts', 'readonly'), req = t.objectStore('parts').get(key);
    t.oncomplete = () => { db.close(); resolve(req.result); }; t.onerror = () => reject(t.error);
  });
};
const a = { slot: 'atomic', data: 'first', meta: {}, partKeys: ['old', 'shared'], parts: [{ key: 'old', data: new Uint8Array([1]) }, { key: 'shared', data: new Uint8Array([2]) }] };
await putSave(a);
assert.deepEqual(await getSave('atomic'), a);
await assert.rejects(putSave({ ...a, data: 'bad', partKeys: ['new', 'missing'], parts: [{ key: 'new', data: new Uint8Array([3]) }] }), /Missing save chunk/);
assert.deepEqual(await getSave('atomic'), a, 'an invalid manifest rolls back the entire write');
assert.equal(await part('new'), undefined, 'uncommitted new chunks roll back');

// Abort after inserting a new part, when the new header has already been submitted.
const originalAdd = IDBObjectStore.prototype.add;
IDBObjectStore.prototype.add = function (...args: any[]) {
  const req = originalAdd.apply(this, args as any);
  if (this.name === 'parts') this.transaction.abort();
  return req;
};
try { await assert.rejects(putSave({ ...a, data: 'aborted', partKeys: ['aborted'], parts: [{ key: 'aborted', data: new Uint8Array([9]) }] })); }
finally { IDBObjectStore.prototype.add = originalAdd; }
assert.deepEqual(await getSave('atomic'), a, 'transaction abort preserves old header and all its chunks');
assert.equal(await part('aborted'), undefined);
assert.equal(storageMode(), 'persistent', 'an aborted transaction does not silently change durability');

await putSave({ ...a, slot: 'backup' });
const b = { ...a, data: 'second', partKeys: ['new'], parts: [{ key: 'new', data: new Uint8Array([3]) }] };
const [, concurrent] = await Promise.all([putSave(b), getSave('atomic')]);
assert(['first', 'second'].includes(concurrent!.data as string));
assert.deepEqual(concurrent!.parts!.map((p) => [...p.data as Uint8Array]), concurrent!.data === 'first' ? [[1], [2]] : [[3]], 'concurrent readers never mix saves');
assert(await part('old'), 'a backup keeps old referenced parts alive');
await deleteSave('backup');
assert.equal(await part('old'), undefined, 'unreferenced parts are collected after commit');
assert.equal(await part('shared'), undefined);
assert(await part('new'));
assert.deepEqual(await Promise.all([putSaveOnce({ slot: 'once', data: 'first', meta: {} }), putSaveOnce({ slot: 'once', data: 'second', meta: {} })]), [true, false]);

// Actual game slots: unchanged saves write only the dynamic header, backups share immutable parts.
const g = Game.create({ size: 128, seed: 7, towns: 3, hilliness: 'hilly', water: 'medium', startYear: 1980, aiCompanies: 0 });
await saveToSlot(g, 'autosave', 'Autosave');
const keys = (await getSave('autosave'))!.partKeys;
let added = 0;
IDBObjectStore.prototype.add = function (...args: any[]) { if (this.name === 'parts') added++; return originalAdd.apply(this, args as any); };
try {
  await saveToSlot(g, 'autosave', 'Autosave');
  assert.equal(added, 0, 'unchanged chunks are not written again');
  assert.deepEqual((await getSave('autosave'))!.partKeys, keys);
  await saveToSlot(await loadFromSlot('autosave'), 'autosave', 'Autosave');
  assert.equal(added, 0, 'the first autosave after loading reuses stored compressed chunks');
  assert.deepEqual((await getSave('autosave'))!.partKeys, keys);
  await backupSlot('autosave', 'autosave-previous', 'Autosave (previous game)');
  assert.equal(added, 0, 'previous-game backup shares already committed immutable chunks');
} finally { IDBObjectStore.prototype.add = originalAdd; }
const json = JSON.stringify(serialize(g));
assert.equal(JSON.stringify(serialize(await loadFromSlot('autosave-previous'))), json);
const first = saveToSlot(g, 'autosave', 'Old');
g.tick++;
const second = saveToSlot(g, 'autosave', 'New');
await Promise.all([first, second]);
assert.equal((await loadFromSlot('autosave')).tick, g.tick, 'overlapping saves commit in snapshot order');
assert.equal(listSlots().find((s) => s.slot === 'autosave')!.name, 'New');
assert.equal(JSON.stringify(serialize(await loadFromSlot('autosave-previous'))), json, 'new autosaves never change the previous-game copy');
console.log('ALL CHECKS PASSED: v1 upgrade, atomic chunk commits/reads, abort recovery, shared backups, post-commit GC, no repeated chunk writes, concurrent save ordering');
