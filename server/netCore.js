// server/netCore.js — the transport-agnostic session layer (DESIGN §1, §8; extracted for PRD M2).
//
// Everything here runs unchanged on the Node server and inside the browser host runtime: no
// `node:` imports, no ws-specific calls, no timers. What stays in server/net.js is the socket
// plumbing (ws upgrade, ping/pong, clientAddress), the heartbeat/sweep timers and the
// `node:crypto` default RNG. The browser host (public/dev/host/) supplies its own connection
// plumbing around `SessionCore` and its own RNG / timers through the constructors.
//
// Responsibilities shared by both hosts:
//   * Session objects (playerId, secret reconnect token, name, bound socket, connection state)
//     and the SessionRegistry that resolves reconnect tokens and expires sessions after the
//     reconnect window (10 min; the lobby may extend it per session via `session.resumeWindowMs`).
//   * The per-connection pipeline: token-bucket rate limit → JSON decode → schema validation
//     (shared/protocol.js) → `hello`/`ping` → dispatch to the handler → `ok`/`error` echoing `rid`.
//     A second, much smaller bucket (2/s, burst 6) guards resend-heavy intents (HEAVY_TYPES), so
//     one connection cannot turn 40 tiny requests per second into hundreds of KB/s downstream.
//   * Send helpers that never throw, with a backpressure guard: droppable frames (b.snap) are
//     skipped past a small queue threshold; a connection past a hard threshold is terminated
//     (the client reconnects and receives a full state resync).
//
// The handler object (implemented by server/lobby.js) receives:
//   onHello(session, { resumed, repeat })  after `welcome` was sent
//   welcomeInfo() → object (optional)      extra fields of every `welcome` (never one of its own keys)
//   onMessage(session, msg) → { ok: true } | { error: ERR code, detail?: string } | undefined
//   routeGame(session, msg) → same (optional): client-side combat reports `b.progress` / `b.result`
//   onDisconnect(session)                  the connection closed (session kept for the reconnect window)
//   onExpire(session)                      the session was purged (disconnected longer than the window)

import { C2S, validateC2S } from '../shared/protocol.js';
import { ERR, ERR_TEXT, NAME_MAX_LEN, PROTOCOL_VERSION } from '../shared/constants.js';

/** Tunables (all overridable through the Network / SessionRegistry constructors). */
export const NET_DEFAULTS = Object.freeze({
  ratePerSec: 40,               // token bucket refill rate
  rateBurst: 40,                // token bucket capacity
  abuseDropsPerSec: 400,        // rate-limited messages within one second before the connection is closed (1008)
  heartbeatMs: 30_000,          // ping interval; a connection that missed one full interval is terminated
  helloTimeoutMs: 30_000,       // connections that never say hello are closed (4002)
  reconnectWindowMs: 10 * 60_000, // disconnected sessions stay resumable this long
  snapDropBytes: 1 << 20,       // skip b.snap while the send queue exceeds this
  hardBufferBytes: 16 << 20,    // terminate a connection whose send queue exceeds this
  maxConnections: 2000,         // concurrent connections (enforced by the host at accept time)
  maxConnectionsPerAddr: 64,    // connections per client network key (0 = unlimited); see clientAddress
  maxSessions: 20_000,          // registry cap; oldest idle sessions are evicted first
  heavyPerSec: 2,               // refill of the bucket for resend-heavy intents (HEAVY_TYPES)
  heavyBurst: 6,
  trustProxy: 'auto',           // forwarding headers: 'auto' = from loopback/private peers only, true = always, false = never
});

/**
 * Intents that also draw from the per-connection heavy bucket: g.watch (its reply is a large state resend, m.field),
 * room.loadout (a ≤ 160-entry map and ≤ 256 operator settings validated against the game data; the client debounces
 * its edits), room.ownership (a ≤ 160-id list, the same way), room.diy (≤ 8 自选 picks checked against the data, the
 * same way) and room.spectate (taking a spectator seat in a running match resends its state like a watcher's g.watch).
 */
