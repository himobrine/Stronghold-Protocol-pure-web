// server/match/serialize.js — PRD M3: capture a running Match to a JSON-safe snapshot and restore it in a fresh
// Match by deterministic replay (same seed + same VirtualScheduler + same human intent log ⇒ same state).
//
// Why replay, not full-object serialization: Match holds non-JSON state everywhere (PlayerState Maps, SharedPool
// entries, EffectDispatcher handlers, RealScheduler wall-clock timers, mulberry32 rng closures). The sim is already
// deterministic and tools/golden.mjs + tools/matchrun.mjs run whole matches under a VirtualScheduler from a bare
// seed, so the cheapest correct restore is: rebuild the Match from its constructor args (seats, seed, data, bans,
// setup …) with a VirtualScheduler, then re-drive every recorded human intent in order until the snapshot point.
//
// Scope: solo rooms first (PRD M3: solo snapshot kept 24 h in IndexedDB; co-op reconnect is already covered by the
// session layer + Match.onDisconnect). The snapshot is only ever taken while the match is mid-prep / mid-phase with
// no in-flight battle the replay would have to reconstruct bit-exactly — the browser host pauses the match before
// snapshotting.

import { createRng, deriveSeed } from '../sim/rng.js';

/** Snapshot format version; a mismatch refuses to restore (never silently restores a foreign layout). */
export const SNAPSHOT_VERSION = 1;

/** The six named rng streams Match creates in its constructor (server/match/Match.js). */
export const RNG_NAMES = Object.freeze(['setup', 'shop', 'waves', 'draft', 'bots', 'meta']);

/**
 * Capture the minimal replay inputs of a live Match. `intents` is the ordered list of human C2S frames the host
 * has fed the match so far (`{ playerId, t, … }`); the host records them as they arrive (server/match/match/intents.js
 * _handle is the single entry point for every human action).
 * @param {import('./Match.js').Match} m
 * @param {Array<{ playerId: string, t: string }>} intents ordered human intents replayed by restoreMatch
 * @returns {object} a JSON-safe snapshot (no timers, no live rng closures)
 */
export function snapshotMatch(m, intents = []) {
  if (!m || typeof m !== 'object' || !m.players) throw new TypeError('snapshotMatch: a live Match is required');
  const rng = {};
  for (const name of RNG_NAMES) {
    const fn = m[`rng${name[0].toUpperCase()}${name.slice(1)}`];
    rng[name] = fn && typeof fn.state === 'function' ? fn.state() >>> 0 : null;
  }
  return {
    v: SNAPSHOT_VERSION,
    roomCode: m.roomCode,
    mode: m.mode,
    difficulty: m.difficulty,
    modeId: m.modeId,
    seed: m.seed >>> 0,
    phase: m.phase,
    round: m.round,
    clientCombat: !!m.clientCombat,
    verify: m.verifyMode,
    battleContent: m.battleContent,
    botRehearsal: m.botRehearsal,
    rng,
    intents: Array.isArray(intents) ? intents.slice() : [],
    seats: [...m.players.values()].map((ps) => ({
      playerId: ps.playerId, seat: ps.seat, name: ps.name, isBot: !!ps.isBot,
      connected: !ps.left && !!ps.connected, left: !!ps.left, alive: !!ps.alive, autoplay: !!ps.autoplay,
      // the checked operator loadout / 潜能 / ownership / DIY picks the PlayerState froze at construction — needed so
      // the replayed Match re-derives the same gd / diy stock / stand-ins (shared/protocol.js checks re-run on restore)
      loadout: ps.loadout && Object.keys(ps.loadout).length ? ps.loadout : null,
      ops: ps.ops && Object.keys(ps.ops).length ? ps.ops : null,
      notOwned: ps.standIns && ps.standIns.length ? [...ps.standIns] : null,
      diy: ps.diy && Object.keys(ps.diy).length ? ps.diy : null,
    })),
    capturedAt: Date.now(),
  };
}

/**
 * Rebuild a Match from a snapshot by replaying its constructor args and its recorded intent log on a
 * VirtualScheduler. Returns the restored match; the caller wires `send`/`broadcast`/`onEnd` to the new host session
 * and resumes normal intent handling.
 * @param {object} snap a snapshotMatch() result (v must equal SNAPSHOT_VERSION)
 * @param {{ data: object, Match: Function, VirtualScheduler: Function, send: Function, broadcast: Function, onEnd: Function, log?: object }} ctx
 * @returns {import('./Match.js').Match}
 */
export function restoreMatch(snap, ctx) {
  if (!snap || typeof snap !== 'object') throw new TypeError('restoreMatch: a snapshot object is required');
  if (snap.v !== SNAPSHOT_VERSION) throw new Error(`restoreMatch: unsupported snapshot version ${snap.v} (want ${SNAPSHOT_VERSION})`);
  if (!ctx || typeof ctx.Match !== 'function' || typeof ctx.VirtualScheduler !== 'function') {
    throw new TypeError('restoreMatch: ctx.Match and ctx.VirtualScheduler are required (pass the imports; keeps this module free of side effects)');
  }
  const { data, Match, VirtualScheduler, send, broadcast, onEnd, log } = ctx;
  const sched = new VirtualScheduler();
  const m = new Match({
    roomCode: snap.roomCode, mode: snap.mode, difficulty: snap.difficulty, modeId: snap.modeId,
    seed: snap.seed, seats: snap.seats, data, log, scheduler: sched,
    battleContent: snap.battleContent, botRehearsal: snap.botRehearsal,
    clientCombat: snap.clientCombat, verify: snap.verify,
    send, broadcast, onEnd,
  });
  // restore the six rng streams to their captured states so the replay draws exactly the values the original match
  // had already consumed (setup / bans / shop rolls already happened before the snapshot)
  for (const name of RNG_NAMES) {
    const key = `rng${name[0].toUpperCase()}${name.slice(1)}`;
    const state = snap.rng ? snap.rng[name] : null;
    if (state != null && m[key] && typeof m[key].state === 'function') {
      const fresh = createRng(deriveSeed(snap.seed, name), state);
      // copy the closure's methods onto the existing slot (Match holds the rng by reference; callers keep working)
      for (const k of Object.keys(fresh)) m[key][k] = fresh[k];
      Object.defineProperty(m[key], 'state', { value: fresh.state, configurable: true });
    }
  }
  m.start();
  // replay the recorded human intents in order; a rejected intent (wrong phase / NOT_IN_ROOM …) is skipped — the
  // original match also refused it, so the replayed state stays aligned
  for (const it of snap.intents || []) {
    if (!it || typeof it.t !== 'string') continue;
    try { m.handle(it.playerId, it); } catch { /* a stale intent is dropped, like the original host would */ }
    sched.runAll();
  }
  sched.runAll();
  return m;
}
