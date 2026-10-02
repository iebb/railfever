// Save-game storage in IndexedDB (large quota, survives refreshes), with an in-memory fallback when
// IndexedDB is unavailable (tests, private mode). Old localStorage saves are migrated once.

export interface StoredSave { slot: string; data: Uint8Array | string; meta: unknown }

const DB = 'railfever';
const STORE = 'saves';
const LEGACY_PREFIX = 'railfever.save.';

let dbp: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, StoredSave>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    if (typeof indexedDB === 'undefined') { resolve(null); return; }
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE, { keyPath: 'slot' }); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

function tx<T>(db: IDBDatabase, mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const r = fn(t.objectStore(STORE));
    t.oncomplete = () => resolve(r.result);
    t.onerror = () => reject(t.error ?? r.error);
    t.onabort = () => reject(t.error ?? new Error('Storage transaction aborted'));
  });
}

export async function putSave(rec: StoredSave): Promise<void> {
  const db = await openDb();
  if (!db) { memory.set(rec.slot, rec); return; }
  await tx(db, 'readwrite', (s) => s.put(rec));
}

export async function getSave(slot: string): Promise<StoredSave | null> {
  const db = await openDb();
  if (!db) return memory.get(slot) ?? null;
  return (await tx<StoredSave | undefined>(db, 'readonly', (s) => s.get(slot))) ?? null;
}

export async function deleteSave(slot: string): Promise<void> {
  const db = await openDb();
  if (!db) { memory.delete(slot); return; }
  await tx(db, 'readwrite', (s) => s.delete(slot));
}

/** Metadata of every stored save (data is not loaded). */
export async function listSaves(): Promise<{ slot: string; meta: unknown }[]> {
  const db = await openDb();
  if (!db) return [...memory.values()].map((r) => ({ slot: r.slot, meta: r.meta }));
  return new Promise((resolve, reject) => {
    const out: { slot: string; meta: unknown }[] = [];
    const t = db.transaction(STORE, 'readonly');
    const req = t.objectStore(STORE).openCursor();
    req.onsuccess = () => {
      const c = req.result;
      if (!c) return;
      const v = c.value as StoredSave;
      out.push({ slot: v.slot, meta: v.meta });
      c.continue();
    };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

/** Move saves written by older versions (localStorage) into IndexedDB. */
export async function migrateLegacy(): Promise<number> {
  if (typeof localStorage === 'undefined') return 0;
  const db = await openDb();
  if (!db) return 0;
  const slots: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)!;
    if (k.startsWith(LEGACY_PREFIX) && !k.endsWith('.meta')) slots.push(k.slice(LEGACY_PREFIX.length));
  }
  let n = 0;
  for (const slot of slots) {
    const data = localStorage.getItem(LEGACY_PREFIX + slot);
    const metaRaw = localStorage.getItem(LEGACY_PREFIX + slot + '.meta');
    if (!data) continue;
    let meta: unknown = null;
    try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch { /* ignore */ }
    try {
      await putSave({ slot, data, meta });
      localStorage.removeItem(LEGACY_PREFIX + slot);
      localStorage.removeItem(LEGACY_PREFIX + slot + '.meta');
      n++;
    } catch { /* keep the legacy copy */ }
  }
  return n;
}
