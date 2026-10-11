// test/host/snapshotStore.test.js — IndexedDB persistence of the solo-match snapshot (PRD M3): put/get/delete +
// 24 h expiry. Runs against a minimal in-memory IndexedDB fake injected via `globalThis.indexedDB` so it works in
// Node without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { putSnapshot, getSnapshot, deleteSnapshot, DB_NAME, STORE } from '../../host/snapshotStore.js';
import { makeFakeIndexedDB } from './fakeIndexedDB.js';

const fake = makeFakeIndexedDB();
globalThis.indexedDB = fake;

test('putSnapshot / getSnapshot round-trips a JSON snapshot', async () => {
  const snap = { v: 1, seed: 7, phase: 'PREP', round: 2, capturedAt: Date.now(), rng: { shop: 12345 } };
  await putSnapshot('solo', snap);
  const got = await getSnapshot('solo');
  assert.deepEqual(got, snap, 'snapshot round-trips through the store');
});

test('getSnapshot returns null for a missing key', async () => {
  assert.equal(await getSnapshot('missing-key'), null);
});

test('getSnapshot expires a snapshot older than maxAgeMs and deletes it', async () => {
  const old = { v: 1, seed: 9, capturedAt: Date.now() - 25 * 3600_000 };
  await putSnapshot('old-solo', old);
  const got = await getSnapshot('old-solo', { maxAgeMs: 24 * 3600_000 });
  assert.equal(got, null, 'expired snapshot is not returned');
  assert.equal(fake._stores.has('old-solo'), false, 'expired snapshot is deleted from the store');
});

test('deleteSnapshot removes the row', async () => {
  await putSnapshot('del-solo', { v: 1, capturedAt: Date.now() });
  assert.ok(await getSnapshot('del-solo'));
  await deleteSnapshot('del-solo');
  assert.equal(await getSnapshot('del-solo'), null);
});

test('the fake database name / store match the module constants', () => {
  assert.equal(DB_NAME, 'sp-host');
  assert.equal(STORE, 'snapshots');
});
