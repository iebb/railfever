// IndexedDB manifests and immutable compressed world chunks. A manifest and all new chunks commit
// together; readers hydrate every referenced chunk in one transaction. GC runs after that commit.
export interface StoredPart { key: string; data: Uint8Array | string }
export interface StoredSave {
  slot: string; data: Uint8Array | string; meta: unknown;
  partKeys?: string[];
  /** Hydrated on read; on write these are the chunks available for any new references. */
  parts?: StoredPart[];
}
export type StorageMode = 'opening' | 'persistent' | 'memory';
let mode: StorageMode = 'opening';
const listeners = new Set<(mode: StorageMode) => void>();
export function storageMode(): StorageMode { return mode; }
export function onStorageMode(fn: (mode: StorageMode) => void): () => void {
  listeners.add(fn); fn(mode); return () => { listeners.delete(fn); };
}
function setMode(next: StorageMode) { mode = next; for (const fn of listeners) fn(mode); }

// The preview build (/preview/) shares its origin with the release: it keeps its saves in a database of its own,
// so a newer save format there never replaces the release's autosave.
const DB = typeof location !== 'undefined' && /\/preview\//.test(location.pathname) ? 'railfever-preview' : 'railfever';
const STORE = 'saves', PARTS = 'parts', META = 'metadata', LEGACY_PREFIX = 'railfever.save.';
let dbp: Promise<IDBDatabase | null> | null = null;
const memory = new Map<string, StoredSave>();
const memoryParts = new Map<string, StoredPart>();

function openDb(): Promise<IDBDatabase | null> {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    const unavailable = () => { setMode('memory'); resolve(null); };
    try {
      if (typeof indexedDB === 'undefined') { unavailable(); return; }
      const req = indexedDB.open(DB, 2);
      req.onupgradeneeded = () => {
        for (const [name, keyPath] of [[STORE, 'slot'], [PARTS, 'key'], [META, 'slot']])
          if (!req.result.objectStoreNames.contains(name)) req.result.createObjectStore(name, { keyPath });
        const cursor = req.transaction!.objectStore(STORE).openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result; if (!c) return;
          const rec = c.value as StoredSave;
          req.transaction!.objectStore(META).put({ slot: rec.slot, meta: rec.meta, partKeys: rec.partKeys ?? [] });
          c.continue();
        };
      };
      req.onsuccess = () => {
        // An open request can succeed after onblocked already selected memory storage.
        if (mode === 'memory') { req.result.close(); return; }
        req.result.onversionchange = () => { req.result.close(); dbp = Promise.resolve(null); setMode('memory'); };
        setMode('persistent'); resolve(req.result);
      };
      req.onerror = unavailable;
      req.onblocked = unavailable;
    } catch { unavailable(); }
  });
  return dbp;
}

/** Permission/quota failures select the truthful memory fallback. Aborted writes remain failures. */
function fallBack(error: unknown): boolean {
  const name = (error as { name?: string } | null)?.name;
  if (!['SecurityError', 'NotAllowedError', 'InvalidStateError', 'UnknownError', 'QuotaExceededError'].includes(name ?? '')) return false;
  dbp = Promise.resolve(null); setMode('memory'); return true;
}
function header(rec: StoredSave): StoredSave { const { parts, ...rest } = rec; return rest; }
function cache(rec: StoredSave) {
  const available = new Map((rec.parts ?? []).map((p) => [p.key, p]));
  for (const key of rec.partKeys ?? []) if (!memoryParts.has(key) && !available.has(key)) throw new Error('Missing save chunk: ' + key);
  for (const p of rec.parts ?? []) memoryParts.set(p.key, p);
  memory.set(rec.slot, header(rec));
}
function hydrateMemory(rec: StoredSave | undefined): StoredSave | null {
  if (!rec) return null;
  if (!rec.partKeys) return rec;
  return { ...rec, parts: rec.partKeys.map((key) => {
    const p = memoryParts.get(key); if (!p) throw new Error('Missing save chunk: ' + key); return p;
  }) };
}

async function collectParts(): Promise<void> {
  const db = await openDb();
  const retained = new Set([...memory.values()].flatMap((s) => s.partKeys ?? []));
  for (const key of memoryParts.keys()) if (!retained.has(key)) memoryParts.delete(key);
  if (!db) return;
  await new Promise<void>((resolve, reject) => {
    const t = db.transaction([META, PARTS], 'readwrite');
    const saves = t.objectStore(META).getAll();
    const keys = t.objectStore(PARTS).getAllKeys();
    const clean = () => {
      if (saves.readyState !== 'done' || keys.readyState !== 'done') return;
      const live = new Set((saves.result as StoredSave[]).flatMap((s) => s.partKeys ?? []));
      for (const key of keys.result) if (!live.has(String(key))) t.objectStore(PARTS).delete(key);
    };
    saves.onsuccess = keys.onsuccess = clean;
    t.oncomplete = () => resolve();
    t.onerror = t.onabort = () => reject(t.error ?? new Error('Chunk cleanup aborted'));
  });
}

