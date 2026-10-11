// test/host/reports.test.js — M4: client combat reports (b.progress / b.result) routed through the in-page host.
// The host is the browser twin of the Node server (host/entry.js): a client connecting over LoopbackTransport reaches
// the same Lobby.routeGame → Match.handle → reports.js path the Node host serves over websockets. This suite drives
// that exact browser-host wiring (HostNetwork + Lobby + MatchClass) with a real SimClient simulating the field, and
// checks that an honest report advances the round while an implausible one is rejected by validateClientResult and the
// server takes the field over. The logic under test is shared (PRD M4: the same validation/takeover runs in every host);
// what is new here is that the browser host's transport delivers the reports, which lobby-integration.test.js only
// proves over Node websockets.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadData } from '../../server/data.js';
import { PHASE } from '../../shared/constants.js';
import { LoopbackHub, LoopbackTransport } from '../../shared/transport.js';
import { startHost } from '../../host/entry.js';
import { Match } from '../../server/match/Match.js';
import { FakeBattle } from '../match/fakeBattle.js';
import { SimClient } from '../match/simClient.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DATA = loadData(path.join(ROOT, 'data'), { log: { warn() {}, error() {} } });
const QUIET = { info() {}, debug() {}, warn() {}, error() {} };

// Phase timers scaled down; battles are the scriptable FakeBattle so the test runs fast in real time (the in-page host
// uses a real scheduler, like production). clientCombat is the browser default (Match.envClientCombat: no process.env).
class FastMatch extends Match {
  constructor(o) { super({ ...o, timerScale: 0.02, BattleClass: FakeBattle, clientCombat: true }); }
}

