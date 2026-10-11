// Chrome smoke of the pure-web host mode (PRD M2, headless Chrome): /index.html?host=1 boots
// public/dev/host/host.js (in-page Lobby at loopback:solo) then connects net.js over loopback:.
// This is the M2 acceptance path — no Node game server, pure static files + the in-page host.
// SP_E2E=1 CHROME_PATH=/path/to/chrome node --test test/host/host.e2e.test.js
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { readFileSync, statSync, createReadStream, existsSync as fsExists } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENABLED = process.env.SP_E2E === '1' && existsSync(CHROME);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Serve public/ at / (index.html at /), data/ at /data/, shared/ at /shared/, server/sim at /sim/. */
function startStatic() {
  const srv = createServer((req, res) => {
    const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file;
    if (urlPath === '/' || urlPath === '/index.html') file = path.join(ROOT, 'public', 'index.html');
    else if (urlPath.startsWith('/data/')) file = path.join(ROOT, urlPath);
    else if (urlPath.startsWith('/shared/')) file = path.join(ROOT, urlPath);
    else if (urlPath.startsWith('/sim/')) file = path.join(ROOT, 'server', urlPath.slice(1));
    else file = path.join(ROOT, 'public', urlPath);
    if (!file.startsWith(path.join(ROOT))) { res.writeHead(403); res.end(); return; }
    if (!fsExists(file) || !statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    const ext = path.extname(file);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port })));
}

describe('in-page host mode (headless Chrome)', { skip: !ENABLED && 'set SP_E2E=1 (and have Chrome) to run' }, () => {
  let srv, browser;
  before(async () => {
    ({ srv } = await startStatic());
    const puppeteer = (await import('puppeteer-core')).default;
    browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox', '--no-proxy-server'] });
  });
  after(async () => { await browser?.close(); await new Promise((r) => srv?.close(r)); });

  test('?host=1 boots the in-page host and reaches the lobby over loopback:solo', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const logs = [];
    page.on('console', (m) => logs.push(m.text()));
    const base = `http://127.0.0.1:${srv.address().port}`;
    await page.goto(`${base}/index.html?host=1`, { waitUntil: 'networkidle0', timeout: 60000 });

    // The boot splash is replaced by the app root once fonts/identity/lang/host are ready.
    await page.waitForFunction(() => {
      const b = document.getElementById('boot');
      return !b || b.classList.contains('is-done');
    }, { timeout: 60000 });

    // Enter the game shell (title → lobby) and complete the handshake over loopback:solo.
    const online = await page.evaluate(async () => {
      const net = globalThis.__SP__?.net;
      net?.setName?.('M2Probe');
      await new Promise((r) => setTimeout(r, 2000));
      return {
        status: net?.status,
        url: net?.url,
        playerId: net?.playerId,
        ws: net?.ws?.constructor?.name,
      };
    });
    assert.equal(online.status, 'online', `net online over loopback: (status=${online.status}); logs=${logs.slice(-8).join(' | ')}`);
    // `net.url` stays null when the client uses defaultWsUrl(); the transport constructor is the
    // real proof that the page opened LoopbackTransport on loopback:solo (not a ws:// server).
    assert.equal(online.ws, 'LoopbackTransport', 'the transport is LoopbackTransport');
    assert.ok(online.playerId, 'welcome assigned a playerId');

    // A lobby request round-trips through the in-page host (no Node game server):
    // room.create replies ok and pushes room.state so the app store has the new room.
    const store = await page.evaluate(async () => {
      const net = globalThis.__SP__?.net;
      const store = globalThis.__SP__?.store;
      await net.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
      await new Promise((r) => setTimeout(r, 500));
      return {
        room: store?.get()?.room,
        matchPhase: store?.get()?.match?.public?.phase ?? null,
      };
    });
    assert.ok(store.room?.code, `room.create put a room in the store (room=${JSON.stringify(store.room)})`);
    assert.equal(store.room.mode, 'solo', 'the room is a solo room');
    assert.ok(store.room.inMatch === false || store.room.inMatch === undefined || store.room.inMatch === null, 'the room is not in a match yet');
    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join('; ')})`);
  });

  test('a solo room can be built and the match reaches PREP (M3 restore prep)', async (t) => {
    const page = await browser.newPage();
    t.after(() => page.close());
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    const base = `http://127.0.0.1:${srv.address().port}`;
    await page.goto(`${base}/index.html?host=1`, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.waitForFunction(() => {
      const b = document.getElementById('boot');
      return !b || b.classList.contains('is-done');
    }, { timeout: 60000 });

    // IndexedDB is the M3 snapshot store (PRD: solo run kept 24 h). Verify it opens on this origin.
    const idbOk = await page.evaluate(async () => {
      try {
        const name = await new Promise((res, rej) => {
          const q = indexedDB.open('sp-probe', 1);
          q.onsuccess = () => { res(q.result.name); q.result.close(); };
          q.onerror = () => rej(q.error);
        });
        return { ok: true, name };
      } catch (e) { return { ok: false, err: String(e) }; }
    });
    assert.equal(idbOk.ok, true, `IndexedDB opens on the http origin (err=${idbOk.err})`);

    const st = await page.evaluate(async () => {
      const net = globalThis.__SP__?.net;
      net?.setName?.('M3Probe');
      await new Promise((r) => setTimeout(r, 800));
      await net.request('room.create', { mode: 'solo', difficulty: 'FUNNY' });
      await new Promise((r) => setTimeout(r, 500));
      const store = globalThis.__SP__?.store;
      return { code: store?.get()?.room?.code, playerId: net?.playerId, status: net?.status };
    });
    assert.ok(st.code, 'a solo room exists');
    assert.equal(st.status, 'online', 'client is online over loopback');
    assert.deepEqual(errors, [], `no uncaught page errors (${errors.join('; ')})`);
  });
});
