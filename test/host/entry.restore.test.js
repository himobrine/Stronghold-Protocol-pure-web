// test/host/entry.restore.test.js — in-page host snapshot restore end-to-end at the host/entry.js layer (PRD M3):
// boot startHost (fresh) → connect a LoopbackTransport client → create a solo room → drive the match to a PREP
// snapshot → close the host (simulating a page refresh, the snapshot persists in the injected fake IndexedDB) →
// boot startHost again → the room + match are restored from the snapshot without any client re-seeding the match.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../../server/data.js';
import { LoopbackHub, LoopbackTransport } from '../../shared/transport.js';
import { startHost } from '../../host/entry.js';
import { makeFakeIndexedDB } from './fakeIndexedDB.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = loadData(path.join(ROOT, 'data'), { log: { warn() {}, error() {} } });
const QUIET = { info() {}, debug() {}, warn() {}, error() {} };

/** In-memory IndexedDB fake shared across both boots (the "disk" that survives a refresh). */
const fake = makeFakeIndexedDB();

/** A minimal client driving the loopback host over the same protocol net.js speaks. */
function makeClient(hub, key) {
  const ws = new LoopbackTransport(`loopback:${key}`, { hub });
  const inbox = [];
  let nextRid = 1;
  ws.onmessage = (ev) => { try { inbox.push(JSON.parse(ev.data)); } catch { /* ignore non-JSON */ } };
  const open = new Promise((resolve) => { const prev = ws.onopen; ws.onopen = () => { prev?.(); resolve(); }; });
  const request = (t, fields = {}) => {
    const rid = nextRid++;
    ws.send(JSON.stringify({ t, rid, ...fields }));
    return new Promise((resolve) => {
      const deadline = Date.now() + 4000;
      const tick = () => {
        const hit = inbox.find((m) => m.rid === rid);
        if (hit) { resolve(hit); return; }
        if (Date.now() > deadline) { resolve({ error: 'timeout' }); return; }
        setTimeout(tick, 20);
      };
      tick();
    });
  };
  const waitMsg = (pred, ms = 4000) => new Promise((resolve) => {
    const deadline = Date.now() + ms;
    const tick = () => {
      const hit = inbox.find(pred);
      if (hit) { resolve(hit); return; }
      if (Date.now() > deadline) { resolve(null); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
  return { ws, inbox, open, request, waitMsg, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

/** Boot a host on a private hub, connect + hello a client, create a solo room. Returns the wired pieces. */
async function bootAndCreateRoom() {
  const hub = new LoopbackHub();
  const host = await startHost({ hub, key: 'solo', data: DATA, log: QUIET, snapshotStoreDeps: { indexedDB: fake }, snapshotEveryMs: 50 });
  const client = makeClient(hub, 'solo');
  await client.open;
  const hello = await client.request('hello', { name: 'M3' });
  assert.ok(!hello.error, `hello ok (${JSON.stringify(hello)})`);
  const created = await client.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  assert.ok(!created.error, `room.create ok (${JSON.stringify(created)})`);
  return { host, client, hub };
}

test('a solo room started through startHost can be persisted to a snapshot and restored on a fresh boot', async (t) => {
  const { host, client } = await bootAndCreateRoom();
  const room = [...host.lobby.rooms.values()].find((r) => r.mode === 'solo');
  assert.ok(room, 'the solo room exists on the lobby');
  // hand the match a deterministic seed + push it to PREP, the same way a real startMatch would after band/draft
  host.lobby.seedFn = () => 12345;
  const started = await client.request('room.start', {});
  // room.start begins the match; wait for the phase push.
  void started;
  await new Promise((r) => setTimeout(r, 120));
  const before = room.match ? { phase: room.match.phase, round: room.match.round, seed: room.match.seed } : null;
  assert.ok(before && before.seed != null, `a match is running (start=${JSON.stringify(started)} state=${JSON.stringify(before)})`);

  // let the interval persist a snapshot, then shut the host down (the page is about to "refresh")
  await new Promise((r) => setTimeout(r, 120));
  host.close();
  client.close();

  // "refresh": boot a second host on the same hub key + same fake IndexedDB disk. It should restore the room.
  const hub2 = new LoopbackHub();
  const host2 = await startHost({ hub: hub2, key: 'solo', data: DATA, log: QUIET, snapshotStoreDeps: { indexedDB: fake }, snapshotEveryMs: 50 });
  t.after(() => { try { host2.close(); } catch { /* ignore */ } });
  const restored = [...host2.lobby.rooms.values()].find((r) => r.mode === 'solo');
  assert.ok(restored, 'the solo room is restored from the snapshot after a fresh boot');
  assert.ok(restored.match, 'the running match is restored');
  assert.equal(restored.match.phase, before.phase, 'the restored match is in the same phase');
  assert.equal(restored.match.round, before.round, 'the restored match is at the same round');
  assert.equal(restored.match.seed, before.seed, 'the restored match kept the original seed');
});
