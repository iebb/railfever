// Bundle with --external:fake-indexeddb and run with fake-indexeddb installed in the scratch directory.
import assert from 'node:assert/strict';
import { indexedDB } from 'fake-indexeddb';
import { getSave, listSaves, migrateLegacy, putSave } from '../src/game/storage';

(globalThis as any).indexedDB = indexedDB;
const values = new Map<string, string>();
(globalThis as any).localStorage = {
  get length() { return values.size; },
  key(i: number) { return [...values.keys()][i] ?? null; },
  getItem(key: string) { return values.get(key) ?? null; },
  removeItem(key: string) { values.delete(key); },
};
const legacy = (slot: string, data: string, meta?: unknown) => {
  values.set('railfever.save.' + slot, data);
  if (meta !== undefined) values.set('railfever.save.' + slot + '.meta', JSON.stringify(meta));
};

await putSave({ slot: 'autosave', data: 'current durable game', meta: { slot: 'autosave', name: 'Autosave' } });
await putSave({ slot: 'autosave-legacy', data: 'previous backup', meta: { slot: 'autosave-legacy' } });
legacy('autosave', 'raw:{old or even unreadable bytes', { slot: 'autosave', name: 'Old game', saved: 123 });
legacy('manual', 'old manual game');
assert.equal(await migrateLegacy(), 2);
assert.equal((await getSave('autosave'))!.data, 'current durable game', 'stale localStorage must never overwrite a durable slot');
assert.equal((await getSave('autosave-legacy'))!.data, 'previous backup', 'migration must not overwrite existing backups either');
assert.equal((await getSave('autosave-legacy-2'))!.data, 'raw:{old or even unreadable bytes', 'colliding bytes are preserved without parsing');
assert.deepEqual((await getSave('autosave-legacy-2'))!.meta,
  { slot: 'autosave-legacy-2', name: 'Old game (legacy backup)', saved: 123 });
assert.equal((await getSave('manual'))!.data, 'old manual game');
assert.equal((await listSaves()).find((s) => s.slot === 'manual')!.meta?.slot, 'manual', 'missing legacy metadata still yields a visible slot');
assert.equal(values.size, 0, 'only committed legacy copies are removed');
assert.equal(await migrateLegacy(), 0, 'migration is idempotent');

// Two tabs racing to migrate the same stale slot still cannot replace the current durable game.
legacy('autosave', 'racing old game', { slot: 'autosave', name: 'Race' });
await Promise.all([migrateLegacy(), migrateLegacy()]);
assert.equal((await getSave('autosave'))!.data, 'current durable game');
assert.equal((await getSave('autosave-legacy-2'))!.data, 'raw:{old or even unreadable bytes');
assert.equal(values.size, 0);
console.log('ALL CHECKS PASSED: legacy migration preserves durable slots, colliding backups, raw bytes, visible metadata and concurrent migrations');