export const HEAVY_TYPES = new Set(['g.watch', 'room.loadout', 'room.ownership', 'room.diy', 'room.spectate']);

/** Close codes (see net.js header). */
export const CLOSE = Object.freeze({ REPLACED: 4001, HELLO_TIMEOUT: 4002, POLICY: 1008, SHUTDOWN: 1001 });

export const WS_OPEN = 1;
const MAX_RID = 2 ** 31;
/** Frames larger than this are not parsed just to echo a rid on a RATE error (CPU guard). */
export const PEEK_RID_MAX_BYTES = 2048;

export const noopLog = { info() {}, warn() {}, error() {}, debug() {} };

/** @param {unknown} rid */
export const validRid = (rid) => Number.isInteger(rid) && rid >= 0 && rid <= MAX_RID;

/**
 * True for a real ERR code (own property; rejects inherited names like "constructor").
 * @param {unknown} code
 * @returns {boolean}
 */
export const isErrCode = (code) => typeof code === 'string' && Object.hasOwn(ERR, code);

/**
 * Build an `error` frame.
 * @param {string} code ERR code
 * @param {unknown} [rid]
 * @param {string} [detail] developer-facing reason
 */
export function errorMsg(code, rid, detail) {
  const known = isErrCode(code);
  const m = { t: 'error', code: known ? code : ERR.INTERNAL, msg: known ? ERR_TEXT[code] || ERR_TEXT.INTERNAL : ERR_TEXT.INTERNAL };
  if (validRid(rid)) m.rid = rid;
  if (detail) m.detail = String(detail).slice(0, 120);
  return m;
}

/**
 * JSON-encode a message; returns null (and never throws) on unserializable input.
 * @param {object} msg
 * @returns {string | null}
 */
export function encode(msg) {
  try {
    const s = JSON.stringify(msg);
    return typeof s === 'string' ? s : null;
  } catch {
    return null;
  }
}

/** True for frames that may be skipped under backpressure (only battle snapshots). */
export const isDroppable = (msg) => !!msg && msg.t === 'b.snap';

