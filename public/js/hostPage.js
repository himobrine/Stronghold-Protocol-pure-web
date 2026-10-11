// public/js/hostPage.js — page-side host boot (PRD M2): load the pre-built host bundle
// (public/dev/host/host.js) and start it on the *page's* loopbackHub singleton
// (shared/transport.js), so net.js's pickTransport() and the in-process host share one hub.
//
// The bundle re-exports its own loopbackHub (a second copy of the class/instance from the page's
// shared/transport.js import). Two hubs = a solo room no client can ever join. startHost in the
// bundle already accepts `{ hub }`, so this thin wrapper always passes the page's hub.
//
// The bundle is a pre-built ES module (tools/build-host.mjs), not source; it is loaded with a
// runtime import() so tools/package.mjs's static import scan never expects host/entry.js and its
// server graph inside the lite release zip (public/dev/ is a pure-web / Pages concern).

import { loopbackHub } from '../../shared/transport.js';

/** Re-exported so the page can open a LoopbackTransport on the same hub. */
export { loopbackHub };

/**
 * Start the in-page host on the page-global loopbackHub.
 * @param {{ key?: string, data?: object, log?: object }} [opts]
 * @returns {Promise<{ network: any, lobby: any, registry: any, data: object, key: string, hub: typeof loopbackHub, detach: () => void }>}
 */
export async function startHost(opts = {}) {
  const bundle = await import('/dev/host/host.js');
  return bundle.startHost({ ...opts, hub: loopbackHub, key: opts.key || 'solo' });
}