async function write(rec: StoredSave, once: boolean): Promise<boolean> {
  const db = await openDb();
  if (!db) {
    if (once && memory.has(rec.slot)) return false;
    cache(rec); await collectParts(); return true;
  }
  let inserted: boolean;
  try {
    inserted = await new Promise<boolean>((resolve, reject) => {
      const t = db.transaction([STORE, PARTS, META], 'readwrite'), saves = t.objectStore(STORE), parts = t.objectStore(PARTS);
      const old = saves.get(rec.slot);
      const additions = new Map((rec.parts ?? []).map((p) => [p.key, p]));
      let changed = false, failure: Error | undefined;
      old.onsuccess = () => {
        if (once && old.result !== undefined) return;
        const kept = new Set((old.result as StoredSave | undefined)?.partKeys ?? []);
        for (const key of rec.partKeys ?? []) {
          if (kept.has(key)) continue;
          const found = parts.getKey(key);
          found.onsuccess = () => {
            if (found.result !== undefined) return;
            const part = additions.get(key);
            if (part) parts.add(part);
            else { failure = new Error('Missing save chunk: ' + key); t.abort(); }
          };
        }
        saves.put(header(rec));
        t.objectStore(META).put({ slot: rec.slot, meta: rec.meta, partKeys: rec.partKeys ?? [] });
        changed = true;
      };
      t.oncomplete = () => resolve(changed);
      t.onerror = t.onabort = () => reject(failure ?? t.error ?? old.error ?? new Error('Storage transaction aborted'));
    });
  } catch (e) {
    if (!fallBack(e)) throw e;
    if (once && memory.has(rec.slot)) return false;
    cache(rec); await collectParts(); return true;
  }
  if (inserted) {
    cache(rec);
    // Cleanup failures cannot invalidate the newly committed save; retry on the next write/delete.
    await collectParts().catch((e) => console.warn('Save chunk cleanup failed', e));
  }
  return inserted;
}
export async function putSave(rec: StoredSave): Promise<void> { await write(rec, false); }
/** Create a backup atomically; later loads or another tab cannot replace the first copy. */
export async function putSaveOnce(rec: StoredSave): Promise<boolean> { return write(rec, true); }

export async function getSave(slot: string): Promise<StoredSave | null> {
  const db = await openDb();
  if (!db) return hydrateMemory(memory.get(slot));
  try {
    const rec = await new Promise<StoredSave | null>((resolve, reject) => {
      const t = db.transaction([STORE, PARTS], 'readonly'), req = t.objectStore(STORE).get(slot);
      let result: StoredSave | null = null, failure: Error | undefined;
      req.onsuccess = () => {
        if (!req.result) return;
        result = req.result as StoredSave;
        if (result.partKeys) {
          result.parts = new Array(result.partKeys.length);
          result.partKeys.forEach((key, i) => {
            const part = t.objectStore(PARTS).get(key);
            part.onsuccess = () => {
              if (!part.result) { failure = new Error('Missing save chunk: ' + key); t.abort(); }
              else result!.parts![i] = part.result;
            };
          });
        }
      };
      t.oncomplete = () => resolve(result);
      t.onerror = t.onabort = () => reject(failure ?? t.error ?? new Error('Save read aborted'));
    });
    if (rec) cache(rec);
    return rec;
  } catch (e) { if (!fallBack(e)) throw e; return hydrateMemory(memory.get(slot)); }
}

export async function deleteSave(slot: string): Promise<void> {
  const db = await openDb();
  if (db) {
    try {
      await new Promise<void>((resolve, reject) => {
        const t = db.transaction([STORE, META], 'readwrite');
        t.objectStore(STORE).delete(slot); t.objectStore(META).delete(slot);
        t.oncomplete = () => resolve(); t.onerror = t.onabort = () => reject(t.error);
      });
    } catch (e) { if (!fallBack(e)) throw e; }
  }
  memory.delete(slot); await collectParts();
}
/** Slot listing and GC read only metadata, without copying even the dynamic save payloads. */
export async function listSaves(): Promise<{ slot: string; meta: unknown }[]> {
  const db = await openDb();
  if (!db) return [...memory.values()].map(({ slot, meta }) => ({ slot, meta }));
  try {
    return await new Promise((resolve, reject) => {
      const t = db.transaction(META, 'readonly'), req = t.objectStore(META).getAll();
      t.oncomplete = () => resolve((req.result as StoredSave[]).map(({ slot, meta }) => ({ slot, meta })));
      t.onerror = t.onabort = () => reject(t.error);
    });
  } catch (e) { if (!fallBack(e)) throw e; return [...memory.values()].map(({ slot, meta }) => ({ slot, meta })); }
}

/** Move old localStorage saves only after their IndexedDB transaction commits. */
export async function migrateLegacy(): Promise<number> {
  let legacy: Storage;
  try { if (typeof localStorage === 'undefined') return 0; legacy = localStorage; }
  catch { return 0; }
  if (!await openDb()) return 0;
  const slots: string[] = [];
  for (let i = 0; i < legacy.length; i++) {
    const k = legacy.key(i)!;
    if (k.startsWith(LEGACY_PREFIX) && !k.endsWith('.meta')) slots.push(k.slice(LEGACY_PREFIX.length));
  }
  let n = 0;
  for (const slot of slots) {
    const data = legacy.getItem(LEGACY_PREFIX + slot), metaRaw = legacy.getItem(LEGACY_PREFIX + slot + '.meta');
    if (!data) continue;
    let meta: unknown = null;
    try { meta = metaRaw ? JSON.parse(metaRaw) : null; } catch { /* keep unknown metadata */ }
    try {
      await putSave({ slot, data, meta });
      if (storageMode() !== 'persistent') break;
      legacy.removeItem(LEGACY_PREFIX + slot); legacy.removeItem(LEGACY_PREFIX + slot + '.meta'); n++;
    } catch { /* keep the legacy copy */ }
  }
  return n;
}
