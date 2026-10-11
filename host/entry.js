// host/entry.js — in-page host runtime (PRD M2): the authoritative game server, in the
// browser. The room/match/sim graph (server/lobby.js, server/netCore.js, server/match/, server/sim/)
// is bundled into public/dev/host/host.js by tools/build-host.mjs; this file is the thin host-side
// shell around it, the browser twin of server/http/websocket.js's createSessionStack.
//
// Where the Node server has server/net.js (ws sockets, ping/pong, clientAddress, admission), the
// browser has transport endpoints: the same WebSocket-shaped contract shared/transport.js defines
// (`readyState`, `onmessage`, `send(text)`, `close(code)`), handed to us by the loopback hub
// (solo — same page) or PeerJS (co-op — another tab / another machine). HostNetwork maps an
// endpoint onto CoreNetwork's frame pipeline; there is no ping/pong to drive (the transports are
// in-page or WebRTC, and the client's own `ping` intents keep `lastSeen` fresh), so the only timer
// is the session sweep.
//
// Two seams the Node host provides for free are wired here:
//   * data — every data/*.json is fetched once, handed to setSimData (server/sim/simdata.js: the
//     sim's default source) and to dataGetters.js (the lobby's getConfig / getMode / lookup
//     default). On Node these are server/data.js getData(); here they are this fetched object.
//   * randomness — session tokens / room codes / match seeds come from server/rand.js, which uses
//     Web Crypto (present in every browser).
//
// The app talks to this host exactly as it talks to a remote server: public/js/net.js connects to
// `loopback:<key>` (or `p2p:<peerId>`) instead of ws(s)://<host>/ws. Nothing above the transport
// changes — the handshake, rooms, matches and reconnection are the same protocol.

import { loopbackHub, LoopbackHub, LoopbackTransport, pickTransport } from '../shared/transport.js';
import { setSimData } from '../server/sim/simdata.js';
import { setDefaultDataProvider } from '../server/dataGetters.js';
import { Lobby } from '../server/lobby.js';
import { CoreNetwork, SessionRegistry, CLOSE } from '../server/netCore.js';
import { randomHex } from '../server/rand.js';

export { loopbackHub, LoopbackHub, LoopbackTransport, pickTransport };

const DATA_FILES = ['config', 'chess', 'bonds', 'garrisons', 'items', 'bands', 'effects', 'choices',
  'enemies', 'factions', 'waves', 'stages', 'bosses', 'tokens', 'assets', 'backups'];

/**
 * Fetch every data/*.json (the server serves the data/ directory at /data/) into one frozen
 * object, the shape server/data.js loadData() and the sim's setSimData() expect.
 * @param {string} [base] data base URL
 * @returns {Promise<Record<string, any>>}
 */
export async function fetchGameData(base = '/data/') {
  /** @type {Record<string, any>} */
  const out = {};
  await Promise.all(DATA_FILES.map(async (key) => {
    try {
      const res = await fetch(`${base}${key}.json`, { cache: 'no-cache' });
      if (res.ok) out[key] = await res.json();
    } catch { /* a missing file is tolerated, like the Node loader */ }
  }));
  return Object.freeze(out);
}

/** Browser host of the session pipeline (server/netCore.js CoreNetwork). */
export class HostNetwork extends CoreNetwork {
  /**
   * @param {{
   *   registry: SessionRegistry,
   *   handler: { onHello?: Function, onMessage: Function, onDisconnect?: Function, onExpire?: Function, welcomeInfo?: Function, routeGame?: Function },
   *   log?: { info: Function, warn: Function, error: Function, debug?: Function },
   *   now?: () => number,
   *   options?: Partial<typeof NET_DEFAULTS>,
   *   timers?: { setInterval: Function, clearInterval: Function },
   * }} opts
   */
  constructor({ timers, ...opts }) {
    super(opts);
    const t = timers || { setInterval: (fn, ms) => setInterval(fn, ms), clearInterval: (id) => clearInterval(id) };
    this.timers = t;
    const sweepMs = Math.max(20, Math.min(15_000, Math.floor(this.opts.reconnectWindowMs / 4)));
    this.sweepTimer = t.setInterval(() => this.sweep(), sweepMs);
  }

  /**
   * Adopt a transport endpoint: wire its events to the shared pipeline. `addr` is the endpoint's
   * peer address ({ ip, key }); in-page endpoints have none (never rate-limited per network).
   * @param {any} ep WebSocket-shaped endpoint (shared/transport.js contract)
   * @param {{ ip?: string, key?: string | null }} [addr]
   */
  handleConnection(ep, addr = { ip: 'in-page', key: null }) {
    const conn = this.acceptEndpoint(ep, addr);
    if (!conn) return;
    ep.onmessage = (ev) => {
      try { this.onFrame(conn, typeof ev?.data === 'string' ? ev.data : String(ev?.data ?? ''), false); }
      catch (e) { this.log.error('[host] frame handler crashed', e); }
    };
    ep.onclose = () => { try { this.onClose(conn); } catch (e) { this.log.error('[host] close handler crashed', e); } };
  }

  /** Stop the sweep timer and close every endpoint. */
  close(code = CLOSE.SHUTDOWN, reason = 'host shutdown') {
    if (this.closed) return;
    this.closed = true;
    this.timers.clearInterval(this.sweepTimer);
    for (const conn of this.conns.values()) conn.close(code, reason);
  }
}

/**
 * Build the in-page host: fetch the game data, inject it, and wire a Lobby to a HostNetwork behind
 * `hub` at `key` (solo: the page-global `loopbackHub` and key "solo"; co-op: a PeerJS-backed hub).
 * @param {{ hub?: LoopbackHub, key?: string, data?: object, log?: object, now?: () => number,
 *           MatchClass?: Function, seedFn?: () => number, options?: object }} [opts]
 * @returns {Promise<{ network: HostNetwork, lobby: Lobby, registry: SessionRegistry, data: object,
 *                     key: string, hub: LoopbackHub, detach: () => void }>}
 */
export async function startHost(opts = {}) {
  const hub = opts.hub || loopbackHub;
  const key = opts.key || 'solo';
  const log = opts.log || console;
  const data = opts.data || await fetchGameData();
  setSimData(data);
  setDefaultDataProvider(() => data);

  const registry = new SessionRegistry({ randomHex });
  const lobby = new Lobby({ registry, log, MatchClass: opts.MatchClass, getData: () => data, seedFn: opts.seedFn, options: opts.options });
  const network = new HostNetwork({ registry, handler: lobby, log, now: opts.now });

  const detach = hub.attach(key, { open: (ep) => network.handleConnection(ep), close: (ep) => { try { ep.close?.(); } catch { /* ignore */ } } });
  return { network, lobby, registry, data, key, hub, detach };
}
