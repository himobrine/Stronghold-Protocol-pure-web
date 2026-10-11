// server/net.js — Node host of the WebSocket session layer (DESIGN §1, §8).
//
// The transport-agnostic logic (sessions, registry, rate limiting, the hello/ping/dispatch
// pipeline, send helpers) lives in server/netCore.js and is shared unchanged with the browser host
// runtime (PRD M2). This module adds the Node-only plumbing on top:
//   * Heartbeat (ws ping/pong every `heartbeatMs`, dead sockets terminated) and hello timeout,
//     driven by two `setInterval` timers the browser host doesn't need.
//   * Client address per connection (`clientAddress`): the socket peer, or — when the peer is a
//     local reverse proxy (loopback / private address, e.g. `cloudflared tunnel --url
//     http://localhost:3000`) — the address it forwards (CF-Connecting-IP, X-Real-IP, rightmost
//     X-Forwarded-For). Its `key` (IPv4 address or IPv6 /64) is what per-network limits count
//     against: concurrent sockets here (`maxConnectionsPerAddr`, checked at upgrade time through
//     `admission`), rooms and running matches in server/lobby.js. Local / LAN peers without a
//     forwarding header (dev machine, tests, LAN party) have no key and are never limited per
//     address.
//   * `Network`, the ws `handleConnection` wiring (`message`/`pong`/`error`/`close` → the shared
//     pipeline) and the upgrade-time `admission` check.
//
// Close codes used by the server (clients should NOT auto-reconnect on 4001):
//   4001 session replaced (the same token connected from another socket/tab)
//   4002 hello timeout
//   1008 abusive flooding (rate-limit drops > abuseDropsPerSec)
//   1001 server shutdown

import { randomHex } from './rand.js';
import { isIP } from 'node:net';
import { send, sendRaw, sendSession, encode, isDroppable, isErrCode, errorMsg, sanitizeName, validRid,
  NET_DEFAULTS, HEAVY_TYPES, CLOSE, Session, SessionRegistry, TokenBucket, Connection, CoreNetwork, noopLog } from './netCore.js';

export { send, sendRaw, sendSession, encode, isDroppable, isErrCode, errorMsg, sanitizeName, validRid,
  NET_DEFAULTS, HEAVY_TYPES, CLOSE, Session, SessionRegistry, TokenBucket, Connection, noopLog };

/** Random 128-bit hex token. */
export const newToken = () => randomHex(16);

// ---------------------------------------------------------------------------------------------------
// Client addresses (per-network limits)
// ---------------------------------------------------------------------------------------------------

/**
 * Canonical textual IP: lowercase, zone id stripped, IPv4-mapped IPv6 (`::ffff:1.2.3.4`) → IPv4.
 * @param {unknown} raw
 * @returns {string} '' when not an IP address
 */
