// tools/build-host.mjs — bundles the in-page host runtime (PRD M2) for the browser.
//
// The lobby/match/sim graph is written as server ESM (node:crypto, node:fs, `nodeLoader =
// await import('./nodeData.js')`), so it cannot be loaded raw by a page. This tool bundles
// host/entry.js into one ES module, public/dev/host/host.js, rewriting the node-only
// seams as it goes:
//   1. server/sim/nodeData.js — the Node data loader, imported dynamically by simdata.js behind an
//      IS_NODE guard. The guard is enough at run time; esbuild would still try to follow the
//      dynamic import and pull in node:fs, so the file is emptied to a stub.
//   2. server/dataNode.js — the fs loader re-exported by server/data.js (getData/resetData/
//      loadData for the Node host). Replaced with a same-shaped stub so the re-export resolves;
//      a page never reaches those exports (the host installs setDefaultDataProvider, and the
//      match helpers already try/catch the fallback).
//   3. process.env — read bare by server/match/botEmotes.js. Injected as a literal object so the
//      bundle has no `process` global at all.
//   4. __SP_BUNDLE__ — content/index.js, content/bonds.js, content/bands.js and content/kits/index.js
//      load their parts with TLA-relative dynamic imports (`import('./kits/index.js')`), which
//      esbuild leaves as page-relative runtime imports (the parts would 404 next to host.js). The
//      define turns those loads into static import()s that esbuild resolves into the bundle.
//
// server/data.js itself is browser-safe (pure getters over an injected object; no node:fs) and
// bundles as-is, so match/gamedata.js, builtinMeta.js and sim/content/support keep importing it.
//
// The output is an ES module: host.html loads it with <script type="module">, so the import
// rewrites in tools/pages-build.mjs (M1) apply unchanged when Pages copies public/dev/.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const simDir = join(root, 'server', 'sim');

/**
 * esbuild plugin: one module instance per file across every spelling the graph uses, and the
 * node-only seams emptied so the browser never reaches node:fs.
 *
 * Without this the bundle held two copies of the same modules: entry.js was also pulled in
 * through the `sp-sim` namespace (its import of server/sim/simdata.js), so the page got two
 * `loopbackHub` singletons and HostNetwork sat on a hub the client transport never saw. Every
 * repo file — `server/…`, `shared/…`, `../x.js`, `/sim/…` — is resolved to one absolute path in
 * the default `file` namespace; only the node-only seams keep a non-file namespace.
 * @returns {import('esbuild').Plugin}
 */
function hostPlugin() {
  return {
    name: 'host-seams',
    setup(b) {
      // node-only seams first (they would otherwise resolve under their real paths).
      b.onResolve({ filter: /(?:^|\/)(?:dataNode|nodeData)\.js$/ }, (args) => {
        const path = join(args.resolveDir, args.path).replace(/\\/g, '/');
        if (path.endsWith('server/dataNode.js')) return { path: args.path, namespace: 'sp-data-node-stub' };
        if (path.endsWith('server/sim/nodeData.js')) return { path: args.path, namespace: 'sp-stub' };
        return null;
      });
      b.onResolve({ filter: /^node:/ }, (args) => {
        throw new Error(`host bundle: node: import ${args.path} from ${args.importer}`);
      });

      // `/sim/…` is the served read-only copy of server/sim (client imports); map it back so the
      // host and the client-side sim share one file path in the bundle.
      b.onResolve({ filter: /^\/sim\// }, (args) => ({
        path: join(simDir, args.path.slice('/sim/'.length)).replace(/\\/g, '/'),
      }));
      // Relative / bare repo specifiers: resolve here and pin the absolute path (no namespace),
      // so `./x.js`, `../shared/y.js` and `shared/y.js` are one module each.
      b.onResolve({ filter: /^(?:\.|\/|(?:server|shared|public)\b)/ }, (args) => {
        if (args.namespace === 'sp-data-node-stub' || args.namespace === 'sp-stub') return null;
        const abs = resolve(args.resolveDir, args.path).replace(/\\/g, '/');
        if (!abs.endsWith('.js')) return null;
        return { path: abs };
      });

      b.onLoad({ filter: /.*/, namespace: 'sp-data-node-stub' }, () => ({
        contents: `export const ROOT = ''; export const DATA_DIR = ''; export const DATA_FILES = [];
export function loadData() { return {}; }
export function getData() { return {}; }
export function resetData() {}
`,
        loader: 'js',
      }));
      b.onLoad({ filter: /.*/, namespace: 'sp-stub' }, () => ({ contents: 'export {};', loader: 'js' }));
    },
  };
}

/**
 * Bundle the host runtime. Returns the output path.
 * @param {{ out?: string }} [opts]
 * @returns {Promise<string>}
 */
export async function buildHost({ out = join(root, 'public', 'dev', 'host', 'host.js') } = {}) {
  mkdirSync(dirname(out), { recursive: true });
  await build({
    entryPoints: [join(root, 'host', 'entry.js')],
    outfile: out,
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    // Guarded dynamic imports (match/, PlayerState, net) stay as runtime `import()` for a broken
    // kit to degrade alone on the server. With code splitting those become sibling chunks Node
    // cannot evaluate and the page would fetch next to host.js; one file keeps the hub singleton
    // and the Pages layout (public/dev/host/) unchanged.
    splitting: false,
    logLevel: 'warning',
    // server/match/botEmotes.js reads this bare; the bundle must not assume a `process` global.
    define: { 'process.env.SP_BOT_EMOTES': '"1"', __SP_BUNDLE__: 'true' },
    plugins: [hostPlugin()],
  });
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const out = await buildHost();
  const bytes = readFileSync(out).length;
  writeFileSync(out, `// generated by tools/build-host.mjs — do not edit (${(bytes / 1024).toFixed(0)} KiB)\n` + readFileSync(out, 'utf8'));
  console.log(`host bundle: ${out.replace(/\\/g, '/')} (${(bytes / 1024).toFixed(0)} KiB)`);
}
