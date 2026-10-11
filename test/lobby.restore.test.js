// test/lobby.restore.test.js — Lobby.restoreFromSnapshot (PRD M3): the browser host wires matchRestore to
// server/match/serialize.js restoreMatch; this exercises the lobby-side room/seat rebuild + wiring without a browser.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lobby } from '../server/lobby.js';
import { SessionRegistry } from '../server/netCore.js';
import { Match } from '../server/match/Match.js';
import { VirtualScheduler } from '../server/match/scheduler.js';
import { snapshotMatch, restoreMatch } from '../server/match/serialize.js';
import { getData } from '../server/data.js';
import { FakeBattle } from './match/fakeBattle.js';

const DATA = getData({ log: { warn() {}, error() {}, info() {} } });
const QUIET = { info() {}, debug() {}, warn() {}, error() {} };

function makeLobby(overrides = {}) {
  const registry = new SessionRegistry({ randomHex: () => 'a'.repeat(32) });
  return { registry, lobby: new Lobby({ registry, log: QUIET, getData: () => DATA, ...overrides }) };
}

function soloSnap() {
  const sched = new VirtualScheduler({ instantCombat: true });
  const intents = [];
  const m = new Match({
    roomCode: 'RSTR', mode: 'solo', difficulty: 'FUNNY',
    seats: [{ seat: 0, playerId: 'p_0', name: 'P0', isBot: false, connected: true }],
    seed: 5, data: DATA, log: QUIET, scheduler: sched, BattleClass: FakeBattle, botRehearsal: 0,
    send: () => true, broadcast: () => {}, onEnd: () => {},
  });
  const orig = m.handle.bind(m);
  m.handle = (pid, msg) => { if (msg && typeof msg.t === 'string') intents.push({ playerId: pid, t: msg.t, ...msg }); return orig(pid, msg); };
  m.start();
  for (let i = 0; i < 1e5 && !(m.phase === 'PREP' && m.round === 1); i++) {
    for (const ps of m.players.values()) {
      if (ps.isBot) continue;
      if (m.phase === 'INFO_CHECK' && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
      else if (m.phase === 'BAND_DRAFT' && !ps.bandId) m.handle(ps.playerId, { t: 'g.band', bandId: 'band_bldsk' });
      else if (m.phase === 'SP_DRAFT' && !ps.ready) m.handle(ps.playerId, { t: 'g.ready', ready: true });
      else if (m.phase === 'PREP' && !ps.ready) m.handle(ps.playerId, { t: 'g.ready', ready: true });
    }
    sched.runAll();
    if (m.ended) break;
  }
  assert.equal(m.phase, 'PREP');
  const snap = snapshotMatch(m, intents);
  m.dispose();
  return snap;
}

test('restoreFromSnapshot rebuilds a solo room + running match when matchRestore is wired', () => {
  const snap = soloSnap();
  const { lobby } = makeLobby({
    matchRestore: (s, wiring) => restoreMatch(s, { data: DATA, Match, VirtualScheduler, send: wiring.send, broadcast: wiring.broadcast, onEnd: wiring.onEnd, log: QUIET }),
  });
  const room = lobby.restoreFromSnapshot(snap);
  assert.ok(room, 'a room is restored');
  assert.equal(room.code, snap.roomCode);
  assert.equal(room.mode, 'solo');
  assert.ok(room.match, 'a running match is attached');
  assert.equal(room.match.phase, 'PREP');
  assert.equal(room.match.round, 1);
  const seat = room.seatOf('p_0');
  assert.ok(seat, 'the human seat is rebuilt');
  assert.equal(seat.isBot, false);
  assert.equal(room.hostId, 'p_0');
});

test('restoreFromSnapshot returns null without a restore hook (the Node server never restores)', () => {
  const snap = soloSnap();
  const { lobby } = makeLobby();
  assert.equal(lobby.restoreFromSnapshot(snap), null);
});

test('restoreFromSnapshot refuses a non-solo snapshot and an already-occupied code', () => {
  const snap = { ...soloSnap(), mode: 'coop' };
  const { lobby } = makeLobby({ matchRestore: () => ({}) });
  assert.equal(lobby.restoreFromSnapshot(snap), null, 'coop snapshots never restore');
  const solo = soloSnap();
  assert.ok(lobby.restoreFromSnapshot(solo), 'first restore succeeds');
  assert.equal(lobby.restoreFromSnapshot(solo), null, 'a second restore of the same code is refused');
});

test('a restored room accepts new intents routed through routeGame (host resumes play)', async () => {
  const snap0 = soloSnap();
  const seen = [];
  const { registry, lobby } = makeLobby({
    matchRestore: (s, wiring) => restoreMatch(s, { data: DATA, Match, VirtualScheduler, send: wiring.send, broadcast: wiring.broadcast, onEnd: wiring.onEnd, log: QUIET }),
    onMatchIntent: (pid, msg) => seen.push(`${pid}:${msg.t}`),
  });
  // a fresh session stands in for the returning player (real browsers reuse the reconnect token → same playerId);
  // remap the snapshot's seat to this session's id so routeGame resolves it
  const session = registry.create('P0');
  const snap = { ...snap0, session: { playerId: session.playerId, token: session.token, name: 'P0' }, seats: snap0.seats.map((s) => (s && !s.isBot ? { ...s, playerId: session.playerId } : s)), intents: (snap0.intents || []).map((it) => ({ ...it, playerId: session.playerId })) };
  const room = lobby.restoreFromSnapshot(snap);
  assert.ok(room);
  session.roomCode = room.code;
  const res = lobby.routeGame(session, { t: 'g.ready', ready: true });
  assert.ok(res && res.ok === true, 'routeGame accepts the fresh intent');
  assert.ok(seen.includes(`${session.playerId}:g.ready`), 'onMatchIntent tapped the fresh intent');
});

test('restoreFromSnapshot recreates the human session so the client token resolves back (PRD M3 refresh)', () => {
  const snap = { ...soloSnap(), session: { playerId: 'p_restore', token: 'tok_restore_1234567890abcdef', name: 'Returning' } };
  const { registry, lobby } = makeLobby({
    matchRestore: (s, wiring) => restoreMatch(s, { data: DATA, Match, VirtualScheduler, send: wiring.send, broadcast: wiring.broadcast, onEnd: wiring.onEnd, log: QUIET }),
  });
  const room = lobby.restoreFromSnapshot(snap);
  assert.ok(room, 'the room is restored');
  const restoredSession = registry.byToken('tok_restore_1234567890abcdef');
  assert.ok(restoredSession, 'the stored token resolves to a session after restore');
  assert.equal(restoredSession.playerId, 'p_restore', 'the restored session has the original playerId');
  assert.equal(restoredSession.roomCode, room.code, 'the restored session points at the restored room');
});