export function normalizeIp(raw) {
  if (typeof raw !== 'string') return '';
  let s = raw.trim().toLowerCase();
  const withPort = /^\[([^\]]+)\](?::\d+)?$/.exec(s) || /^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/.exec(s); // [v6]:port, v4:port
  if (withPort) s = withPort[1];
  const pct = s.indexOf('%');
  if (pct >= 0) s = s.slice(0, pct);
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (mapped) s = mapped[1];
  if (isIP(s) === 6) {
    const g = ipv6Groups(s);
    if (g && g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) s = `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  }
  return isIP(s) ? s : '';
}

/** Expand an IPv6 address into 8 numeric groups (null when malformed). @param {string} ip */
function ipv6Groups(ip) {
  let s = ip;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const o = v4[1].split('.').map(Number);
    s = s.slice(0, -v4[1].length) + ((o[0] << 8) | o[1]).toString(16) + ':' + ((o[2] << 8) | o[3]).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const fill = halves.length === 2 ? 8 - head.length - tail.length : 0;
  const groups = [...head, ...new Array(Math.max(0, fill)).fill('0'), ...tail].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * Loopback or private-network address (RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA / link-local).
 * @param {string} ip normalized
 */
export function isLocalIp(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 127 || a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)
      || (a === 169 && b === 254) || (a === 100 && b >= 64 && b <= 127) || a === 0;
  }
  if (isIP(ip) === 6) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.every((x, i) => (i < 7 ? x === 0 : x <= 1))) return true; // ::1 and ::
    return (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80;
  }
  return false;
}

/**
 * The key per-network limits count against: the IPv4 address, or the /64 prefix of an IPv6 address
 * (one subscriber typically owns a whole /64).
 * @param {string} ip normalized
 */
export function limitKeyOf(ip) {
  if (isIP(ip) !== 6) return ip;
  const g = ipv6Groups(ip);
  return g ? `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64` : ip;
}

/** The client address a trusted local proxy forwards (null when it sent none). */
function forwardedAddress(headers) {
  if (!headers) return null;
  const one = (h) => (Array.isArray(h) ? h[h.length - 1] : h);
  for (const name of ['cf-connecting-ip', 'x-real-ip']) {
    const ip = normalizeIp(one(headers[name]));
    if (ip) return ip;
  }
  const xff = one(headers['x-forwarded-for']);
  if (typeof xff === 'string') {
    // The rightmost entry was appended by the proxy nearest to us; earlier ones are client-controlled.
    const parts = xff.split(',');
    const ip = normalizeIp(parts[parts.length - 1]);
    if (ip) return ip;
  }
  return null;
}

/**
 * Resolve an upgrade request's client address and its per-network limit key.
 * Forwarding headers are honoured from loopback/private peers ('auto'), always (true) or never (false).
 * Local/private peers without a forwarded address get `key: null` (never limited per network).
 * @param {import('node:http').IncomingMessage | undefined} req
 * @param {'auto' | boolean} [trustProxy]
 * @returns {{ ip: string, key: string | null }}
 */
export function clientAddress(req, trustProxy = NET_DEFAULTS.trustProxy) {
  const peer = normalizeIp(req?.socket?.remoteAddress);
  const local = !peer || isLocalIp(peer);
  if (trustProxy === true || (trustProxy !== false && local)) {
    const fwd = forwardedAddress(req?.headers);
    if (fwd) return { ip: fwd, key: isLocalIp(fwd) ? null : limitKeyOf(fwd) };
  }
  if (local) return { ip: peer || '?', key: null };
  return { ip: peer, key: limitKeyOf(peer) };
}

/**
 * Node host of the session pipeline (server/netCore.js CoreNetwork): adds ws upgrade wiring
 * (`handleConnection`), the upgrade-time `admission` check and the heartbeat/sweep timers.
 */
export class Network extends CoreNetwork {
  /**
   * @param {{
   *   registry: SessionRegistry,
   *   handler: { onHello?: Function, onMessage: Function, onDisconnect?: Function, onExpire?: Function, welcomeInfo?: Function, routeGame?: Function },
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   *   options?: Partial<typeof NET_DEFAULTS>,
   * }} opts
   */
  constructor(opts) {
    super(opts);
    this.heartbeatTimer = setInterval(() => this.heartbeat(), this.opts.heartbeatMs);
    this.heartbeatTimer.unref?.();
    const sweepMs = Math.max(20, Math.min(15_000, Math.floor(this.opts.reconnectWindowMs / 4)));
    this.sweepTimer = setInterval(() => this.sweep(), sweepMs);
    this.sweepTimer.unref?.();
  }

  /**
   * Upgrade-time admission check (server/http/websocket.js): null to accept, otherwise the reason to refuse.
   * @param {import('node:http').IncomingMessage} req
   * @returns {null | 'shutdown' | 'full' | 'per-address'}
   */
  admission(req) {
    if (this.closed) return 'shutdown';
    if (this.conns.size >= this.opts.maxConnections) return 'full';
    const { key } = clientAddress(req, this.opts.trustProxy);
    const cap = this.opts.maxConnectionsPerAddr;
    if (key && cap > 0 && (this.connsPerKey.get(key) || 0) >= cap) return 'per-address';
    return null;
  }

  /**
   * Adopt a freshly upgraded ws socket: wire its events to the shared pipeline.
   * @param {import('ws').WebSocket} ws
   * @param {import('node:http').IncomingMessage} [req]
   */
  handleConnection(ws, req) {
    const conn = this.acceptEndpoint(ws, clientAddress(req, this.opts.trustProxy));
    if (!conn) return;
    ws.on('message', (data, isBinary) => {
      try { this.onFrame(conn, data, isBinary); } catch (e) { this.log.error('[net] frame handler crashed', e); }
    });
    ws.on('pong', () => { conn.alive = true; if (conn.session && conn.session.ws === ws) conn.session.lastSeen = this.now(); });
    ws.on('error', (e) => { this.log.debug?.('[net] socket error', e?.code || e?.message); });
    ws.on('close', () => { try { this.onClose(conn); } catch (e) { this.log.error('[net] close handler crashed', e); } });
  }

  /** Ping every socket; terminate the ones that did not answer since the previous heartbeat. */
  heartbeat() {
    const now = this.now();
    for (const conn of this.conns.values()) {
      try {
        if (conn.closing) {
          // Closing handshake never completed within a heartbeat interval → drop the TCP connection.
          if (!conn.alive) conn.ws.terminate();
          conn.alive = false;
          continue;
        }
        if (!conn.session && now - conn.openedAt > this.opts.helloTimeoutMs) {
          conn.close(CLOSE.HELLO_TIMEOUT, 'hello timeout');
          continue;
        }
        if (!conn.alive) { conn.ws.terminate(); continue; }
        conn.alive = false;
        conn.ws.ping();
      } catch (e) {
        this.log.debug?.('[net] heartbeat error', e?.message);
      }
    }
  }

  /**
   * Stop timers and close every socket (graceful: close frame, then terminate after 1 s).
   * @param {number} [code] @param {string} [reason]
   */
  close(code = CLOSE.SHUTDOWN, reason = 'server shutdown') {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeatTimer);
    clearInterval(this.sweepTimer);
    for (const conn of this.conns.values()) {
      conn.close(code, reason);
      const t = setTimeout(() => { try { conn.ws.terminate(); } catch { /* ignore */ } }, 1000);
      t.unref?.();
    }
  }
}