/** Best-effort rid extraction for rate-limited frames (so the client's pending request resolves). */
export function peekRid(data, isBinary) {
  if (isBinary || !data || data.length > PEEK_RID_MAX_BYTES) return undefined;
  try {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    const m = JSON.parse(text);
    return m && typeof m === 'object' ? m.rid : undefined;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------------------------------

// Control chars, zero-width & bidi controls, BOM.
const STRIP_RANGES = [[0x00, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfeff, 0xfeff]];
const hexEscape = (n) => '\\u' + n.toString(16).padStart(4, '0');
const STRIP_RE = new RegExp('[' + STRIP_RANGES.map(([a, b]) => (a === b ? hexEscape(a) : `${hexEscape(a)}-${hexEscape(b)}`)).join('') + ']', 'g');
const LONE_SURROGATE_RE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

/**
 * Normalize a nickname: strip control/invisible characters and lone surrogates, collapse whitespace,
 * trim, cap at NAME_MAX_LEN code points. Returns null when nothing printable remains.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function sanitizeName(raw) {
  if (typeof raw !== 'string') return null;
  let s = raw.normalize('NFC').replace(LONE_SURROGATE_RE, '').replace(/\s+/g, ' ').replace(STRIP_RE, '').replace(/ {2,}/g, ' ').trim();
  s = [...s].slice(0, NAME_MAX_LEN).join('').trim();
  return s.length > 0 ? s : null;
}

// ---------------------------------------------------------------------------------------------------
// Session & registry
// ---------------------------------------------------------------------------------------------------

/** One logical player identity; survives socket reconnects for the reconnect window. */
export class Session {
  /**
   * @param {{ playerId: string, token: string, name: string, now?: number }} init
   */
  constructor({ playerId, token, name, now = Date.now() }) {
    /** @type {string} public id, shared with other players */
    this.playerId = playerId;
    /** @type {string} secret 128-bit hex reconnect token (only ever sent to its owner) */
    this.token = token;
    /** @type {string} sanitized nickname */
    this.name = name;
    /** @type {any | null} currently bound socket / transport endpoint (ws on Node, an in-page endpoint in the browser host) */
    this.ws = null;
    /** @type {boolean} */
    this.connected = false;
    /** @type {number | null} local first-welcome stamp of the attached client (optional, not authentication) */
    this.claimAt = null;
    /** @type {number} ms epoch of the last inbound frame / pong */
    this.lastSeen = now;
    /** @type {number | null} ms epoch when the socket was lost (null while connected) */
    this.disconnectedAt = now;
    /** @type {string | null} room code — owned and maintained by server/lobby.js */
    this.roomCode = null;
    /** @type {string | null} pending `room.closed` reason to deliver on the next resume (lobby-owned) */
    this.notice = null;
    /** @type {string[] | null} encoded frames (final m.public + m.result) to deliver on the next resume (lobby-owned) */
    this.pendingResult = null;
    /** @type {number} ms epoch of the last full match resync (lobby-owned; throttles repeated hellos) */
    this.resyncAt = -Infinity;
    /** @type {Record<string, { skill: number, module: string|null }> | null} checked operator loadout (lobby-owned, DESIGN §16) */
    this.loadout = null;
    /** @type {Readonly<Record<string, { potential: number, cultivate: number }>> | null} checked per-operator 潜能 / 练度 (lobby-owned, 0.2.2; room.loadout `ops`) */
    this.ops = null;
    /** @type {readonly string[] | null} checked not-owned chess ids (干员持有, lobby-owned, 0.2.0 补位) */
    this.notOwned = null;
    /** @type {Readonly<Record<string, { charId: string, skillIndex: number, uniEquipId: string|null }>> | null} checked 自选 picks (lobby-owned, 0.2.0 自选编队) */
    this.diy = null;
    /** @type {string} client address of the latest connection (logging) */
    this.addr = '?';
    /** @type {string | null} per-network limit key of the latest connection (null = not limited), see clientAddress */
    this.limitKey = null;
    /**
     * @type {number | null} lobby-owned extension of the reconnect window for this session (ms; null = the registry's
     * window). A solo run keeps its session resumable for the official `singleReconnectTime` (24 h) — see lobby.js.
     */
    this.resumeWindowMs = null;
  }
}

/** Registry of sessions by playerId and by token; purges sessions disconnected longer than the window. */
export class SessionRegistry {
  /**
   * @param {{ reconnectWindowMs?: number, maxSessions?: number, now?: () => number, randomHex?: (n: number) => string }} [opts]
   *   `randomHex(n)` returns n random bytes as lowercase hex; defaults to Node's crypto (the browser
   *   host passes server/rand.js's randomHex, which uses Web Crypto).
   */
  constructor({ reconnectWindowMs = NET_DEFAULTS.reconnectWindowMs, maxSessions = NET_DEFAULTS.maxSessions, now = Date.now, randomHex } = {}) {
    this.reconnectWindowMs = reconnectWindowMs;
    this.maxSessions = maxSessions;
    this.now = now;
    this.randomHex = randomHex || defaultRandomHex;
    /** @type {Map<string, Session>} */ this.byPlayerId = new Map();
    /** @type {Map<string, Session>} */ this.byTokenMap = new Map();
  }

  get size() { return this.byPlayerId.size; }

  /**
   * Create a new session with a fresh playerId and token. Evicts the oldest idle (disconnected, roomless)
   * session when the registry is full. Returns null when full of active sessions.
   * @param {string} name
   * @returns {Session | null}
   */
  create(name) {
    if (this.byPlayerId.size >= this.maxSessions && !this.evictOne()) return null;
    let playerId;
    do playerId = 'p_' + this.randomHex(5); while (this.byPlayerId.has(playerId));
    let token;
    do token = this.randomHex(16); while (this.byTokenMap.has(token));
    const s = new Session({ playerId, token, name, now: this.now() });
    this.byPlayerId.set(playerId, s);
    this.byTokenMap.set(token, s);
    return s;
  }

  /** @param {unknown} token @returns {Session | null} a live (non-expired) session for this token */
  byToken(token) {
    if (typeof token !== 'string' || token.length === 0) return null;
    const s = this.byTokenMap.get(token);
    if (!s) return null;
    if (this.isExpired(s, this.now())) return null;
    return s;
  }

  /** @param {string} playerId @returns {Session | null} */
  byId(playerId) { return this.byPlayerId.get(playerId) || null; }

  /** @param {Session} s */
  remove(s) {
    if (this.byPlayerId.get(s.playerId) === s) this.byPlayerId.delete(s.playerId);
    if (this.byTokenMap.get(s.token) === s) this.byTokenMap.delete(s.token);
  }

  /**
   * The reconnect window of one session: the registry's, or the session's own `resumeWindowMs` when that is longer
   * (the lobby may only extend it, never shorten it).
   * @param {Session} s @returns {number} ms
   */
  windowOf(s) {
    const own = s.resumeWindowMs;
    return typeof own === 'number' && own > this.reconnectWindowMs ? own : this.reconnectWindowMs;
  }

  /** @param {Session} s @param {number} now */
  isExpired(s, now) {
    return !s.connected && s.disconnectedAt != null && now - s.disconnectedAt > this.windowOf(s);
  }

  /**
   * Remove and return every session whose reconnect window has elapsed.
   * @param {number} [now]
   * @returns {Session[]}
   */
  sweep(now = this.now()) {
    const out = [];
    for (const s of this.byPlayerId.values()) if (this.isExpired(s, now)) out.push(s);
    for (const s of out) this.remove(s);
    return out;
  }

  /** Evict the oldest disconnected session that is not in a room. @returns {boolean} */
  evictOne() {
    for (const s of this.byPlayerId.values()) {
      if (!s.connected && !s.roomCode) { this.remove(s); return true; }
    }
    return false;
  }

  /** @returns {IterableIterator<Session>} */
  all() { return this.byPlayerId.values(); }
}

/** Random 128-bit hex token (Node default; the browser host passes its own randomHex). */
const defaultRandomHex = (n) => {
  const bytes = new Uint8Array(n);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
};

// ---------------------------------------------------------------------------------------------------
// Rate limiting
// ---------------------------------------------------------------------------------------------------

/** Classic token bucket: `burst` capacity, refilled continuously at `ratePerSec`. */
export class TokenBucket {
  /** @param {number} ratePerSec @param {number} burst @param {number} now ms */
  constructor(ratePerSec, burst, now) {
    this.rate = ratePerSec / 1000;
    this.burst = burst;
    this.tokens = burst;
    this.at = now;
  }

  /** Consume one token. @param {number} now ms @returns {boolean} false when rate-limited */
  take(now) {
    const dt = Math.max(0, now - this.at);
    this.at = now;
    this.tokens = Math.min(this.burst, this.tokens + dt * this.rate);
    if (this.tokens >= 1) { this.tokens -= 1; return true; }
    return false;
  }
}

// ---------------------------------------------------------------------------------------------------
// Send helpers (never throw)
// ---------------------------------------------------------------------------------------------------

/**
 * Send an already-encoded frame over a WebSocket-shaped endpoint. Skips when the endpoint is not
 * OPEN, when `droppable` and the send queue is congested, and terminates endpoints whose queue
 * exceeds the hard threshold. The endpoint only needs the shared transport contract
 * (shared/transport.js): `readyState`, `send(text)` and preferably `bufferedAmount`; `terminate`
 * (ws) falls back to `close` (browser transport) on overflow.
 * @param {any | null | undefined} ws WebSocket-shaped endpoint
 * @param {string} data
 * @param {{ droppable?: boolean, snapDropBytes?: number, hardBufferBytes?: number }} [opts]
 * @returns {boolean} true when the frame was queued
 */
export function sendRaw(ws, data, { droppable = false, snapDropBytes = NET_DEFAULTS.snapDropBytes, hardBufferBytes = NET_DEFAULTS.hardBufferBytes } = {}) {
  if (!ws || ws.readyState !== WS_OPEN || typeof data !== 'string') return false;
  try {
    const queued = typeof ws.bufferedAmount === 'number' ? ws.bufferedAmount : 0;
    if (queued > hardBufferBytes) {
      if (typeof ws.terminate === 'function') ws.terminate();
      else if (typeof ws.close === 'function') ws.close(CLOSE.POLICY, 'send buffer overflow');
      return false;
    }
    if (droppable && queued > snapDropBytes) return false;
    ws.send(data);
    return true;
  } catch {
    return false;
  }
}

/**
 * Encode and send one message to an endpoint. Never throws.
 * @param {any | null | undefined} ws WebSocket-shaped endpoint
 * @param {object} msg
 * @param {{ snapDropBytes?: number, hardBufferBytes?: number }} [opts]
 * @returns {boolean}
 */
export function send(ws, msg, opts) {
  const data = encode(msg);
  if (data == null) return false;
  return sendRaw(ws, data, { droppable: isDroppable(msg), ...opts });
}

/**
 * Send to a session's current socket (no-op while disconnected). Never throws.
 * @param {Session | null | undefined} session
 * @param {object} msg
 * @param {{ snapDropBytes?: number, hardBufferBytes?: number }} [opts]
 * @returns {boolean}
 */
export function sendSession(session, msg, opts) {
  if (!session || !session.connected) return false;
  return send(session.ws, msg, opts);
}

// ---------------------------------------------------------------------------------------------------
// Connection state + the per-connection pipeline (shared by Node Network and the browser host)
// ---------------------------------------------------------------------------------------------------

/** Per-connection state. `ws` is the WebSocket-shaped endpoint; `ip`/`key` are the client address. */
export class Connection {
  /** @param {any} ws @param {{ ip: string, key: string | null }} addr @param {number} now @param {typeof NET_DEFAULTS} opts */
  constructor(ws, addr, now, opts) {
    this.ws = ws;
    this.ip = addr.ip;
    /** @type {string | null} per-network limit key (see clientAddress) */
    this.key = addr.key;
    this.openedAt = now;
    this.alive = true;
    /** @type {Session | null} */
    this.session = null;
    this.bucket = new TokenBucket(opts.ratePerSec, opts.rateBurst, now);
    this.heavy = new TokenBucket(opts.heavyPerSec, opts.heavyBurst, now);
    this.dropWindowAt = now;
    this.drops = 0;
    /** true once the host initiated the close; frames still in flight are ignored */
    this.closing = false;
  }

  /** Host-initiated close (never throws). Later frames from this connection are ignored. */
  close(code, reason) {
    this.closing = true;
    try { this.ws.close(code, reason); } catch { /* ignore */ }
  }
}

/**
 * The shared owner of live connections: turns frames into validated messages for the handler. It is
 * deliberately free of socket/timer specifics — the Node Network and the browser host each subclass
 * or wrap it to add accept/heartbeat/close plumbing around these pure methods.
 */
export class CoreNetwork {
  /**
   * @param {{
   *   registry: SessionRegistry,
   *   handler: { onHello?: Function, onMessage: Function, onDisconnect?: Function, onExpire?: Function, welcomeInfo?: Function, routeGame?: Function },
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   *   options?: Partial<typeof NET_DEFAULTS>,
   * }} opts
   */
  constructor({ registry, handler, log = noopLog, now = Date.now, options = {} }) {
    this.registry = registry;
    this.handler = handler;
    this.log = log;
    this.now = now;
    this.opts = { ...NET_DEFAULTS, ...options };
    /** @type {Map<any, Connection>} endpoint → connection */
    this.conns = new Map();
    /** @type {Map<string, number>} open connections per client network key */
    this.connsPerKey = new Map();
    this.closed = false;
  }

  /** Number of open connections. */
  get connectionCount() { return this.conns.size; }

  /** Adopt a freshly opened endpoint. The host wires the transport's events to these methods. */
  acceptEndpoint(ws, addr) {
    if (this.closed) { try { ws.close(CLOSE.SHUTDOWN, 'server shutdown'); } catch { /* ignore */ } return null; }
    const conn = new Connection(ws, addr, this.now(), this.opts);
    this.conns.set(ws, conn);
    if (conn.key) this.connsPerKey.set(conn.key, (this.connsPerKey.get(conn.key) || 0) + 1);
    return conn;
  }

  /** @param {Connection} conn @param {object} msg */
  reply(conn, msg) { return send(conn.ws, msg, this.opts); }

  /** @param {Connection} conn @param {string} data @param {boolean} isBinary */
  onFrame(conn, data, isBinary) {
    // A connection we are closing (replaced by another tab, hello timeout, flooding, shutdown) may still have
    // frames in flight; acting on them could e.g. mint an orphan session from a late `hello`.
    if (conn.closing || this.closed) return;
    const now = this.now();
    conn.alive = true;
    if (conn.session && conn.session.ws === conn.ws) conn.session.lastSeen = now;

    if (!conn.bucket.take(now)) {
      if (now - conn.dropWindowAt >= 1000) { conn.dropWindowAt = now; conn.drops = 0; }
      if (++conn.drops > this.opts.abuseDropsPerSec) {
        this.log.warn(`[net] closing flooding connection ${conn.ip}`);
        conn.close(CLOSE.POLICY, 'rate limit');
        return;
      }
      this.reply(conn, errorMsg(ERR.RATE, peekRid(data, isBinary)));
      return;
    }

    if (isBinary) { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'binary frame')); return; }
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : data.toString('utf8')); } catch { this.reply(conn, errorMsg(ERR.BAD_MSG, undefined, 'invalid json')); return; }
    const rid = msg && typeof msg === 'object' ? msg.rid : undefined;
    // Own-property check first: validateC2S alone would accept inherited keys like "constructor".
    if (!msg || typeof msg !== 'object' || Array.isArray(msg) || typeof msg.t !== 'string' || !Object.hasOwn(C2S, msg.t)) {
      const t = msg && typeof msg === 'object' ? String(msg.t).slice(0, 32) : typeof msg;
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `unknown type ${t}`));
      return;
    }
    const reason = validateC2S(msg);
    if (reason) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, reason)); return; }

    if (msg.t === 'ping') {
      const pong = { t: 'pong', c: msg.c, s: now };
      if (validRid(rid)) pong.rid = rid;
      this.reply(conn, pong);
      return;
    }
    if (msg.t === 'hello') { this.onHelloMsg(conn, msg, now); return; }
    if (!conn.session) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'hello required')); return; }
    if (HEAVY_TYPES.has(msg.t) && !conn.heavy.take(now)) { this.reply(conn, errorMsg(ERR.RATE, rid, `${msg.t} too often`)); return; }

    let res;
    try {
      // client-side combat reports (b.progress / b.result, DESIGN §14) belong to the running match like 'g.*' intents:
      // handed to the lobby's match router when the handler has one (server/lobby.js routeGame)
      if (msg.t.startsWith('b.') && typeof this.handler.routeGame === 'function') res = this.handler.routeGame(conn.session, msg);
      else res = this.handler.onMessage(conn.session, msg);
    } catch (e) {
      this.log.error(`[net] handler crashed on ${msg.t}`, e);
      res = { error: ERR.INTERNAL };
    }
    if (res && res.error) {
      // fire-and-forget battle progress (no rid) that reached no running match — the match just ended, the room went
      // back to the lobby — is stale, not a client mistake: never answered (DESIGN §14; a rid-less error frame would
      // surface as an error toast in the browser)
      if (msg.t === 'b.progress' && !validRid(rid)) return;
      this.reply(conn, errorMsg(isErrCode(res.error) ? res.error : ERR.INTERNAL, rid, res.detail));
    } else if (validRid(rid)) this.reply(conn, { t: 'ok', rid });
  }

  /** @param {Connection} conn @param {any} msg @param {number} now */
  onHelloMsg(conn, msg, now) {
    const rid = msg.rid;
    if (msg.version != null && msg.version !== PROTOCOL_VERSION) {
      this.reply(conn, errorMsg(ERR.BAD_MSG, rid, `version mismatch: server ${PROTOCOL_VERSION}`));
      return;
    }
    const name = sanitizeName(msg.name);
    if (!name) { this.reply(conn, errorMsg(ERR.BAD_MSG, rid, 'bad field name')); return; }

    let session = conn.session;
    let resumed = false;
    const repeat = !!session;
    if (!session) {
      session = msg.token ? this.registry.byToken(msg.token) : null;
      if (session) {
        if (session.connected && session.ws && session.ws !== conn.ws
          && (msg.noReplace || (Number.isFinite(msg.claimAt) && session.claimAt != null && msg.claimAt > session.claimAt))) {
          this.reply(conn, errorMsg(ERR.SESSION_IN_USE, rid));
          return;
        }
        resumed = true;
        if (session.ws && session.ws !== conn.ws) this.detachReplaced(session.ws);
      } else {
        session = this.registry.create(name);
        if (!session) { this.reply(conn, errorMsg(ERR.INTERNAL, rid, 'server full')); return; }
      }
      conn.session = session;
      session.ws = conn.ws;
      session.connected = true;
      session.claimAt = Number.isFinite(msg.claimAt) ? msg.claimAt : null;
      session.disconnectedAt = null;
    }
    session.name = name;
    session.lastSeen = now;
    session.addr = conn.ip;
    session.limitKey = conn.key;

    let extra = null;
    try { extra = this.handler.welcomeInfo?.() ?? null; } catch (e) { this.log.error('[net] welcomeInfo crashed', e); }
    const welcome = { ...(extra && typeof extra === 'object' ? extra : null), t: 'welcome', playerId: session.playerId, token: session.token, name: session.name, serverNow: now, version: PROTOCOL_VERSION, resumed };
    if (validRid(rid)) welcome.rid = rid;
    this.reply(conn, welcome);
    try {
      this.handler.onHello?.(session, { resumed, repeat });
    } catch (e) {
      this.log.error('[net] onHello crashed', e);
    }
  }

  /**
   * The session moved to a new endpoint: unbind and close the old one without firing a disconnect.
   * The host overrides this when it needs to look up its own per-socket bookkeeping.
   * @param {any} oldWs
   */
  detachReplaced(oldWs) {
    const old = this.conns.get(oldWs);
    if (old) {
      old.session = null;
      old.close(CLOSE.REPLACED, 'session replaced');
    } else {
      try { oldWs.close(CLOSE.REPLACED, 'session replaced'); } catch { /* ignore */ }
    }
  }

  /** @param {Connection} conn */
  onClose(conn) {
    if (this.conns.delete(conn.ws) && conn.key) {
      const n = (this.connsPerKey.get(conn.key) || 1) - 1;
      if (n > 0) this.connsPerKey.set(conn.key, n);
      else this.connsPerKey.delete(conn.key);
    }
    const s = conn.session;
    conn.session = null;
    if (!s || s.ws !== conn.ws) return;
    s.ws = null;
    s.connected = false;
    s.disconnectedAt = this.now();
    if (this.closed) return;
    try { this.handler.onDisconnect?.(s); } catch (e) { this.log.error('[net] onDisconnect crashed', e); }
  }

  /** Purge expired sessions and tell the handler. */
  sweep() {
    let expired;
    try { expired = this.registry.sweep(this.now()); } catch (e) { this.log.error('[net] sweep crashed', e); return; }
    for (const s of expired) {
      try { this.handler.onExpire?.(s); } catch (e) { this.log.error('[net] onExpire crashed', e); }
    }
  }
}