/** A minimal client driving the loopback host over the same protocol net.js speaks (cf. entry.restore.test.js). */
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
      const deadline = Date.now() + 6000;
      const tick = () => {
        const hit = inbox.find((m) => m.rid === rid);
        if (hit) { resolve(hit); return; }
        if (Date.now() > deadline) { resolve({ error: 'timeout' }); return; }
        setTimeout(tick, 20);
      };
      tick();
    });
  };
  const waitMsg = (pred, ms = 8000) => new Promise((resolve) => {
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

/** Boot the in-page host on a private hub, connect + hello a client, create a solo room. */
async function bootHost() {
  FakeBattle.reset();
  FakeBattle.script = () => ({ duration: 1 });
  const hub = new LoopbackHub();
  const host = await startHost({ hub, key: 'solo', data: DATA, log: QUIET, MatchClass: FastMatch, seedFn: () => 69, snapshot: false });
  const client = makeClient(hub, 'solo');
  await client.open;
  const hello = await client.request('hello', { name: 'M4' });
  assert.ok(!hello.error, `hello ok (${JSON.stringify(hello)})`);
  const created = await client.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
  assert.ok(!created.error, `room.create ok (${JSON.stringify(created)})`);
  const room = [...host.lobby.rooms.values()].find((r) => r.mode === 'solo');
  assert.ok(room, 'the solo room exists on the lobby');
  const started = await client.request('room.start', {});
  assert.ok(!started.error, `room.start ok (${JSON.stringify(started)})`);
  const info = await client.waitMsg((m) => m.t === 'm.public' && m.phase === 'INFO_CHECK');
  assert.ok(info, 'INFO_CHECK is reached');
  const readyInfo = await client.request('g.infoReady', {});
  assert.ok(!readyInfo.error, `g.infoReady ok (${JSON.stringify(readyInfo)})`);
  const draft = await client.waitMsg((m) => m.t === 'm.public' && m.phase === 'BAND_DRAFT');
  assert.ok(draft, 'BAND_DRAFT is reached');
  const band = await client.request('g.band', { bandId: 'band_sarkazb' });
  assert.ok(!band.error, `g.band ok (${JSON.stringify(band)})`);
  const prep = await client.waitMsg((m) => m.t === 'm.public' && m.phase === 'PREP' && m.round === 1);
  assert.ok(prep, 'PREP round 1 is reached');
  // a SimClient behind this socket: it simulates every authoritative b.start and reports b.progress / b.result, the
  // same way public/js/battle/runner.js does in the browser
  const sim = new SimClient(hello.playerId, {
    send: (msg) => client.ws.send(JSON.stringify(msg)),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t),
    ds: DATA,
    pace: 'instant',
  });
  const HANDLED = new Set(['b.start', 'b.pool', 'b.end']);
  client.ws.onmessage = (ev) => {
    let msg; try { msg = JSON.parse(ev.data); } catch { return; }
    client.inbox.push(msg);
    if (HANDLED.has(msg.t)) sim.onMessage(msg);
  };
  return { host, client, room, sim, playerId: hello.playerId };
}

/** Buy a cheap chess, place it on a ground tile, and Ready — the field is no longer empty. */
async function placeUnitAndReady(client, playerId) {
  // the first m.private can land before the economy applies (funds 0); wait for the funded prep frame, like
  // lobby-integration.test.js does
  const priv = await client.waitMsg((m) => m.t === 'm.private' && m.playerId === playerId && m.funds === 4 && m.shop?.slots?.length > 0);
  assert.ok(priv, 'the funded private prep view is delivered');
  const slot = priv.shop.slots.findIndex((s) => s && s.kind === 'chess' && s.price <= 4);
  assert.ok(slot >= 0, `an affordable chess is in the shop (funds ${priv.funds})`);
  const bought = await client.request('g.buy', { slot });
  assert.ok(!bought.error, `g.buy ok (${JSON.stringify(bought)})`);
  const after = await client.waitMsg((m) => m.t === 'm.private' && m.hand.some(Boolean));
  const piece = after.hand.find(Boolean);
  assert.ok(piece, 'the bought piece is in the hand');
  const placed = await client.request('g.move', { uid: piece.uid, to: { area: 'board', row: 9, col: 3 } });
  assert.ok(!placed.error, `g.move ok (${JSON.stringify(placed)})`);
  const ready = await client.request('g.ready', { ready: true });
  assert.ok(!ready.error, `g.ready ok (${JSON.stringify(ready)})`);
}

test('an honest browser report over the in-page host is accepted and advances the match to PREP round 2', async () => {
  const { host, client, room, sim, playerId } = await bootHost();
  try {
    await placeUnitAndReady(client, playerId);
    const start = await client.waitMsg((m) => m.t === 'b.start' && m.authoritative, 10000);
    assert.ok(start, 'the client is the authoritative runner of its field');
    assert.equal(start.fieldId, `n:${playerId}`, 'the field is the player\'s own');
    assert.equal(start.spec.kind, 'normal', 'a normal field spec travels the browser host path');
    // the SimClient answers b.start, simulates the spec and reports b.progress / b.result through the transport; the
    // host validates the result and the match leaves COMBAT
    const advance = await client.waitMsg((m) => m.t === 'm.public' && m.phase === 'PREP' && m.round === 2, 20000);
    assert.ok(advance, 'the validated report advances the match to PREP round 2');
    assert.ok(sim.log.some((m) => m.t === 'b.result' && m.battleId === start.battleId), 'the client reported its battle');
    assert.equal(room.match.verifyStats.rejected, 0, 'the honest report passed the host validator');
    assert.equal(room.match.phase, PHASE.PREP, 'the host match sits in PREP after the advance');
  } finally {
    client.close();
    host.close();
  }
});

test('an implausible browser report over the in-page host is rejected and the server takes the field over', async () => {
  const { host, client, room, playerId } = await bootHost();
  try {
    // tamper every outgoing result with impossible bounty coins (fields.js validateClientResult: `coins` beyond the
    // spec's bounty budget) — a structurally valid frame the host's validator must refuse
    const sim = new SimClient(playerId, {
      send: (msg) => client.ws.send(JSON.stringify(msg)),
      setTimeout: (fn, ms) => setTimeout(fn, ms),
      clearTimeout: (t) => clearTimeout(t),
      ds: DATA,
      pace: 'instant',
      tamper: (result) => {
        for (const p of Object.values(result.perPlayer)) p.coins = 999;
        return result;
      },
    });
    client.ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(ev.data); } catch { return; }
      client.inbox.push(msg);
      if (msg.t === 'b.start' || msg.t === 'b.pool' || msg.t === 'b.end') sim.onMessage(msg);
    };
    await placeUnitAndReady(client, playerId);
    const start = await client.waitMsg((m) => m.t === 'b.start' && m.authoritative, 10000);
    assert.ok(start, 'the client is the authoritative runner of its field');
    const takeover = await client.waitMsg((m) => m.t === 'b.end' && m.battleId === start.battleId && m.reason === 'takeover', 10000);
    assert.ok(takeover, 'the client is told the server took the field over');
    assert.ok(room.match.verifyStats.rejected >= 1, 'the forged report was rejected by the host validator');
    const advance = await client.waitMsg((m) => m.t === 'm.public' && m.phase === 'PREP' && m.round === 2, 20000);
    assert.ok(advance, 'after the takeover the match still advances to PREP round 2');
  } finally {
    client.close();
    host.close();
  }
});

after(() => { /* each test closes its own host */ });
