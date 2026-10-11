// host/snapshotStore.js — IndexedDB persistence for the solo-match snapshot (PRD M3: solo run kept 24 h, restored
// after a page refresh so the player resumes the exact board / round they left).
//
// This module is transport-agnostic and host-agnostic: it wraps an IndexedDB open() into a tiny async API and works
// in the browser (real IndexedDB) and in Node tests (a fake `indexedDB` injected via `globalThis` or passed in).
// The snapshot itself is the plain JSON `server/match/serialize.js` snapshotMatch() produces — no live closures.

/** IndexedDB database name / version / object store (one store, one row per room key). */
export const DB_NAME = 'sp-host';
export const DB_VERSION = 1;
export const STORE = 'snapshots';

/**
 * Open the snapshot database. Resolves to the IDBDatabase; rejects if IndexedDB is unavailable (private mode,
 * very old browser) so the caller can fall back to "no persistence, match lost on refresh".
 * @param {{ indexedDB?: IDBFactory }} [deps] injected factory (tests); defaults to globalThis.indexedDB
 * @returns {Promise<IDBDatabase>}
 */
export function openSnapshotDb(deps = {}) {
  const factory = deps.indexedDB || globalThis.indexedDB;
  if (!factory) return Promise.reject(new Error('snapshotStore: IndexedDB unavailable'));
  return new Promise((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error || new Error('snapshotStore: open failed'));
  });
}

/** Put one snapshot (JSON-safe object) under `key` (the room's match key, e.g. `solo`). */
export async function putSnapshot(key, snapshot, deps = {}) {
  const db = await openSnapshotDb(deps);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(snapshot, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('snapshotStore: put failed'));
      tx.onabort = () => reject(tx.error || new Error('snapshotStore: put aborted'));
    });
  } finally {
    db.close();
  }
}

/** Get the snapshot stored under `key`, or null when none / expired (`capturedAt` older than `maxAgeMs`). */
export async function getSnapshot(key, { maxAgeMs = 24 * 3600_000, now = Date.now, ...deps } = {}) {
  const db = await openSnapshotDb(deps);
  try {
    const snap = await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error || new Error('snapshotStore: get failed'));
    });
    if (!snap || typeof snap !== 'object') return null;
    if (maxAgeMs > 0 && Number.isFinite(snap.capturedAt) && now() - snap.capturedAt > maxAgeMs) {
      await deleteSnapshot(key, deps);
      return null;
    }
    return snap;
  } finally {
    db.close();
  }
}

/** Delete the snapshot under `key` (no-op when absent). */
export async function deleteSnapshot(key, deps = {}) {
  const db = await openSnapshotDb(deps);
  try {
    await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error || new Error('snapshotStore: delete failed'));
    });
  } finally {
    db.close();
  }
}
