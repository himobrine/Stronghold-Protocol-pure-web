// test/host/fakeIndexedDB.js — a minimal in-memory IndexedDB fake for Node tests that exercise host/snapshotStore.js
// (or anything else that opens the snapshot DB) without a browser. One object store, put/get/delete, enough for the
// transaction surface snapshotStore uses. Share one instance across a "refresh" to model the disk surviving a reload.
export function makeFakeIndexedDB() {
  const stores = new Map(); // key → value
  const db = {
    objectStoreNames: { contains: () => true },
    createObjectStore: () => {},
    transaction: (name, mode) => {
      const tx = {
        oncomplete: null, onerror: null, onabort: null,
        error: null,
        objectStore: () => ({
          put: (v, k) => { stores.set(k, v); queueMicrotask(() => tx.oncomplete?.()); },
          get: (k) => { const req = { onsuccess: null, onerror: null, result: stores.get(k) ?? undefined }; queueMicrotask(() => req.onsuccess?.()); return req; },
          delete: (k) => { stores.delete(k); queueMicrotask(() => tx.oncomplete?.()); },
        }),
      };
      void mode;
      return tx;
    },
    close: () => {},
  };
  return {
    open: () => { const req = { onupgradeneeded: null, onsuccess: null, onerror: null, result: db }; queueMicrotask(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }); return req; },
    _stores: stores,
  };
}
